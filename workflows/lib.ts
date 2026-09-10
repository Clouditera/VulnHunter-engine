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
    return startSession(ctx, { agent: "init-host", id: "init", sessionFile: initFile, binding: { advId: "ADV-C0-A1", runNo: st.counters.research_run || 1, advLine: "S" } });
  }

  ctx.report("初始化：onboard→build→research 同会话三段");
  const s = await startSession(ctx, { agent: "init-host", id: "init", binding: { advId: "ADV-C0-A1", runNo: st.counters.research_run + 1, advLine: "S" } });
  const advCount = () => { try { return readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith("ADV-")).length; } catch { return 0; } };

  let r = await s.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"),
    { start: "onboard-start[∅]", done: "onboard-done[on][+profiler]" });
  if (r.aborted) { ctx.report("onboard 异常中止（API 不可用），workflow 退出"); s.close(); return null; }
  st.onboard_done = true; saveState(ctx.workdir, st);

  // build（fish 09-08 从 onboard 分离）：理解构建/部署
  r = await s.prompt(buildPrompt(ctx, "build", "build 任务，理解项目的构建与部署方式并落 build-state。"),
    { start: "build-start[on]", done: "build-done[on,bu][+build-state]" });
  if (r.aborted) { ctx.report("build 异常中止（API 不可用），workflow 退出"); s.close(); return null; }
  st.build_done = true; saveState(ctx.workdir, st);

  if (ctx.params.no_research === "1") {
    ctx.report("research 关闭（no_research=1）");
  } else {
    st.counters.research_run++; saveState(ctx.workdir, st);
    const advBefore = advCount();
    r = await s.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径。"),
      { start: "research-start[on,bu]" });
    if (r.aborted) { ctx.report("research 异常中止（API 不可用），workflow 退出"); s.close(); return null; }
    s.mark(`research-done[on,bu,re][+ADV×${advCount() - advBefore},wiki]`);
    st.research_done = true; saveState(ctx.workdir, st);
  }

  // 压缩跳转：回到 onboard-start 锚点，三段压成摘要；init 标记落在摘要处（fish 09-09 定稿形态）
  await s.goto("onboard-start[∅]", {
    summarize: true,
    summaryLabel: "init[Σ(on,bu,re)]",
    customInstructions: "保留：项目画像与威胁模型要点、构建部署要点、关键代码区域与行号、漏洞认可口径、检索到的情报结论。丢弃：过程性输出与重复细节。摘要正文控制在 4000 字以内。",
  });
  st.init_session_file = s.sessionFile();
  saveState(ctx.workdir, st);
  ctx.report("init-session 就绪（压缩跳转完成，标记 init[Σ(on,bu,re)]）");
  return s;
}

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
  /** fork 点标记（默认 verify-start 旧形态；轻量版传出生轮 huntN-done 前缀匹配） */
  forkPoint?: string;
  /** 链会话启动成分描述（如 Σ(init,h1,h2)）；缺省 Σ(init) */
  birthIngredients?: string;
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
    const forkAt = opts.forkPoint ?? "verify-start";
    const hypShort = hypId.replace(/^HYP-/, "");           // hunt1-H2
    const roundShort = (forkAt.match(/hunt(\d+)/) ? `h${forkAt.match(/hunt(\d+)/)![1]}` : undefined) ?? "verify-start";
    try {
      await init.goto(forkAt);   // 精确标记匹配（huntN-done 标记全名带成分表，goto 用前缀查）
      chain = await init.fork(`init/${roundShort}/chain-${hypId}`, "hyp-chain", { hypId });
    } finally { unlock(); }
    try {
      // 启动 compact（fish 09-09：HYP 的初始会话启动时执行）
      try { await chain.compact("保留：当前研判 HYP 的主张/锚点/相关代码细节与推理、项目画像与构建要点；丢弃无关过程。"); }
      catch (e) { ctx.report(`${hypId} 启动 compact 跳过（${String(e).includes("too small") ? "上下文过小" : String(e).slice(0, 60)}）`); }
      const ing = opts.birthIngredients ?? "Σ(init)";
      // 有沙箱 → dynamic-verify（研判+复现合并）；无沙箱 → static-verify（纯静态裁决，fish 09-10）
      const dynamicMode = opts.dynamic ?? !!ctx.params.sandbox_cfg;
      const stageCode = dynamicMode ? "dv" : "sv";
      const book = dynamicMode ? "dynamic-verify" : "static-verify";
      const r = await chain.prompt(buildPrompt(ctx, book, `${book} 任务，研判风险假设的成立性。`, `风险假设：${ctx.workdir}/todo/${hypFile}`),
        { start: `${stageCode}(${hypShort})-start[${ing}]` });
      if (r.aborted) { ctx.report(`${hypId}：API 不可用，链中止`); backToLeads(ctx.workdir, hypFile); return; }
      if (!existsSync(bugDir)) {
        chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+refuted]`);
        ctx.report(`裁决：${hypId} → refuted`); toDone(ctx.workdir, hypFile); return;
      }
      chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+BUG-${hypShort}·confirmed]`);
      ctx.report(`裁决：${hypId} → confirmed（finding 已产出）`);

      if (dynamicMode && readSandboxState(ctx.workdir) === "available") {
        await opts.sandboxPool.run(async () => {
          const target = `findings/${hypId.replace(/^HYP-/, "BUG-")}/report.yaml`;
          // dynamic-verify 已含复现；这里只判 ev 门槛（poc reproduced 且 exp pending）后接 ev-assess
          const rp = join(bugDir, "report.yaml");
          const txt = existsSync(rp) ? readFileSync(rp, "utf-8") : "";
          if (/poc_status:\s*reproduced/.test(txt) && /exp_status:\s*pending/.test(txt)) {
            const r3 = await chain.prompt(buildPrompt(ctx, "ev-assess", "ev-assess 任务，评估 finding 在真实业务场景下的影响。", `目标 finding：${target}`),
              { start: `ev(${hypShort})-start[${ing},${stageCode}(${hypShort}),finding]` });
            if (!r3.aborted) chain.mark(`ev(${hypShort})-done[Σ,${stageCode}(${hypShort}),ev(${hypShort})][+EV 已评]`);
            else ctx.report(`${hypId}：ev-assess API 中止`);
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

// ---------------------------------------------------------------------------
// runBuildExecute：按需实际构建/部署（fork 自 init，带画像与构建理解上下文）
// 触发场景：poc-verify 前发现沙箱无目标实例（build-state.status != available）
// ---------------------------------------------------------------------------

export async function runBuildExecute(ctx: LibCtx, init: SessionHandle, requirement: string): Promise<boolean> {
  await init.goto("init");
  const s = await init.fork(`build-exec-${Date.now()}`, "build");
  try {
    const r = await s.prompt(buildPrompt(ctx, "build",
      `build 执行任务：按以下要求实际构建并部署项目，完成后把实例连接信息写入 build-state（status=available）。要求：${requirement}`));
    if (r.aborted) { ctx.report("build 执行中止（API 不可用）"); return false; }
    return true;
  } finally { s.close(); }
}
