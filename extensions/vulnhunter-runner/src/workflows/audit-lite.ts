/**
 * audit-lite：轻量 workflow（第一档 <1万行），阶段化定稿版（fish 09-09；工具重构接线 fish 09-20）。
 *
 * 阶段表：onboard → build → research → compress（压缩跳转）→ hunt（单阶段多轮）
 *         → chains（HYP 链扇出，fork 自出生轮末梢+启动 compact；派发依据 system/hyp 状态 + findings 电选）
 * 池（fish 09-21 三池定稿）：init（onboard/build/research/compress，锁1）/ hunt（锁1）/ verify（sv|dv）；沙箱=资源容量非池。
 *
 * hunt（fish 09-11 定稿）：并发锁 1 单会话逐轮；每轮选一个千行级小功能点精读；
 * 无轮次上限（rounds 仅作显式封顶）；停轮=覆盖≥阈值 且 连续 x 轮零新增（hunt_zero_rounds，默认 3，fish 09-21 校准）；
 * 摘要两档：每轮结束小摘要（ΣhuntN），上下文占用>60% 时对历史全 hunt 大轮摘要（Σhunt1-N）。
 *
 * 断点/单步：runtime.runStages 驱动，--from <阶段> 续跑、--only <阶段> 单步重试。
 * 标记语法：docs/session-marks.md（<任务>-start[成分] / <任务>-done[成分][+产出]，Σ=已摘要）。
 *
 * 参数（ctx.params）：rounds / chain_filter / chain_concurrency / hunt_coverage_threshold / hunt_zero_rounds /
 * hunt_mode（fresh=每轮从 init 重开）/ coverage_include / coverage_exclude / sandbox_cfg / skip_ev / model_concurrency /
 * 模型：model（全局）/ model_init / model_hunt / model_verify（按池），语法 provider/model[:thinking]（见 model-config.ts）。
 */

import { defineStagedWorkflow, runStages, type StageCtx, type StageDef, type WorkflowContext } from "../runtime.ts";
import { createExecutor } from "../executor/index.ts";
import { createWakeQueue, electVerifyCandidates, runHypChain, runVerifyConsumer } from "./lib.ts";
import { buildPrompt, forkFromLabel, type SessionHandle } from "../session.ts";
import { monitorState } from "../monitor-state.ts";
import { hypIds, updateHyp } from "../tools/hyp.ts";
import { readSandboxState } from "../tools/sandbox.ts";
import { createLiveModelSwitch, createModelFileWatch, effectiveModelSpec, readModelConfig, seedModelConfigFromParams } from "../model-config.ts";
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
    // 按池模型（fish 09-21）：model=汇总视图；model_* = 各池生效值（文件已含启动参数，stages() 先于本视图执行）
    const mcfg = readModelConfig(ctx.workdir);
    const modelOf = (p: "init" | "hunt" | "verify"): string => effectiveModelSpec(mcfg, p) ?? model;
    const allSame = modelOf("init") === modelOf("hunt") && modelOf("hunt") === modelOf("verify");
    return {
      model: allSame ? modelOf("init") : `init=${modelOf("init")} · hunt=${modelOf("hunt")} · verify=${modelOf("verify")}`,
      model_init: modelOf("init"),
      model_hunt: modelOf("hunt"),
      model_verify: modelOf("verify"),
      vuln_focus: ctx.params.vuln_focus ?? "（全方向）",
      rounds: ctx.params.rounds ?? "（无上限）",
      hunt_mode: ctx.params.hunt_mode ?? "积累制",
      hunt_coverage_threshold: `${ctx.params.hunt_coverage_threshold ?? "90"}%`,
      hunt_zero_rounds: ctx.params.hunt_zero_rounds ?? "3",
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
    const chainConc = Math.max(1, Number(ctx.params.chain_concurrency || ctx.params.model_concurrency || "3"));   // 默认跟模型容量（fish 09-21：静态验证只受模型容量限；dv 另受沙箱池限）
    const out: StageDef[] = [];

    // ---- 执行器接线（fish 09-15）：容量=外部供给真闸门；池=需求组织；chains 派发按 verify 池并发 ----
    const exec = createExecutor();
    const modelPermits = Math.max(1, Number(ctx.params.model_concurrency || "3"));
    exec.bindCapacity("model", { permits: modelPermits });
    exec.bindCapacity("sandbox", { permits: ctx.params.sandbox_cfg ? 1 : 0 });
    const initPool = exec.declarePool("init", { concurrency: 1, locked: true, priority: 40, needs: ["model"] });
    const huntPool = exec.declarePool("hunt", { concurrency: 1, locked: true, priority: 30, needs: ["model"] });
    const verifyPool = exec.declarePool("verify", { concurrency: chainConc, priority: 10, needs: ["model"] });
    // 沙箱＝资源维度（不是池，fish 09-21）：dynamic verify / ev 段过沙箱闸（嵌套 acquire，继承外层模型许可）
    const acquireSandbox = <T>(fn: () => Promise<T>, tag: string): Promise<T> => {
      const cap = exec.stats().capacities.find((c) => c.name === "sandbox");
      return cap && cap.permits > 0 ? exec.acquire({ sandbox: 1 }, fn, { tag, priority: 10 }) : fn();
    };
    const wakeups = createWakeQueue();   // hunt ∥ verify 事件唤醒（task.end / 轮末 / 收尾；fish 09-21）

    // ---- 模型配置（fish 09-21）：按池分配（init/hunt/verify）+ 运行中热切换 ----
    seedModelConfigFromParams(ctx.workdir, ctx.params);   // 启动参数并入单源文件（只写显式给出的项）
    const modelSpecFor = (pool: "init" | "hunt" | "verify"): string | undefined => effectiveModelSpec(readModelConfig(ctx.workdir), pool);
    const modelSwitch = createLiveModelSwitch({ read: () => readModelConfig(ctx.workdir), report: (m) => ctx.report(m) });
    const modelWatch = createModelFileWatch({ workdir: ctx.workdir, onChanged: () => modelSwitch.apply() });
    const registerLive = (h: SessionHandle, pool: () => "init" | "hunt" | "verify", applied: string | undefined): (() => void) => modelSwitch.register(h, pool, applied);
    const ensureModelWatch = (): (() => void) => modelWatch.acquire();
    // 阶段复用：开/复活本阶段池的会话（按池模型注入 + 登记热切换 + 启动模型监听）
    const pooledOpen = async (s: import("../runtime.ts").StageCtx, pool: "init" | "hunt", tag: string, o?: { fresh?: boolean }) => {
      const unwatch = ensureModelWatch();
      try {
        const spec = modelSpecFor(pool);
        const h = await s.openSession("init", "init-host", { binding: { tag }, ...(o?.fresh ? { fresh: true } : {}), ...(spec ? { modelSpec: spec } : {}) });
        const unreg = registerLive(h, () => pool, spec);
        return { h, done: () => { unreg(); unwatch(); } };
      } catch (e) { unwatch(); throw e; }
    };
    monitorState.attachExecutor(exec);   // 观察台/监控台数据源 = executor.stats()

    // ---- init 三段 ----
    out.push({ name: "onboard", run: async (s) => {
      const { h: s0, done: stageDone } = await pooledOpen(s, "init", "init", { fresh: true });
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"),
          { start: "onboard-start[∅]", done: "onboard-done[on][+profiler]", label: "onboard" }), { tag: "onboard" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); stageDone(); }   // 关句柄不关文件；后续阶段按文件复活
    } });
    out.push({ name: "build", run: async (s) => {
      const { h: s0, done: stageDone } = await pooledOpen(s, "init", "init");
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "build", "build 任务，理解项目的构建与部署方式（落 knowledge/env），并按需实测沙箱、用 sandbox 工具回报状态。"),
          { start: "build-start[on]", done: "build-done[on,bu][+env,sandbox]", label: "build" }), { tag: "build" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); stageDone(); }
    } });
    out.push({ name: "research", run: async (s) => {
      const { h: s0, done: stageDone } = await pooledOpen(s, "init", "research");
      try {
        const r = await initPool.submit(() => s0.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径；检出的风险线索可直接用 hyp 工具落成假设。"),
          { start: "research-start[on,bu]", label: "research" }), { tag: "research" });
        if (r.aborted) throw new Error("API 不可用");
        s0.mark(`research-done[on,bu,re][+research,wiki]`);
      } finally { s0.close(); stageDone(); }
    } });
    out.push({ name: "compress", run: async (s) => {
      const { h: s0, done: stageDone } = await pooledOpen(s, "init", "init");
      try {
        await initPool.submit(() => s0.summarizeTo("onboard-start", { summaryLabel: "init[Σ(on,bu,re)]", guide: COMPACT_INIT }), { tag: "compress" });
      } finally { s0.close(); stageDone(); }
    } });

    // ---- hunt（单阶段多轮；fish 09-11 定稿见文件头注释；与 verify 消费并行，fish 09-21）----
    out.push({ name: "hunt", parallelGroup: "audit-loop", run: async (s) => {
      (s.state.data as Record<string, unknown>).huntSettled = false;   // run 级标志：重跑 hunt 时清掉上次遗留（否则并行 chains 会立刻误判收尾）
      s.save();
      const { h: s0, done: stageDone } = await pooledOpen(s, "hunt", "hunt");
      try {
        // 整个多轮 hunt = hunt 池的一个长任务（锁 1，全程持 1 份模型许可）
        await huntPool.submit(async () => {
        const fresh = ctx.params.hunt_mode === "fresh";
        const threshold = Number(ctx.params.hunt_coverage_threshold || "90");
        const zeroRounds = Number(ctx.params.hunt_zero_rounds || "3");   // 停轮连零轮数 x（fish 09-21 校准）
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
          // 停轮判定（fish 09-21 校准）：覆盖率达阈值 且 连续 x 轮零新增
          const covPct = targetCov();
          zeroStreak = news.length === 0 ? zeroStreak + 1 : 0;
          if (covPct !== null && covPct * 100 >= threshold && zeroStreak >= zeroRounds) {
            ctx.report(`覆盖达标（${(covPct * 100).toFixed(1)}% ≥ ${threshold}%）且连续 ${zeroRounds} 轮零新增，hunt 停轮`);
            d.huntRound = r0; d.huntZeroStreak = zeroStreak; d.huntLastBig = lastBig; s.save();
            break;
          }
          d.huntRound = r0; d.huntZeroStreak = zeroStreak; d.huntLastBig = lastBig; s.save();
          wakeups.push();   // 轮末唤醒：新 HYP 已落盘，消费侧立即开工
        }
        const sigmaEnd = fresh ? [] : [...(lastBig ? [`Σhunt1-${lastBig}`] : []),
          ...Array.from({ length: ((d.huntRound as number | undefined) ?? 0) - lastBig }, (_, i) => `Σhunt${lastBig + i + 1}`)];
        s0.mark(`hunt-end[init${sigmaEnd.length ? "," + sigmaEnd.join(",") : ""}][+${hypIds(ctx.workdir).length}HYP]`);
        await s0.execCommand("/coverage-record off");   // 关闭记录并落盘（09-20 解耦）
        }, { tag: "hunt" });
      } finally {
        s0.close();
        stageDone();
        (s.state.data as Record<string, unknown>).huntSettled = true;   // 上游落定（含失败路径）：消费侧收干后退出
        s.save();
        wakeups.push();
      }
    } });

    // ---- verify 消费（system/hyp 状态驱动；与 hunt 并行、事件驱动——fish 09-21「下游消费优先」）----
    out.push({ name: "chains", parallelGroup: "audit-loop", run: async (s) => {
      const sessionFile = (s.state.sessions as Record<string, string>).init;
      const unwatch = ensureModelWatch();   // 链窗口延续模型监听（hunt 结束后监听仍有效）
      // 上游落定：hunt 不在本 run / 已收尾（huntSettled）/ 状态已是 done|failed
      const settled = (): boolean =>
        !s.selected.includes("hunt")
        || !!(s.state.data as Record<string, unknown>).huntSettled
        || s.state.stages.hunt === "done"
        || s.state.stages.hunt === "failed";
      // 动态门槛可见性（fail-closed 收口）：沙箱状态未知时明确告警，不静默（09-17 ev 静默缺陷教训）
      if (ctx.params.sandbox_cfg && readSandboxState(ctx.workdir).status === "unknown") {
        ctx.report("⚠ 沙箱状态未知（unknown）——动态链将自行探测并回报 sandbox；请确认 build 阶段已执行 sandbox report");
      }
      const unsub = exec.on((e) => { if (e.type === "task.end") wakeups.push(); });   // 释放槽位 → 唤醒
      try {
        const r = await runVerifyConsumer({
          candidates: () => electVerifyCandidates(ctx, s.state.data, { chainK, includeResearch: settled() }),
          markRunning: (ids) => { for (const id of ids) updateHyp(ctx.workdir, id, { status: "running" }); },
          runOne: async (c) => {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await verifyPool.submit(
                  () => runHypChain(ctx, c.id, {
                    forkPoint: c.fork, birthIngredients: c.ing, acquireSandbox,
                    registerLive: (h) => registerLive(h, () => "verify", modelSpecFor("verify")),
                    forkAtLabel: (label, newId) => {
                      if (!sessionFile) throw new Error("fork 失败：run 状态缺 init 会话文件");
                      const spec = modelSpecFor("verify");
                      return forkFromLabel({ ...ctx, runId: s.state.runId }, sessionFile, label, newId, { agent: "hyp-chain", binding: { hypId: c.id }, ...(spec ? { modelSpec: spec } : {}) });
                    },
                  }),
                  { tag: `${c.id}#a${attempt}` },
                );
                return "done";
              } catch (e) {
                const msg = String(e).slice(0, 140);
                if (attempt >= 3) { ctx.report(`verify 异常×3，停派留待下次：${c.id} ${msg}`); return "stopped"; }
                ctx.report(`verify 异常（第 ${attempt} 次，将重派）：${c.id} ${msg}`);
              }
            }
            return "stopped";
          },
          slotsFree: () => {
            const p = exec.stats().pools.find((x) => x.name === "verify");
            return p ? Math.max(0, p.concurrency - p.running.length) : 0;
          },
          settled,
          wakeup: () => wakeups.pop(),
          notify: () => wakeups.push(),
          report: (m) => ctx.report(m),
        });
        ctx.report(`verify 阶段收工：派发 ${r.dispatched}（完成 ${r.done}，停派 ${r.stopped}）`);
      } finally { unsub(); unwatch(); }
    } });

    return out;
  },
});

export default liteWorkflow;

/** 直接执行入口（驱动脚本用） */
export async function run(ctx: WorkflowContext, opts?: { runId?: string; from?: string; only?: string }) {
  await runStages(liteWorkflow, ctx, opts);
}
