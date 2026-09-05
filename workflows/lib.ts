/**
 * workflow 共享编排件（fish 09-05 架构设想 #3：workflow = 编排件的组装，LLM 可编写）。
 *
 * 四个编排件覆盖最简 run 全流程：
 *   runInit        —— onboard→research 同会话串行 → compact → mark("init")（init-session）
 *   runHuntRounds  —— 分支往返多轮 hunt（每轮 goto 回起点带摘要）
 *   runHypChain    —— 单条 HYP 的 verify→poc→ev 同会话链（从 verify-start 标记 fork）
 *   runExpBuild    —— exp-build 收尾（fork 自 init，带全部上下文）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "../extensions/runner/pools.ts";
import { startSession, buildPrompt, type SessionHandle, type SessionCtx } from "../extensions/runner/session.ts";
import { loadState, saveState, readSandboxState } from "../extensions/runner/state.ts";
import { pending, toTodo, toDone, backToLeads } from "../extensions/runner/queue.ts";
import { loadScope, getCoveragePaths, loadCoverageMap, aggregateCoverageEvents, perScopeStats } from "../extensions/code-coverage/coverage-core.ts";

export interface LibCtx extends SessionCtx {
  report(message: string): void;
}

// ---------------------------------------------------------------------------
// runInit：onboard→research 同会话串行 → compact → mark("init")
// ---------------------------------------------------------------------------

export async function runInit(ctx: LibCtx): Promise<SessionHandle | null> {
  const st = loadState(ctx.workdir);
  const initFile = st.init_session_file;
  if (st.onboard_done && st.research_done && initFile && existsSync(initFile)) {
    ctx.report("init-session 已存在（复活）");
    return startSession(ctx, { agent: "init-host", id: "init", sessionFile: initFile, binding: { advId: "ADV-C0-A1", runNo: st.counters.research_run || 1 } });
  }

  ctx.report("初始化：onboard→research 同会话启动");
  const s = await startSession(ctx, { agent: "init-host", id: "init", binding: { advId: "ADV-C0-A1", runNo: st.counters.research_run + 1 } });

  let r = await s.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"));
  if (r.aborted) { ctx.report("onboard 异常中止（API 不可用），workflow 退出"); s.close(); return null; }
  st.onboard_done = true; saveState(ctx.workdir, st);
  ctx.report("onboard 完成，同会话继续 research");

  st.counters.research_run++; saveState(ctx.workdir, st);
  // 同会话续跑：research 任务书作为 user prompt 主体（任务目标由 user prompt 保障，fish #8）
  r = await s.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径。"));
  if (r.aborted) { ctx.report("research 异常中止（API 不可用），workflow 退出"); s.close(); return null; }
  st.research_done = true; saveState(ctx.workdir, st);

  await s.compact("保留：项目画像与威胁模型要点、关键代码区域与行号、漏洞认可口径、检索到的情报结论。丢弃：过程性输出与重复细节。");
  s.mark("init");
  st.init_session_file = s.sessionFile();
  saveState(ctx.workdir, st);
  ctx.report("init-session 就绪（已压缩+标记 init）");
  return s;
}

// ---------------------------------------------------------------------------
// runHuntRounds：分支往返多轮 hunt
// ---------------------------------------------------------------------------

export interface HuntRoundsOpts {
  /** 最大轮数；默认按有效代码行数推断（<1 万行=3，1-5 万=5，更大=8） */
  maxRounds?: number;
  /** 一轮零新 HYP 即停（默认 true） */
  stopOnZeroHyp?: boolean;
  /** 覆盖达标即停（有 scope 时，默认 true） */
  stopOnCoverage?: boolean;
}

/** 按有效代码行数推断 hunt 轮数上限（fish 09-04 裁定：行数+产出双信号） */
export function inferMaxRounds(cwd: string): number {
  const CODE_EXT = /\.(c|h|cc|cpp|rs|go|py|js|ts|java|rb|lua|zig|m|mm)$/i;
  const SKIP = new Set([".git", ".vulnforge", "node_modules", "build", "dist", "test", "tests"]);
  const walk = (p: string): number => {
    try {
      const st = statSync(p);
      if (st.isFile()) return CODE_EXT.test(p) ? readFileSync(p, "utf-8").split("\n").length : 0;
      let n = 0;
      for (const f of readdirSync(p)) {
        if (SKIP.has(f)) continue;
        n += walk(join(p, f));
      }
      return n;
    } catch { return 0; }
  };
  const lines = walk(cwd);
  if (lines < 10_000) return 3;
  if (lines < 50_000) return 5;
  return 8;
}

function coverageMet(ctx: LibCtx): boolean | null {
  const scope = loadScope(ctx.workdir);
  if (!scope) return null;
  const cov = getCoveragePaths(ctx.workdir);
  const map = loadCoverageMap(cov.jsonPath, ctx.cwd, ctx.workdir);
  aggregateCoverageEvents(cov.jsonlPath, map);
  return perScopeStats(map, scope).every((s) => s.pass);
}

function countHyps(workdir: string): number {
  const n = (d: string) => { try { return readdirSync(join(workdir, d)).filter((f) => f.startsWith("HYP-")).length; } catch { return 0; } };
  return n("leads") + n("todo") + n("done");
}

export async function runHuntRounds(ctx: LibCtx, init: SessionHandle, opts: HuntRoundsOpts = {}): Promise<boolean> {
  const maxRounds = opts.maxRounds ?? inferMaxRounds(ctx.cwd);
  const stopOnZero = opts.stopOnZeroHyp ?? true;
  const stopOnCov = opts.stopOnCoverage ?? true;

  init.mark("hunt-start");
  init.setCoverage(true);   // hunt 轮次期间记录覆盖率（口径=hunt 精读）
  for (let round = 1; round <= maxRounds; round++) {
    if (stopOnCov && coverageMet(ctx) === true) { ctx.report("覆盖达标，hunt 停轮"); break; }
    const before = countHyps(ctx.workdir);
    const angle = round === 1
      ? "系统性通读全部有效代码，沿真实数据流挖掘风险假设。"
      : (["换角度：跨函数状态组合与连接/会话状态机。",
          "换角度：平台与构建形态差异（32 位 off_t、NDEBUG、各平台 sendfile、非 glibc libc）。",
          "换角度：错误路径、清理路径、日志与审计盲区。",
          "换角度：输入解析的字节级语义与边界条件。"] as const)[Math.min(round - 2, 3)];
    ctx.report(`hunt 第 ${round}/${maxRounds} 轮`);
    const r = await init.prompt(buildPrompt(ctx, "hunt", `hunt 任务第 ${round} 轮。${angle} 尽可能挖掘风险假设（HYP）；与已有 HYP 重复的不提，确认没有新东西就明说。`));
    if (r.aborted) { ctx.report("API 不可用，workflow 中止。"); return false; }
    // 分支往返：回到起点，本轮摘要留在会话里（下一轮继承，保持连续性）
    await init.goto("hunt-start", {
      summarize: true,
      summaryLabel: `hunt-r${round}`,
      customInstructions: "只保留本轮新提出的 HYP 标题+一句话主张+关键锚点行号，以及读过的代码区域清单；丢弃推演过程。",
    });
    const produced = countHyps(ctx.workdir) - before;
    ctx.report(`hunt 第 ${round} 轮结束：新增 ${produced} 条 HYP`);
    if (stopOnZero && produced === 0) { ctx.report("本轮零新增，hunt 停轮"); break; }
  }
  init.setCoverage(false);
  init.mark("verify-start");
  return true;
}

// ---------------------------------------------------------------------------
// runHypChain：单条 HYP 的 verify→poc→ev 同会话链
// ---------------------------------------------------------------------------

export interface HypChainOpts {
  /** 是否启动动态环节（poc-verify/ev-assess）；默认按 sandbox_cfg 有无 */
  dynamic?: boolean;
  verifyPool: Pool;
  sandboxPool: Pool;
}

/** fork 互斥：并发链从同一 init 会话分叉时串行化（goto+fork 是树操作，很快） */
let forkLock: Promise<void> = Promise.resolve();

export async function runHypChain(ctx: LibCtx, init: SessionHandle, hypFile: string, opts: HypChainOpts): Promise<void> {
  const hypId = hypFile.replace(/\.md$/, "");
  const dynamic = opts.dynamic ?? !!ctx.params.sandbox_cfg;
  const bugDir = join(ctx.workdir, "findings", hypId.replace(/^HYP-/, "BUG-"));
  toTodo(ctx.workdir, hypFile);

  const task = async () => {
   try {
    // 从 verify-start 标记 fork 出该 HYP 的独立会话（继承 hunt 各轮摘要）
    const unlock = await lockFork();
    let chain: SessionHandle;
    try {
      await init.goto("verify-start");
      chain = await init.fork(`chain-${hypId}`, "hyp-chain", { hypId });
    } finally { unlock(); }
    try {
      const r = await chain.prompt(buildPrompt(ctx, "verify", "verify 任务，研判风险假设的成立性。", `风险假设：todo/${hypFile}`));
      if (r.aborted) { ctx.report(`${hypId}：API 不可用，链中止`); backToLeads(ctx.workdir, hypFile); return; }
      if (!existsSync(bugDir)) { ctx.report(`裁决：${hypId} → refuted`); toDone(ctx.workdir, hypFile); return; }
      ctx.report(`裁决：${hypId} → confirmed（finding 已产出）`);

      if (dynamic && readSandboxState(ctx.workdir) === "available") {
        await opts.sandboxPool.run(async () => {
          const target = `findings/${hypId.replace(/^HYP-/, "BUG-")}/report.yaml`;
          const r2 = await chain.prompt(buildPrompt(ctx, "poc-verify", "poc-verify 任务，在沙箱中复现 finding。", `目标 finding：${target}`));
          if (r2.aborted) { ctx.report(`${hypId}：poc-verify API 中止`); return; }
          const rp = join(bugDir, "report.yaml");
          const txt = existsSync(rp) ? readFileSync(rp, "utf-8") : "";
          if (/poc_status:\s*reproduced/.test(txt) && /exp_status:\s*pending/.test(txt)) {
            const r3 = await chain.prompt(buildPrompt(ctx, "ev-assess", "ev-assess 任务，评估 finding 在真实业务场景下的影响。", `目标 finding：${target}`));
            if (r3.aborted) ctx.report(`${hypId}：ev-assess API 中止`);
          }
        });
      }
      toDone(ctx.workdir, hypFile);
    } finally {
      chain.close();
    }
   } catch (e) {
    ctx.report(`${hypId} 链执行异常：${String(e).slice(0, 200)}`);
    try { backToLeads(ctx.workdir, hypFile); } catch { /* 无碍 */ }
   }
  };

  await opts.verifyPool.run(task);
}

function lockFork(): Promise<() => void> {
  return new Promise((resolve) => {
    forkLock = forkLock.then(() => new Promise<void>((r) => resolve(() => r())));
  });
}

// ---------------------------------------------------------------------------
// runExpBuild：收尾（fork 自 init；无新 exploits 即停）
// ---------------------------------------------------------------------------

export async function runExpBuild(ctx: LibCtx, init: SessionHandle): Promise<void> {
  const findingsDir = join(ctx.workdir, "findings");
  if (!existsSync(findingsDir)) { ctx.report("无 findings，跳过 exp-build"); return; }
  let vulns = 0;
  for (const d of readdirSync(findingsDir)) {
    const rp = join(findingsDir, d, "report.yaml");
    if (existsSync(rp) && /finding_class:\s*vulnerability/.test(readFileSync(rp, "utf-8"))) vulns++;
  }
  if (vulns < 2) { ctx.report(`组合信号不足（vulnerability：${vulns}），跳过 exp-build`); return; }
  for (;;) {
    const exploitsDir = join(ctx.workdir, "exploits");
    const cnt = () => { try { return readdirSync(exploitsDir).filter((d) => d.startsWith("EXP-")).length; } catch { return 0; } };
    const before = cnt();
    ctx.report("exp-build 启动");
    await init.goto("init");
    const s = await init.fork(`exp-build-${Date.now()}`, "exp-build");
    const r = await s.prompt(buildPrompt(ctx, "exp-build", "exp-build 任务，探索并构造漏洞组合。"));
    s.close();
    if (r.aborted || cnt() <= before) { ctx.report("exp-build 停止"); return; }
  }
}
