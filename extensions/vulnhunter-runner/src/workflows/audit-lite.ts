/**
 * audit-lite：轻量 workflow（第一档 <1万行），阶段化定稿版（fish 09-09；工具重构接线 fish 09-20）。
 *
 * 阶段表：onboard → build → research → compress（压缩跳转）→ hunt（单阶段多轮）
 *         → chains（HYP 链扇出，fork 自出生轮末梢+启动 compact；派发依据 system/hyp 状态 + findings 电选）
 *
 * hunt（fish 09-11 定稿）：并发锁 1 单会话逐轮；每轮选一个千行级小功能点精读；
 * 无轮次上限（rounds 仅作显式封顶）；停轮=覆盖>阈值且零新增（主停）/连续3轮零新增（兜底）；
 * 摘要两档：每轮结束小摘要（ΣhuntN），上下文占用>60% 时对历史全 hunt 大轮摘要（Σhunt1-N）。
 *
 * 断点/单步：runtime.runStages 驱动，--from <阶段> 续跑、--only <阶段> 单步重试。
 * 标记语法：docs/session-marks.md（<任务>-start[成分] / <任务>-done[成分][+产出]，Σ=已摘要）。
 *
 * 参数（ctx.params）：rounds / chain_filter / chain_concurrency / hunt_coverage_threshold /
 * hunt_mode（fresh=每轮从 init 重开）/ coverage_include / coverage_exclude / sandbox_cfg / skip_ev / model_concurrency。
 */

import { defineStagedWorkflow, runStages, type StageCtx, type StageDef, type WorkflowContext } from "../runtime.ts";
import { createExecutor } from "../executor/index.ts";
import { runHypChain } from "./lib.ts";
import { buildPrompt } from "../session.ts";
import { monitorState } from "../monitor-state.ts";
import { hypIds, readHyp, updateHyp } from "../tools/hyp.ts";
import { readFinding } from "../tools/finding.ts";
import { readSandboxState } from "../tools/sandbox.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPACT_INIT = "保留：项目画像与威胁模型要点、构建部署要点、关键代码区域与行号、漏洞认可口径、检索到的情报结论。丢弃：过程性输出与重复细节。摘要正文控制在 4000 字以内。";
const COMPACT_ROUND = "只保留本轮新提出的 HYP 标题+一句话主张+关键锚点行号，以及读过的代码区域清单；丢弃推演过程。控制在 2000 字内。";

const liteWorkflow = defineStagedWorkflow({
  name: "audit-lite",
  description: "轻量 run（<1万行）：init 三段→压缩跳转→hunt 分支往返→HYP 链按出生轮 fork",

  // 观察台自报有效配置（09-14 designer）：默认值在此解析，前端不猜
  configView(ctx) {
    let model = "（会话默认）";
    try {
      const s = JSON.parse(readFileSync(join(ctx.engineDir, "settings.json"), "utf-8"));
      if (s.defaultProvider && s.defaultModel) model = `${s.defaultProvider}/${s.defaultModel}`;
    } catch { /* 无碍 */ }
    return {
      model,
      vuln_focus: ctx.params.vuln_focus ?? "（全方向）",
      rounds: ctx.params.rounds ?? "（无上限）",
      hunt_mode: ctx.params.hunt_mode ?? "积累制",
      hunt_coverage_threshold: `${ctx.params.hunt_coverage_threshold ?? "90"}%`,
      chain_filter: ctx.params.chain_filter ?? "全部",
      chain_concurrency: ctx.params.chain_concurrency ?? "3",
      model_concurrency: ctx.params.model_concurrency ?? "3（模型容量许可）",
      sandbox: ctx.params.sandbox_cfg ?? "（无，纯静态）",
      coverage_include: ctx.params.coverage_include ?? ".",
      coverage_exclude: ctx.params.coverage_exclude ?? "（无）",
    };
  },

  stages(ctx) {
    const chainK = ctx.params.chain_filter ? Number(ctx.params.chain_filter) : Infinity;
    const chainConc = Math.max(1, Number(ctx.params.chain_concurrency || "3"));
    const out: StageDef[] = [];

    // ---- 执行器接线（fish 09-15）：容量=外部供给真闸门；池=需求组织；chains 派发按 verify 池并发 ----
    const exec = createExecutor();
    const modelPermits = Math.max(1, Number(ctx.params.model_concurrency || "3"));
    exec.bindCapacity("model", { permits: modelPermits });
    exec.bindCapacity("sandbox", { permits: ctx.params.sandbox_cfg ? 1 : 0 });
    const initPool = exec.declarePool("init", { concurrency: 1, locked: true, priority: 40, needs: ["model"] });
    const huntPool = exec.declarePool("hunt", { concurrency: 1, locked: true, priority: 30, needs: ["model"] });
    const verifyPool = exec.declarePool("verify", { concurrency: chainConc, priority: 10, needs: ["model"] });
    const sandboxPool = exec.declarePool("sandbox", { concurrency: 1, priority: 20, needs: ["sandbox", "model"] });
    monitorState.attachExecutor(exec);   // 观察台/监控台数据源 = executor.stats()

    // ---- init 三段 ----
    out.push({ name: "onboard", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { tag: "init" }, fresh: true });
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"),
          { start: "onboard-start[∅]", done: "onboard-done[on][+profiler]", label: "onboard" }), { tag: "onboard" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); }   // 关句柄不关文件；后续阶段按文件复活
    } });
    out.push({ name: "build", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { tag: "init" } });
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "build", "build 任务，理解项目的构建与部署方式（落 knowledge/env），并按需实测沙箱、用 sandbox 工具回报状态。"),
          { start: "build-start[on]", done: "build-done[on,bu][+env,sandbox]", label: "build" }), { tag: "build" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); }
    } });
    out.push({ name: "research", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { tag: "research" } });
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径；检出的风险线索可直接用 hyp 工具落成假设。"),
          { start: "research-start[on,bu]", label: "research" }), { tag: "research" });
        if (r.aborted) throw new Error("API 不可用");
        s0.mark(`research-done[on,bu,re][+research,wiki]`);
      } finally { s0.close(); }
    } });
    out.push({ name: "compress", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { tag: "init" } });
      try {
        await initPool.submit(() => s0.summarizeTo("onboard-start", { summaryLabel: "init[Σ(on,bu,re)]", guide: COMPACT_INIT }), { tag: "compress" });
      } finally { s0.close(); }
    } });

    // ---- hunt（单阶段多轮；fish 09-11 定稿见文件头注释）----
    out.push({ name: "hunt", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { tag: "hunt" } });
      try {
        // 整个多轮 hunt = hunt 池的一个长任务（锁 1，全程持 1 份模型许可）
        await huntPool.submit(async () => {
        const fresh = ctx.params.hunt_mode === "fresh";
        const threshold = Number(ctx.params.hunt_coverage_threshold || "90");
        const maxRounds = ctx.params.rounds ? Number(ctx.params.rounds) : Infinity;
        const d = s.state.data;
        // 覆盖数据一律读 coverage 扩展的产物（快照 JSON）——09-20 解耦，runner 不再直接聚合事件
        const covSnapPath = join(ctx.workdir, "system", "coverage", "code-reading-coverage.json");
        const targetCov = (): number | null => {
          try {
            const snap = JSON.parse(readFileSync(covSnapPath, "utf-8")) as { summary?: { total_lines?: number; coverage?: number } };
            const sm = snap.summary ?? {};
            return (sm.total_lines ?? 0) > 0 ? (sm.coverage ?? 0) : null;
          } catch { return null; }
        };
        // 初始快照：先发 on（扩展强制枚举落盘；无头流 session_start 不触发，09-20 实测）——护栏与监视的数据源
        await s0.execCommand("/coverage-record on");
        // 空目标护栏（读产物；09-11 教训：include 被 exclude 吞掉时 coverage 静默全程为零）
        try {
          const snap0 = JSON.parse(readFileSync(covSnapPath, "utf-8")) as { summary?: { total_lines?: number } };
          if ((snap0.summary?.total_lines ?? null) === 0)
            ctx.report("⚠ 覆盖率统计目标为空（coverage_include 被 coverage_exclude 吞掉？），coverage 将全程为零");
        } catch { /* 快照未生成：会话启动后由扩展落盘，此处跳过 */ }
        let zeroStreak = (d.huntZeroStreak as number | undefined) ?? 0;
        let lastBig = (d.huntLastBig as number | undefined) ?? 0;   // 大轮摘要已覆盖到第几轮
        for (let r0 = ((d.huntRound as number | undefined) ?? 0) + 1; r0 <= maxRounds; r0++) {
          const rn = `hunt${r0}`, mine = `h${r0}`;
          // 成分表：大轮检查点（若有）+ 其后各轮小摘要；fresh 模式没有轮间摘要
          const sigmaPrev = fresh ? [] : [...(lastBig ? [`Σhunt1-${lastBig}`] : []),
            ...Array.from({ length: r0 - 1 - lastBig }, (_, i) => `Σhunt${lastBig + i + 1}`)];
          if (r0 === 1) s0.mark("hunt-start[init]");
          // fresh 模式（fish 09-11 双场景测试）：每轮从 init 重新开始，不继承任何 hunt 历史
          const freshRestart = fresh && r0 > 1;
          if (freshRestart) await s0.goto("init");
          s0.setBinding({ tag: rn });
          await s0.execCommand("/coverage-record on");   // 记录开关（coverage 扩展自理；09-20 解耦）
          const before = new Set(hypIds(ctx.workdir));
          // fresh 重开轮不打 start 标：goto 后叶子正是 init 锚点条目，pi 单条目单标签，
          // 此时打标会覆盖锚点标签，下一轮 goto("init") 必死（09-11 mem-b hunt3 实踩）
          const r = await s0.prompt(buildPrompt(ctx, "hunt", `hunt 任务（第 ${r0} 轮）。用 coverage({scope:"global"}) 查看靶内已读覆盖，选定一个尚未精读、边界明确的单一功能点（代码量千行及以下）系统性精读，沿真实数据流挖掘风险假设（HYP），每条落到具体 file:line；与已有 HYP 重复不提。确认没有新东西就明说。`),
            { ...(freshRestart ? {} : { start: `${rn}-start[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""}]` }), label: rn });
          if (r.aborted) throw new Error("API 不可用");
          const news = hypIds(ctx.workdir).filter((id) => !before.has(id));
          ((d.roundHyps ??= {}) as Record<string, string[]>)[rn] = news;
          ((d.roundSigma ??= {}) as Record<string, string[]>)[rn] = sigmaPrev;
          s0.mark(`${rn}-done[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""},${mine}][+${news.length}HYP]`);
          // 两档摘要（fish 09-11）：每轮结束小摘要压本轮；上下文占用>60% 时对历史全 hunt 大轮摘要；fresh 均不做
          if (!fresh) {
            await s0.summarizeTo(`${rn}-start`, { summaryLabel: `Σhunt${r0}`, guide: COMPACT_ROUND });
            const pct = s0.contextPercent();
            if (pct !== null && pct > 60) {
              ctx.report(`hunt 触发大轮摘要（第 ${r0} 轮，占用 ${pct.toFixed(0)}%）`);
              await s0.summarizeTo("hunt-start", {
                summaryLabel: `Σhunt1-${r0}`,
                guide: "这是多轮 hunt（风险假设挖掘）的历史。保留：各轮产出的全部 HYP 编号+一句话主张+关键锚点；各轮读过的代码区域。",
              });
              lastBig = r0;
            }
          }
          // 停轮判定（fish 09-11）：主停=覆盖>阈值且本轮零新增；兜底=连续 3 轮零新增
          const covPct = targetCov();
          if (covPct !== null && covPct * 100 >= threshold && news.length === 0) {
            ctx.report(`覆盖达标（${(covPct * 100).toFixed(1)}% ≥ ${threshold}%）且本轮零新增，hunt 停轮`);
            d.huntRound = r0; d.huntZeroStreak = 0; d.huntLastBig = lastBig; s.save();
            break;
          }
          zeroStreak = news.length === 0 ? zeroStreak + 1 : 0;
          if (zeroStreak >= 3) {
            ctx.report(`连续 3 轮零新增（覆盖 ${covPct === null ? "未知" : (covPct * 100).toFixed(1) + "%"}），hunt 兜底停轮`);
            d.huntRound = r0; d.huntZeroStreak = zeroStreak; d.huntLastBig = lastBig; s.save();
            break;
          }
          d.huntRound = r0; d.huntZeroStreak = zeroStreak; d.huntLastBig = lastBig; s.save();
        }
        const sigmaEnd = fresh ? [] : [...(lastBig ? [`Σhunt1-${lastBig}`] : []),
          ...Array.from({ length: ((d.huntRound as number | undefined) ?? 0) - lastBig }, (_, i) => `Σhunt${lastBig + i + 1}`)];
        s0.mark(`hunt-end[init${sigmaEnd.length ? "," + sigmaEnd.join(",") : ""}][+${hypIds(ctx.workdir).length}HYP]`);
        await s0.execCommand("/coverage-record off");   // 关闭记录并落盘（09-20 解耦）
        }, { tag: "hunt" });
      } finally { s0.close(); }
    } });

    // ---- HYP 链（system/hyp 状态驱动：未办结且未产出 finding 的 HYP 派发；fork 自出生轮末梢+启动 compact）----
    out.push({ name: "chains", run: async (s) => {
      const init = await s.openSession("init", "init-host", { binding: { tag: "init" } });
      try {
        const roundHyps = (s.state.data.roundHyps ?? {}) as Record<string, string[]>;
        const roundSigma = (s.state.data.roundSigma ?? {}) as Record<string, string[]>;
        // 电选（chain_filter 每轮前 K 条；已办结/已产出 finding 跳过，单步重试幂等）
        const elected: Array<{ id: string; fork: string; ing: string }> = [];
        for (const [rn, files] of Object.entries(roundHyps)) {
          const r0 = Number(rn.replace("hunt", ""));
          const sig = roundSigma[rn] ?? [];
          const ing = `Σ(init${sig.length ? "," + sig.join(",") : ""},h${r0})`;
          for (const f of files.slice(0, chainK)) {
            const id = f.replace(/\.(md|json)$/, "");
            const rec = readHyp(ctx.workdir, id);
            if (!rec) { ctx.report(`电选跳过（HYP 记录缺失）：${id}`); continue; }
            if (rec.status === "closed" || rec.conclusion === "refuted") continue;   // 已办结（含 refuted）
            if (readFinding(ctx.workdir, id.replace(/^HYP-/, "BUG-"))) continue;     // 已产出 finding（confirmed）
            elected.push({ id, fork: `${rn}-done`, ing });
          }
        }
        // research（及非轮次来源）的 HYP：出生点是 research-done，同样进研判（fish 09-20：research 可调用 hyp）
        const researchIds = hypIds(ctx.workdir).filter((idd) => (readHyp(ctx.workdir, idd)?.tag ?? "").startsWith("research"));
        for (const id of researchIds.slice(0, chainK)) {
          const rec = readHyp(ctx.workdir, id);
          if (!rec) continue;
          if (rec.status === "closed" || rec.conclusion === "refuted") continue;
          if (readFinding(ctx.workdir, id.replace(/^HYP-/, "BUG-"))) continue;
          if (elected.some((e2) => e2.id === id)) continue;
          // fork 自 hunt-end（压缩后的安全点；research-done 在压缩区间内，fork 会丢 Σ(init) 摘要——replay 实踩）
          elected.push({ id, fork: "hunt-end", ing: "Σ(init)" });
        }
        // 动态门槛可见性（fail-closed 收口）：沙箱状态未知时明确告警，不静默（09-17 ev 静默缺陷教训）
        if (ctx.params.sandbox_cfg && readSandboxState(ctx.workdir).status === "unknown") {
          ctx.report("⚠ 沙箱状态未知（unknown）——动态链将自行探测并回报 sandbox；请确认 build 阶段已执行 sandbox report");
        }
        // 派发前置 running（崩溃后下次运行按未办结重选；办结以裁决回写为准）
        for (const e of elected) updateHyp(ctx.workdir, e.id, { status: "running" });
        let done = 0, stopped = 0;
        await Promise.all(elected.map(async (meta) => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await verifyPool.submit(
                () => runHypChain(ctx, init, meta.id, { forkPoint: meta.fork, birthIngredients: meta.ing, sandboxPool }),
                { tag: `${meta.id}#a${attempt}` },
              );
              done++;
              return;
            } catch (e) {
              const msg = String(e).slice(0, 140);
              if (attempt >= 3) { stopped++; ctx.report(`链异常×3，停派留待下次：${meta.id} ${msg}`); return; }
              ctx.report(`链异常（第 ${attempt} 次，将重派）：${meta.id} ${msg}`);
            }
          }
        }));
        ctx.report(`chains 阶段：派发 ${elected.length} 条链（完成 ${done}，停派 ${stopped}）`);
      } finally { init.close(); }
    } });

    return out;
  },
});

export default liteWorkflow;

/** 直接执行入口（驱动脚本用） */
export async function run(ctx: WorkflowContext, opts?: { runId?: string; from?: string; only?: string }) {
  await runStages(liteWorkflow, ctx, opts);
}
