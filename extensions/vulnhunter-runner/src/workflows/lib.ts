/**
 * workflow 共享编排件。
 *
 * 现役只有一件：runHypChain——单条 HYP 的研判链（sv/dv [+ev] 同会话串行）。
 * 派发/办结由编排层的队列（executor serve）负责：本函数只执行链本身，失败直接抛、由队列退回。
 * （旧编排件 runInit / runHuntRounds / runExpBuild 等已随执行器接线删除，fish 09-15。）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolHandle } from "../executor/index.ts";
import { buildPrompt, type SessionHandle, type SessionCtx } from "../session.ts";

/** 读 build.md 的 sandbox 状态（动态门禁依据；随旧 state.ts 删除并入本文件） */
function readSandboxState(workdir: string): "available" | "unavailable" | "unknown" {
  const p = join(workdir, "knowledge", "build", "build.md");
  if (!existsSync(p)) return "unknown";
  const m = readFileSync(p, "utf-8").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "unknown";
  const s = m[1].match(/sandbox:\s*(\S+)/);
  return s?.[1] === "available" ? "available" : s?.[1] === "unavailable" ? "unavailable" : "unknown";
}

export interface LibCtx extends SessionCtx {
  report(message: string): void;
}

// ---------------------------------------------------------------------------
// runHypChain：单条 HYP 的 verify→poc→ev 同会话链
// ---------------------------------------------------------------------------

export interface HypChainOpts {
  /** 是否启动动态环节（dynamic-verify/ev-assess）；默认按 sandbox_cfg 有无 */
  dynamic?: boolean;
  /** fork 点标记（默认 verify-start；轻量版传出生轮 huntN-done 前缀匹配） */
  forkPoint?: string;
  /** 链会话启动成分描述（如 Σ(init,h1,h2)）；缺省 Σ(init..出生轮) */
  birthIngredients?: string;
  /** 沙箱池句柄（workflow 声明；嵌套提交自动继承外层容量） */
  sandboxPool: PoolHandle;
}

/** fork 互斥：并发链从同一 init 会话分叉时串行化（goto+fork 是树操作，很快） */
let forkLock: Promise<void> = Promise.resolve();

function lockFork(): Promise<() => void> {
  return new Promise((resolve) => {
    forkLock = forkLock.then(() => new Promise<void>((r) => resolve(() => r())));
  });
}

export async function runHypChain(ctx: LibCtx, init: SessionHandle, hypFile: string, opts: HypChainOpts): Promise<void> {
  const hypId = hypFile.replace(/\.md$/, "");
  const dynamicMode = opts.dynamic ?? !!ctx.params.sandbox_cfg;
  const bugDir = join(ctx.workdir, "findings", hypId.replace(/^HYP-/, "BUG-"));

  // 从出生轮末梢 fork 出该 HYP 的独立会话（继承 hunt 各轮摘要）
  const forkAt = opts.forkPoint ?? "verify-start";
  const hypShort = hypId.replace(/^HYP-/, "");           // hunt1-H2
  const roundShort = (forkAt.match(/hunt(\d+)/) ? `h${forkAt.match(/hunt(\d+)/)![1]}` : undefined) ?? "verify-start";
  const unlock = await lockFork();
  let chain: SessionHandle;
  try {
    await init.goto(forkAt);   // 精确标记匹配（huntN-done 标记全名带成分表，goto 用前缀查）
    chain = await init.fork(`init/${roundShort}/chain-${hypId}`, "hyp-chain", { hypId });
  } finally { unlock(); }

  try {
    // 启动引导式树摘要（fish 09-10）：init→出生轮 huntN-done 全程覆盖压缩，HYP 正文做相关性过滤
    const hypBody = readFileSync(join(ctx.workdir, "todo", hypFile), "utf-8").slice(0, 4000);
    try {
      await chain.summarizeTo("init", {
        summaryLabel: `Σ(init..${roundShort})·${hypShort}`,
        guide: `本次摘要服务于后续对这条 HYP 的研判。研判对象全文：\n${hypBody}\n与它相关的代码细节、锚点与推理重点保留；无关的代码区域与过程丢弃。另外保留：此前各轮 hunt 产出的全部 HYP 编号+一句话主张清单；产物操作约定（artifact 工具，编号自动分配）。`,
      });
    } catch (e) { ctx.report(`${hypId} 启动摘要跳过（${String(e).slice(0, 60)}）`); }
    const ing = opts.birthIngredients ?? `Σ(init..${roundShort})`;
    // 有沙箱 → dynamic-verify（研判+复现合并）；无沙箱 → static-verify（纯静态裁决，fish 09-10）
    const stageCode = dynamicMode ? "dv" : "sv";
    const book = dynamicMode ? "dynamic-verify" : "static-verify";
    const r = await chain.prompt(buildPrompt(ctx, book, `${book} 任务，研判风险假设的成立性。`, `风险假设：${ctx.workdir}/todo/${hypFile}`),
      { start: `${stageCode}(${hypShort})-start[${ing}]`, label: `${stageCode}(${hypShort})` });
    if (r.aborted) throw new Error("API 不可用");   // 交队列退回（serve onError=requeue）
    if (!existsSync(bugDir)) {
      chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+refuted]`);
      ctx.report(`裁决：${hypId} → refuted`);
      return;   // 正常返回 = 队列 ack（→ done/）
    }
    chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+BUG-${hypShort}·confirmed]`);
    ctx.report(`裁决：${hypId} → confirmed（finding 已产出）`);

    if (dynamicMode && readSandboxState(ctx.workdir) === "available") {
      await opts.sandboxPool.submit(async () => {
        const target = `findings/${hypId.replace(/^HYP-/, "BUG-")}/report.yaml`;
        // dynamic-verify 已含复现；这里只判 ev 门槛（poc reproduced 且 exp pending）后接 ev-assess
        const rp = join(bugDir, "report.yaml");
        const txt = existsSync(rp) ? readFileSync(rp, "utf-8") : "";
        if (/poc_status:\s*reproduced/.test(txt) && /exp_status:\s*pending/.test(txt)) {
          const r3 = await chain.prompt(buildPrompt(ctx, "ev-assess", "ev-assess 任务，评估 finding 在真实业务场景下的影响。", `目标 finding：${target}`),
            { start: `ev(${hypShort})-start[${ing},${stageCode}(${hypShort}),finding]`, label: `ev(${hypShort})` });
          if (!r3.aborted) chain.mark(`ev(${hypShort})-done[Σ,${stageCode}(${hypShort}),ev(${hypShort})][+EV 已评]`);
          else ctx.report(`${hypId}：ev-assess API 中止`);
        }
      }, { tag: `${hypId}·ev` });
    }
  } finally {
    chain.close();
  }
}
