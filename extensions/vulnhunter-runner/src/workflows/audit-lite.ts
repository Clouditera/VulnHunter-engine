/**
 * audit-lite：轻量 workflow（第一档 <1万行），阶段化定稿版（fish 09-09）。
 *
 * 阶段表：onboard → build → research → compress（压缩跳转）→ hunt1..N（分支往返）
 *         → chains（HYP 链扇出，fork 自出生轮末梢+启动 compact）→ exp（有沙箱时）
 *
 * 断点/单步：runtime.runStages 驱动，--from <阶段> 续跑、--only <阶段> 单步重试。
 * 标记语法：docs/session-marks.md（<任务>-start[成分] / <任务>-done[成分][+产出]，Σ=已摘要）。
 *
 * 参数（ctx.params）：rounds（默认 3）/ chain_filter（每轮前 K 条跑链，默认全部）。
 */

import { defineStagedWorkflow, runStages, type StageCtx, type StageDef, type WorkflowContext } from "../runtime.ts";
import { Pool } from "../pools.ts";
import { runHypChain } from "./lib.ts";
import { buildPrompt } from "../session.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPACT_INIT = "保留：项目画像与威胁模型要点、构建部署要点、关键代码区域与行号、漏洞认可口径、检索到的情报结论。丢弃：过程性输出与重复细节。摘要正文控制在 4000 字以内。";
const COMPACT_ROUND = "只保留本轮新提出的 HYP 标题+一句话主张+关键锚点行号，以及读过的代码区域清单；丢弃推演过程。控制在 2000 字内。";

const hypFiles = (ctx: WorkflowContext) => readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith("HYP-"));
const advCount = (ctx: WorkflowContext) => readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith("ADV-")).length;

const liteWorkflow = defineStagedWorkflow({
  name: "audit-lite",
  description: "轻量 run（<1万行）：init 三段→压缩跳转→hunt 分支往返→HYP 链按出生轮 fork",

  stages(ctx) {
    const rounds = Number(ctx.params.rounds || "3");
    const chainK = ctx.params.chain_filter ? Number(ctx.params.chain_filter) : Infinity;
    const out: StageDef[] = [];

    // ---- init 三段 ----
    out.push({ name: "onboard", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" }, fresh: true });
      try {
        const r = await s0.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"),
          { start: "onboard-start[∅]", done: "onboard-done[on][+profiler]" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); }   // 关句柄不关文件；后续阶段按文件复活
    } });
    out.push({ name: "build", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
      try {
        const r = await s0.prompt(buildPrompt(ctx, "build", "build 任务，理解项目的构建与部署方式并落 build-state。"),
          { start: "build-start[on]", done: "build-done[on,bu][+build-state]" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { s0.close(); }
    } });
    out.push({ name: "research", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
      try {
        const before = advCount(ctx);
        const r = await s0.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径。"),
          { start: "research-start[on,bu]" });
        if (r.aborted) throw new Error("API 不可用");
        s0.mark(`research-done[on,bu,re][+ADV×${advCount(ctx) - before},wiki]`);
      } finally { s0.close(); }
    } });
    out.push({ name: "compress", run: async (s) => {
      const s0 = await s.openSession("init", "init-host", { binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
      try {
        await s0.summarizeTo("onboard-start", { summaryLabel: "init[Σ(on,bu,re)]", guide: COMPACT_INIT });
      } finally { s0.close(); }
    } });

    // ---- hunt 轮次（分支往返）----
    for (let r0 = 1; r0 <= rounds; r0++) {
      out.push({ name: `hunt${r0}`, run: async (s) => {
        const s0 = await s.openSession("init", "init-host", { binding: { advId: `hunt${r0}`, runNo: 1, advLine: "S" } });
        try {
          const rn = `hunt${r0}`, mine = `h${r0}`;
          const fresh = ctx.params.hunt_mode === "fresh";
          // fresh 模式没有轮间摘要，成分表不带 Σhunt*
          const sigmaPrev = fresh ? [] : Array.from({ length: r0 - 1 }, (_, i) => `Σhunt${i + 1}`);
          if (r0 === 1) s0.mark("hunt-start[init]");
          // fresh 模式（fish 09-11 双场景测试）：每轮从 init 重新开始，不继承任何 hunt 历史
          const freshRestart = fresh && r0 > 1;
          if (freshRestart) await s0.goto("init");
          s0.setBinding({ advId: rn });
          s0.setCoverage(true);
          const before = new Set(hypFiles(ctx));
          const angle = r0 === 1 ? "系统性通读范围内的代码，沿真实数据流挖掘" : r0 === 2 ? "换角度：边界条件、整数/长度运算、编码转换细节" : "换角度：跨函数状态组合、契约缝隙";
          // fresh 重开轮不打 start 标：goto 后叶子正是 init 锚点条目，pi 单条目单标签，
          // 此时打标会覆盖锚点标签，下一轮 goto("init") 必死（09-11 mem-b hunt3 实踩）
          const r = await s0.prompt(buildPrompt(ctx, "hunt", `hunt 任务（第 ${r0} 轮，共 ${rounds} 轮）。${angle}，尽可能挖掘风险假设（HYP），每条落到具体 file:line；与前几轮已提的重复不提。确认没有新东西就明说。`),
            freshRestart ? undefined : { start: `${rn}-start[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""}]` });
          if (r.aborted) throw new Error("API 不可用");
          const news = hypFiles(ctx).filter((f) => !before.has(f));
          (s.state.data.roundHyps ??= {})[rn] = news;
          s0.mark(`${rn}-done[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""},${mine}][+${news.length}HYP]`);
          // hunt 积累制（fish 09-10）：每 5 轮（含末轮，留下 Σ 检查点）或上下文占用 >75% 时整体摘要化；fresh 模式不摘要
          const pct = s0.contextPercent();
          if (ctx.params.hunt_mode !== "fresh" && (r0 % 5 === 0 || (pct !== null && pct > 75))) {
            ctx.report(`hunt 触发整体摘要（第 ${r0} 轮，占用 ${pct === null ? "未知" : pct.toFixed(0) + "%"}）`);
            await s0.summarizeTo("hunt-start", {
              summaryLabel: `Σhunt1-${r0}`,
              guide: "这是多轮 hunt（风险假设挖掘）的历史。保留：各轮产出的全部 HYP 编号+一句话主张+关键锚点；各轮读过的代码区域。",
            });
          }
          if (r0 === rounds) {
            s0.mark(`hunt-end[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""}][+${hypFiles(ctx).length}HYP]`);
          }
          s0.setCoverage(false);
        } finally { s0.close(); }
      } });
    }

    // ---- HYP 链（fork 自出生轮末梢 + 启动 compact；verify-only 当无沙箱）----
    out.push({ name: "chains", run: async (s) => {
      const init = await s.openSession("init", "init-host", { binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
      try {
        const verifyPool = new Pool("verify", 5);
        const sandboxPool = new Pool("sandbox", 1);
        const roundHyps = (s.state.data.roundHyps ?? {}) as Record<string, string[]>;
        const chains: Promise<void>[] = [];
        let idx = 0;
        for (const [rn, files] of Object.entries(roundHyps)) {
          const r0 = Number(rn.replace("hunt", ""));
          const sigmaPrev = Array.from({ length: r0 - 1 }, (_, i) => `Σhunt${i + 1}`);
          const ing = `Σ(init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""},h${r0})`;
          for (const f of files.slice(0, chainK)) {
            const hypId = f.replace(/\.md$/, "");
            const bugDir = join(ctx.workdir, "findings", hypId.replace(/^HYP-/, "BUG-"));
            if (existsSync(bugDir)) continue;   // 已裁决过（单步重试幂等）
            chains.push(runHypChain(ctx, init, f, { verifyPool, sandboxPool, forkPoint: `${rn}-done`, birthIngredients: ing }));
            idx++;
          }
        }
        await Promise.allSettled(chains);
        ctx.report(`chains 阶段：派发 ${idx} 条链`);
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
