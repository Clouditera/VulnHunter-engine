/**
 * audit-lite：轻量 workflow（第一档 <1万行），阶段化定稿版（fish 09-09；工具重构接线 fish 09-20）。
 *
 * 阶段表：onboard → build → research → compress（压缩跳转）→ hunt（单阶段多轮）
 *         → chains（HYP 链扇出，fork 自出生轮末梢+启动 compact；派发依据 system/hyp 状态 + findings 电选）
 * 池（fish 09-21 三池定稿）：init（onboard/build/research/compress，锁1）/ hunt（锁1）/ verify（sv|dv）；沙箱=资源容量非池。
 *
 * hunt（fish 09-11 定稿）：并发锁 1 单会话逐轮；每轮选一个千行级小功能点精读；
 * 停轮（HALL-64 有效产出判定器，src/stop-decider.ts）：覆盖≥阈值 且（有效新增<3 / 近2轮转化率=0 / 有效新增边际减半）
 * → 确认轮 → 确认轮零有效新增即停；硬上限语义（HALL-69）：显式 rounds 优先（给了就只以它为准，0=无上限），
 * 自动上限=clamp(k·log10(loc),2,15)，hunt_max_rounds(k) 缺省 0=默认关闭（≥1 启用）；无上限时启动 report 提示仅靠判定器熔断；
 * hunt_zero_rounds 已 deprecated：保留读取不参与判定，显式传入打 warning。
 * 摘要两档：每轮结束小摘要（ΣhuntN），上下文占用>60% 时对历史全 hunt 大轮摘要（Σhunt1-N）。
 *
 * 断点/单步：runtime.runStages 驱动，--from <阶段> 续跑、--only <阶段> 单步重试。
 * 标记语法：docs/session-marks.md（<任务>-start[成分] / <任务>-done[成分][+产出]，Σ=已摘要）。
 *
 * 参数（ctx.params）：rounds / chain_filter / chain_concurrency / hunt_coverage_threshold / hunt_max_rounds /
 * hunt_zero_rounds（deprecated，仅读取告警，不参与判定）/
 * hunt_mode（fresh=每轮从 init 重开）/ audit_small_max_loc（小模式 LOC 阈值，默认 5000；HALL-64 §1）/
 * coverage_include / coverage_exclude / sandbox_cfg / skip_ev / model_concurrency /
 * 模型：model（全局）/ model_init / model_hunt / model_verify（按池），语法 provider/model[:thinking]（见 model-config.ts）。
 *
 * 小模式分流（HALL-64 §1）：LOC < audit_small_max_loc → SMALL 全量直审（全文装配单会话 + 1 轮 HYP，无逐轮精读会话与 Σhunt 链）；
 * 装配预算 = 上下文窗口×60%，超预算降级回 HUNT 并记日志；运行元数据落盘 mode: small|hunt。
 */

import { defineStagedWorkflow, runStages, type StageCtx, type StageDef, type WorkflowContext } from "../runtime.ts";
import { createExecutor } from "../executor/index.ts";
import { createWakeQueue, electVerifyCandidates, runHypChain, runVerifyConsumer } from "./lib.ts";
import { buildPrompt, forkFromLabel, type SessionHandle } from "../session.ts";
import { monitorState } from "../monitor-state.ts";
import { hypIds, updateHyp } from "../tools/hyp.ts";
import { readSandboxState } from "../tools/sandbox.ts";
import { createLiveModelSwitch, createModelFileWatch, effectiveModelSpec, readModelConfig, seedModelConfigFromParams } from "../model-config.ts";
import { hardCap, shouldStop, type RoundStat } from "../stop-decider.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listCoverageTargetFiles } from "../../node-ext/code-coverage/coverage-core.ts";

/** 装配预算占比：模型上下文窗口 × 60%（与摘要触发线一致，设计规格 §1） */
const ASSEMBLE_BUDGET_RATIO = 0.6;
/** 行文本 → token 的保守估算（代码约 3.5 字符/token，取 3 上浮保险） */
const CHARS_PER_TOKEN = 3;

/** SMALL 模式全文装配预算检查：靶内全文本一次进单会话，估算 tokens ≤ 窗口×60%（HALL-64 §1） */
function fitsAssembleBudget(files: Array<{ rel: string; full: string; lines: number }>, window: number): { ok: boolean; estTokens: number; budget: number } {
  const budget = Math.floor(window * ASSEMBLE_BUDGET_RATIO);
  let chars = 0;
  for (const f of files) {
    try { chars += readFileSync(f.full, "utf-8").length + f.rel.length + 8; } catch { /* 读不了的文件按行数估算 */ chars += f.lines * 40; }
  }
  const estTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return { ok: estTokens <= budget, estTokens, budget };
}

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
      rounds: ctx.params.rounds ?? "（自动硬上限 clamp(5·log10(loc),2,15)，k≤0 关闭）",
      hunt_mode: ctx.params.hunt_mode ?? "积累制",
      hunt_coverage_threshold: `${ctx.params.hunt_coverage_threshold ?? "90"}%`,
      hunt_max_rounds: ctx.params.hunt_max_rounds ?? "0（默认关闭自动上限）",
      hunt_zero_rounds: ctx.params.hunt_zero_rounds !== undefined ? `${ctx.params.hunt_zero_rounds}（已废弃，不参与判定）` : "（已废弃）",
      audit_small_max_loc: ctx.params.audit_small_max_loc ?? "5000",
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
    // 阶段复用：local/file 模式走旧监听；inline/纯引擎 registry 模式把稳定 runtime 传进 session。
    const pooledOpen = async (s: import("../runtime.ts").StageCtx, pool: "init" | "hunt", tag: string, o?: { fresh?: boolean }) => {
      const registryMode = !!s.modelRegistry?.has(pool);
      const unwatch = registryMode ? () => undefined : ensureModelWatch();
      try {
        const spec = registryMode ? undefined : modelSpecFor(pool);
        const h = await s.openSession("init", "init-host", {
          binding: { tag },
          ...(o?.fresh ? { fresh: true } : {}),
          ...(spec ? { modelSpec: spec } : {}),
          ...(registryMode ? { modelAgentKey: pool } : {}),
        });
        // AgentModelRegistry registers the host inside startSession. Do not also
        // register it in the legacy model.json watcher.
        const unreg = registryMode ? () => undefined : registerLive(h, () => pool, spec);
        return { h, done: () => { unreg(); unwatch(); } };
      } catch (e) { unwatch(); throw e; }
    };
    monitorState.attachExecutor(exec);   // 观察台/监控台数据源 = executor.stats()

    // ---- 小模式分流（HALL-64 §1）：onboard 后按 LOC 判定；loc < audit_small_max_loc（默认 5000）走 SMALL，
    //  全文一次装配进单会话跑 1 轮 HYP 生成；装配超预算（窗口×60%）降级回 HUNT 并记日志。----
    // 分流判定放在 stages() 构建期（onboard 执行前）：口径同源 = 覆盖率分母枚举，与 onboard 产物无关。
    const smallMaxLoc = Math.max(1, Number(ctx.params.audit_small_max_loc || "5000"));
    const smallFiles = listCoverageTargetFiles(ctx.cwd, ctx.workdir);
    const loc = smallFiles.reduce((n, f) => n + f.lines, 0);
    const isSmall = loc < smallMaxLoc;
    ctx.report(`审计模式分流：LOC=${loc}（阈值 ${smallMaxLoc}）→ ${isSmall ? "SMALL（全量直审）" : "HUNT（多轮精读）"}`);

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

    // ---- SMALL 模式（HALL-64 §1）：全文装配 → 单轮 HYP 生成；不建逐轮精读会话、无 Σhunt 摘要链。
    //  装配预算 = 模型上下文窗口 × 60%，超预算（或窗口未知）降级回 HUNT 并记日志。----
    if (isSmall) out.push({ name: "hunt", parallelGroup: "audit-loop", run: async (s) => {
      (s.state.data as Record<string, unknown>).huntSettled = false;
      s.save();
      const { h: s0, done: stageDone } = await pooledOpen(s, "hunt", "hunt");
      const d = s.state.data;
      d.mode = "small";   // 运行元数据落盘（复盘统计用）；降级时改写为 hunt
      d.loc = loc;
      s.save();
      try {
        await huntPool.submit(async () => {
          const win = s0.contextWindow();
          const fit = win !== null ? fitsAssembleBudget(smallFiles, win) : null;
          if (fit !== null && fit.ok) {
            // 全文一次装配：靶内全部文本按路径清单进单会话，模型用 read 一次性通读（不再逐轮精读）
            const fileList = smallFiles.map((f) => `- ${f.rel}（${f.lines} 行）`).join("\n");
            // 覆盖数据读 coverage 扩展快照（与 HUNT 同一数据源；停轮判定的 coverage 输入）
            const covSnapPath = join(ctx.workdir, "system", "coverage", "code-reading-coverage.json");
            const covPct = (): number => {
              try {
                const snap = JSON.parse(readFileSync(covSnapPath, "utf-8")) as { summary?: { total_lines?: number; coverage?: number } };
                const sm = snap.summary ?? {};
                return (sm.total_lines ?? 0) > 0 ? (sm.coverage ?? 0) * 100 : 0;
              } catch { return 0; }
            };
            await s0.execCommand("/coverage-record on");
            const threshold = Number(ctx.params.hunt_coverage_threshold || "90");
            const roundStats: RoundStat[] = [];
            // SMALL 最多 2 轮（设计 §1：1 轮 HYP 生成 → 有效产出判定 → 可选第 2 轮）
            for (let r0 = 1; r0 <= 2; r0++) {
              const rn = `hunt${r0}`;
              const before = new Set(hypIds(ctx.workdir));
              const r = await s0.prompt(buildPrompt(ctx, "hunt",
                `hunt 任务（SMALL 全量直审，第 ${r0} 轮）。本项目规模小（${loc} 行），不做逐轮精读——靶内全部 ${smallFiles.length} 个文本文件用 read 一次性通读，沿真实数据流系统性挖掘风险假设（HYP），每条落到具体 file:line；与已有 HYP 重复不提。${r0 > 1 ? "这是补漏轮：重点排查第 1 轮未覆盖的链路、入口与边界条件。" : ""}\n\n靶内文件清单：\n${fileList}`),
                { start: `${rn}-start[init]`, label: rn });
              if (r.aborted) throw new Error("API 不可用");
              const news = hypIds(ctx.workdir).filter((id) => !before.has(id));
              ((d.roundHyps ??= {}) as Record<string, string[]>)[rn] = news;
              ((d.roundSigma ??= {}) as Record<string, string[]>)[rn] = [];
              s0.mark(`${rn}-done[init,h${r0}][+${news.length}HYP]`);   // 标签沿用 huntN 体系：chains 电选/fork 点依赖它
              roundStats.push({ effectiveNew: news.length, hypCount: news.length });
              d.huntRound = r0;
              d.roundStats = roundStats;
              s.save();
              ctx.report(`SMALL 第 ${r0} 轮产出 ${news.length} 条 HYP${r0 === 1 ? `（估算装配 ${fit.estTokens}/${fit.budget} tokens）` : ""}`);
              wakeups.push();   // 轮末唤醒：新 HYP 已落盘，消费侧立即开工
              if (r0 >= 2) break;
              // 第 2 轮是否必要（设计 §1/§3）：有效产出判定器触发即不跑第 2 轮，直接进 chains
              const decision = shouldStop({
                rounds: roundStats,
                coverage: covPct(),
                coverageThreshold: threshold,
                loc,
                currentRound: r0,
              });
              if (decision.action !== "continue") {
                ctx.report(`SMALL 停轮判定：${decision.action === "stop" ? decision.reason : `触发（${decision.reason}）`}——不跑第 2 轮，直接进 chains`);
                break;
              }
              ctx.report("SMALL 停轮判定：未触发，跑第 2 轮补漏");
            }
            await s0.execCommand("/coverage-record off");
            s0.mark(`hunt-end[init][+${hypIds(ctx.workdir).length}HYP]`);
            return;
          }
          const reason = win === null
            ? "模型上下文窗口未知，无法核算装配预算"
            : `全文装配估算 ${fit!.estTokens} tokens 超预算 ${fit!.budget}（窗口 ${win}×60%）`;
          ctx.report(`SMALL 装配超预算，降级回 HUNT 模式：${reason}`);
          d.mode = "hunt";
          d.degradeReason = reason;
          s.save();
          await runHuntRounds(s, s0);
        }, { tag: "hunt" });
      } finally {
        s0.close();
        stageDone();
        (s.state.data as Record<string, unknown>).huntSettled = true;
        s.save();
        wakeups.push();
      }
    } });

    // ---- hunt（单阶段多轮；fish 09-11 定稿见文件头注释；与 verify 消费并行，fish 09-21）----
    else out.push({ name: "hunt", parallelGroup: "audit-loop", run: async (s) => {
      (s.state.data as Record<string, unknown>).huntSettled = false;   // run 级标志：重跑 hunt 时清掉上次遗留（否则并行 chains 会立刻误判收尾）
      s.save();
      const { h: s0, done: stageDone } = await pooledOpen(s, "hunt", "hunt");
      try {
        // 整个多轮 hunt = hunt 池的一个长任务（锁 1，全程持 1 份模型许可）
        await huntPool.submit(async () => {
        const d = s.state.data;
        d.mode = "hunt";   // 运行元数据落盘（与 SMALL 分支对齐）
        d.loc = loc;
        s.save();
        await runHuntRounds(s, s0);
        }, { tag: "hunt" });
      } finally {
        s0.close();
        stageDone();
        (s.state.data as Record<string, unknown>).huntSettled = true;   // 上游落定（含失败路径）：消费侧收干后退出
        s.save();
        wakeups.push();
      }
    } });

    /** 现有 HUNT 多轮流程原样抽出（行为不变；SMALL 降级回落也走这里） */
    const runHuntRounds = async (s: import("../runtime.ts").StageCtx, s0: SessionHandle): Promise<void> => {
        const fresh = ctx.params.hunt_mode === "fresh";
        const threshold = Number(ctx.params.hunt_coverage_threshold || "90");
        // HALL-64：hunt_zero_rounds 已废弃——由有效产出判定取代；保留读取，显式传入仅打 warning
        if (ctx.params.hunt_zero_rounds !== undefined) {
          ctx.report(`⚠ 参数 hunt_zero_rounds 已废弃（deprecated）：不再参与停轮判定，由有效产出判定器取代（收到值 ${ctx.params.hunt_zero_rounds}，已忽略）`);
        }
        const maxRoundsK = ctx.params.hunt_max_rounds !== undefined ? Number(ctx.params.hunt_max_rounds) : 0;
        const explicitRounds = ctx.params.rounds !== undefined ? Number(ctx.params.rounds) : undefined;
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
        // HALL-64：loc 取覆盖率统计口径总行数（与 small-audit 分流同一口径）
        const locOf = (): number | undefined => {
          try {
            const snap = JSON.parse(readFileSync(covSnapPath, "utf-8")) as { summary?: { total_lines?: number } };
            const tl = snap.summary?.total_lines;
            return tl && tl > 0 ? tl : undefined;
          } catch { return undefined; }
        };
        const cap = hardCap({ loc: locOf(), k: maxRoundsK, explicitMaxRounds: explicitRounds });
        ctx.report(`hunt 轮数硬上限：${cap === Infinity ? "无上限" : cap}${explicitRounds !== undefined ? `（显式 rounds=${explicitRounds}${explicitRounds <= 0 ? "，无上限" : ""}）` : ""}`);
        // HALL-69：无任何硬上限时（现已是默认路径——k 缺省 0 关闭自动上限）明确提示——只剩有效产出判定器熔断兜底
        if (cap === Infinity) {
          ctx.report("⚠ hunt 无轮数硬上限（hunt_max_rounds 未启用或 rounds=0）：仅有效产出判定器熔断兜底，请确认覆盖阈值与停轮触发条件配置合理");
        }
        let roundStats: RoundStat[] = (d.roundStats as RoundStat[] | undefined) ?? [];   // 断点续跑：复用历史轮统计
        let pendingConfirm = false;   // 上一轮判定 CONFIRM → 本轮为确认轮（最多 1 次）
        let lastBig = (d.huntLastBig as number | undefined) ?? 0;   // 大轮摘要已覆盖到第几轮
        for (let r0 = ((d.huntRound as number | undefined) ?? 0) + 1; r0 <= cap; r0++) {
          const rn = `hunt${r0}`, mine = `h${r0}`;
          const isConfirmRound = pendingConfirm;
          pendingConfirm = false;
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
          // 停轮判定（HALL-64 有效产出判定器）：有效新增 = 该轮 ADMIT 的 HYP 数；
          // 准入闸（§2.2）落地前，news 全部视为 ADMIT（gate 落地后此处置换为 gate 计数）
          const covPct = targetCov();
          const stat: RoundStat = { effectiveNew: news.length, hypCount: news.length, isConfirmationRound: isConfirmRound || undefined };
          roundStats = [...roundStats.filter((x, i) => i < r0 - 1), stat];   // 续跑/重跑按轮位覆盖
          const decision = shouldStop({
            rounds: roundStats,
            coverage: covPct !== null ? covPct * 100 : 0,
            coverageThreshold: threshold,
            loc: locOf(),
            maxRoundsK,
            ...(explicitRounds !== undefined ? { explicitMaxRounds: explicitRounds } : {}),
            currentRound: r0,
          });
          if (decision.action === "stop") {
            ctx.report(`hunt 停轮：${decision.reason}（覆盖 ${covPct !== null ? (covPct * 100).toFixed(1) + "%" : "未知"}，阈值 ${threshold}%）`);
            d.huntRound = r0; d.huntLastBig = lastBig; d.roundStats = roundStats; s.save();
            break;
          }
          if (decision.action === "confirm") {
            ctx.report(`hunt 触发停轮条件（${decision.reason}），下一轮为确认轮`);
            pendingConfirm = true;
          }
          d.huntRound = r0; d.huntLastBig = lastBig; d.roundStats = roundStats; s.save();
          wakeups.push();   // 轮末唤醒：新 HYP 已落盘，消费侧立即开工
        }
        const sigmaEnd = fresh ? [] : [...(lastBig ? [`Σhunt1-${lastBig}`] : []),
          ...Array.from({ length: ((d.huntRound as number | undefined) ?? 0) - lastBig }, (_, i) => `Σhunt${lastBig + i + 1}`)];
        s0.mark(`hunt-end[init${sigmaEnd.length ? "," + sigmaEnd.join(",") : ""}][+${hypIds(ctx.workdir).length}HYP]`);
        await s0.execCommand("/coverage-record off");   // 关闭记录并落盘（09-20 解耦）
    };

    // ---- verify 消费（system/hyp 状态驱动；与 hunt 并行、事件驱动——fish 09-21「下游消费优先」）----
    out.push({ name: "chains", parallelGroup: "audit-loop", run: async (s) => {
      const sessionFile = (s.state.sessions as Record<string, string>).init;
      const registryMode = !!s.modelRegistry?.has("verify");
      const unwatch = registryMode ? () => undefined : ensureModelWatch();   // registry 模式由稳定 runtime 负责热切换；legacy 模式延续文件监听
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
                    ...(registryMode ? {} : { registerLive: (h: SessionHandle) => registerLive(h, () => "verify", modelSpecFor("verify")) }),
                    forkAtLabel: (label, newId) => {
                      if (!sessionFile) throw new Error("fork 失败：run 状态缺 init 会话文件");
                      const spec = registryMode ? undefined : modelSpecFor("verify");
                      return forkFromLabel({ ...ctx, runId: s.state.runId }, sessionFile, label, newId, {
                        agent: "hyp-chain",
                        binding: { hypId: c.id },
                        ...(spec ? { modelSpec: spec } : {}),
                        ...(registryMode ? { modelAgentKey: "verify" } : {}),
                      });
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
