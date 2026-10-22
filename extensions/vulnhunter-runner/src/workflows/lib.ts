/**
 * workflow 共享编排件。
 *
 * 现役只有一件：runHypChain——单条 HYP 的研判链（sv/dv [+ev] 同会话串行）。
 * 沙箱＝资源维度（非池，fish 09-21）：dynamic verify 与 ev 段过沙箱闸（acquireSandbox 嵌套 acquire）。
 * 派发/办结由编排层（audit-lite chains 阶段）负责：本函数只执行链本身，失败直接抛、由编排层重派。
 * （旧队列机制随工具重构删除，fish 09-20；产物读写全部走 hyp/finding/sandbox 工具。）
 */

import { buildPrompt, type SessionHandle, type SessionCtx } from "../session.ts";
import { hypIds, readHyp } from "../tools/hyp.ts";
import { readFinding } from "../tools/finding.ts";
import { readSandboxState } from "../tools/sandbox.ts";
import { isDynamic } from "../params.ts";

export interface LibCtx extends SessionCtx {
  report(message: string): void;
}

// ---------------------------------------------------------------------------
// runHypChain：单条 HYP 的 verify→poc→ev 同会话链
// ---------------------------------------------------------------------------

export interface HypChainOpts {
  /** 是否启动动态环节（dynamic-verify/ev-assess）；默认按 isDynamic(params) */
  dynamic?: boolean;
  /** fork 点标记（默认 verify-start；轻量版传出生轮 huntN-done 前缀匹配） */
  forkPoint?: string;
  /** 链会话启动成分描述（如 Σ(init,h1,h2)）；缺省 Σ(init..出生轮) */
  birthIngredients?: string;
  /** 沙箱约束入口（资源维度，非池；嵌套 acquire 继承外层模型许可；并发=沙箱数） */
  acquireSandbox?: <T>(fn: () => Promise<T>, tag: string) => Promise<T>;
  /** 链会话登记（运行中模型热切换等）；返回注销函数 */
  registerLive?: (h: SessionHandle) => () => void;
  /** 从 init 会话文件的标记处分叉（并行安全：每次从磁盘重读，见 session.forkFromLabel） */
  forkAtLabel: (label: string, newId: string) => Promise<SessionHandle>;
}

/** fork 互斥：并发链从同一 init 会话分叉时串行化（goto+fork 是树操作，很快） */
let forkLock: Promise<void> = Promise.resolve();

function lockFork(): Promise<() => void> {
  return new Promise((resolve) => {
    forkLock = forkLock.then(() => new Promise<void>((r) => resolve(() => r())));
  });
}

export async function runHypChain(ctx: LibCtx, hypId: string, opts: HypChainOpts): Promise<void> {
  const dynamicMode = opts.dynamic ?? isDynamic(ctx.params);
  const bugId = hypId.replace(/^HYP-/, "BUG-");

  // 从出生轮末梢 fork 出该 HYP 的独立会话（继承 hunt 各轮摘要）
  const forkAt = opts.forkPoint ?? "verify-start";
  const hypShort = hypId.replace(/^HYP-/, "");           // hunt1-H2
  const hm = forkAt.match(/hunt(\d+)/);
  const roundShort = hm ? `h${hm[1]}` : forkAt;            // huntN→hN；research-done 等原样
  const unlock = await lockFork();
  let chain: SessionHandle;
  try {
    // fork 自会话文件上的标记（每次从磁盘重读；并行模式下 hunt 仍在追加，旧 handle 看不到新标记——fish 09-21）
    chain = await opts.forkAtLabel(forkAt, `init/${roundShort}/chain-${hypId}`);
  } finally { unlock(); }
  const unregister = opts.registerLive?.(chain);

  try {
    // 启动引导式树摘要（fish 09-10）：init→出生轮 huntN-done 全程覆盖压缩，HYP 正文做相关性过滤
    const hypBody = (readHyp(ctx.workdir, hypId)?.body ?? "").slice(0, 4000);
    try {
      await chain.summarizeTo("init", {
        summaryLabel: `Σ(init..${roundShort})·${hypShort}`,
        guide: `本次摘要服务于后续对这条 HYP 的研判。研判对象全文：\n${hypBody}\n与它相关的代码细节、锚点与推理重点保留；无关的代码区域与过程丢弃。另外保留：此前各轮 hunt 产出的全部 HYP 编号+一句话主张清单；产物操作约定（hyp/finding 工具，编号自动分配）。`,
      });
    } catch (e) { ctx.report(`${hypId} 启动摘要跳过（${String(e).slice(0, 60)}）`); }
    const ing = opts.birthIngredients ?? `Σ(init..${roundShort})`;
    // 有沙箱 → dynamic-verify（研判+复现合并）；无沙箱 → static-verify（纯静态裁决，fish 09-10）
    const stageCode = dynamicMode ? "dv" : "sv";
    const book = dynamicMode ? "dynamic-verify" : "static-verify";
    const runVerdict = () => chain.prompt(buildPrompt(ctx, book, `${book} 任务，研判风险假设的成立性。`, `风险假设：${hypId}（正文与裁决记录在 system/hyp/${hypId}.json，用 hyp({op:"get", id:"${hypId}"}) 读取）`),
      { start: `${stageCode}(${hypShort})-start[${ing}]`, label: `${stageCode}(${hypShort})` });
    // dynamic verify 受沙箱数限（fish 09-21）：动态模式整段过沙箱闸（嵌套 acquire）；static verify 不受限
    const r = dynamicMode && opts.acquireSandbox
      ? await opts.acquireSandbox(runVerdict, `${hypId}·dv`)
      : await runVerdict();
    if (r.aborted) throw new Error("API 不可用");   // 交编排层重派
    if (!readFinding(ctx.workdir, bugId)) {
      chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+refuted]`);
      ctx.report(`裁决：${hypId} → refuted`);
      return;
    }
    chain.mark(`${stageCode}(${hypShort})-done[${ing},${stageCode}(${hypShort})][+BUG-${hypShort}·confirmed]`);
    ctx.report(`裁决：${hypId} → confirmed（finding 已产出）`);

    // skip_ev：显式跳过 ev-assess 环节（只跑 verify 链、不做影响评估）
    if (dynamicMode && !ctx.params.skip_ev) {
      const st = readSandboxState(ctx.workdir);
      if (st.status !== "available") {
        // fail-closed + 可见：沙箱不可用/状态缺失时明确报告，绝不静默跳过（09-17 ev 静默缺陷收口）
        ctx.report(`${hypId}：ev-assess 跳过（sandbox=${st.status}${st.status === "unknown" ? "——沙箱状态缺失，检查 build/动态链是否回报 sandbox 工具" : ""}）`);
      } else {
        const runEv = async () => {
          // dynamic-verify 已含复现；这里只判 ev 门槛（poc reproduced 且 exp pending）后接 ev-assess
          const rec = readFinding(ctx.workdir, bugId);
          if (rec && rec.poc_status === "reproduced" && rec.exp_status === "pending") {
            const r3 = await chain.prompt(buildPrompt(ctx, "ev-assess", "ev-assess 任务，评估 finding 在真实业务场景下的影响。", `目标 finding：${bugId}（findings/${bugId}/record.json，用 finding({op:"get", id:"${bugId}"}) 读取）`),
              { start: `ev(${hypShort})-start[${ing},${stageCode}(${hypShort}),finding]`, label: `ev(${hypShort})` });
            if (!r3.aborted) chain.mark(`ev(${hypShort})-done[Σ,${stageCode}(${hypShort}),ev(${hypShort})][+EV 已评]`);
            else ctx.report(`${hypId}：ev-assess API 中止`);
          }
        };
        // ev 段同样受沙箱闸（嵌套 acquire；继承外层许可）
        await (opts.acquireSandbox ? opts.acquireSandbox(runEv, `${hypId}·ev`) : runEv());
      }
    }
  } finally {
    chain.close();
    unregister?.();
  }
}

// ---------------------------------------------------------------------------
// 并行消费件（fish 09-21）：选举 + 唤醒队列 + 常驻消费者——hunt ∥ verify
// ---------------------------------------------------------------------------

export interface VerifyCandidate { id: string; fork: string; ing: string; source: "hunt" | "research"; }

/** 电选：盘上「未办结、未产出 finding」的 HYP（幂等；chain_filter 每轮前 K 条） */
export function electVerifyCandidates(
  ctx: { workdir: string; report(msg: string): void },
  data: Record<string, unknown>,
  opts: { chainK?: number; includeResearch?: boolean } = {},
): VerifyCandidate[] {
  const chainK = opts.chainK ?? Infinity;
  const roundHyps = (data.roundHyps ?? {}) as Record<string, string[]>;
  const roundSigma = (data.roundSigma ?? {}) as Record<string, string[]>;
  const out: VerifyCandidate[] = [];
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
      out.push({ id, fork: `${rn}-done`, ing, source: "hunt" });
    }
  }
  if (opts.includeResearch) {
    const researchIds = hypIds(ctx.workdir).filter((idd) => (readHyp(ctx.workdir, idd)?.tag ?? "").startsWith("research"));
    for (const id of researchIds.slice(0, chainK)) {
      const rec = readHyp(ctx.workdir, id);
      if (!rec) continue;
      if (rec.status === "closed" || rec.conclusion === "refuted") continue;
      if (readFinding(ctx.workdir, id.replace(/^HYP-/, "BUG-"))) continue;
      if (out.some((e2) => e2.id === id)) continue;
      // fork 自 hunt-end（压缩后的安全点；research-done 在压缩区间内，fork 会丢 Σ(init) 摘要——replay 实踩）
      out.push({ id, fork: "hunt-end", ing: "Σ(init)", source: "research" });
    }
  }
  return out;
}

/** 计数信号量式唤醒队列：push 不会丢（无等待者时记账，下次 pop 立即返回） */
export interface WakeQueue { push(): void; pop(): Promise<void>; }
export function createWakeQueue(): WakeQueue {
  let pending = 0;
  const waiters: Array<() => void> = [];
  return {
    push(): void { const w = waiters.shift(); if (w) w(); else pending++; },
    pop(): Promise<void> { if (pending > 0) { pending--; return Promise.resolve(); } return new Promise<void>((r) => waiters.push(r)); },
  };
}

export interface VerifyConsumerHooks {
  /** 当前盘上可启动的（含来源规则过滤；消费函数自行排除在飞） */
  candidates(): VerifyCandidate[];
  markRunning(ids: string[]): void;
  /** 跑一条（含重试）；done=成功 / stopped=放弃留待下次 */
  runOne(c: VerifyCandidate): Promise<"done" | "stopped">;
  slotsFree(): number;
  settled(): boolean;
  wakeup(): Promise<void>;
  /** 任务完成时由消费者内部调用：唤醒主循环重查（否则只能等下一条外部事件，会卡死） */
  notify(): void;
  report(msg: string): void;
}

/** 常驻消费者：有空槽就派、被事件唤醒就查、收干且上游落定才退（外层 while 事件循环） */
export async function runVerifyConsumer(h: VerifyConsumerHooks): Promise<{ dispatched: number; done: number; stopped: number }> {
  const inflight = new Set<string>();
  const attempted = new Set<string>();   // 本 run 内已派过的：done 后回写延迟也不重派；stopped 留待下次运行（同停派语义）
  let dispatched = 0, done = 0, stopped = 0;
  for (;;) {
    const ready = h.candidates().filter((c) => !attempted.has(c.id) && !inflight.has(c.id));
    while (h.slotsFree() > 0 && ready.length > 0) {
      const c = ready.shift()!;
      inflight.add(c.id);
      attempted.add(c.id);
      dispatched++;
      h.markRunning([c.id]);
      void h.runOne(c)
        .then((r) => { if (r === "done") done++; else stopped++; })
        .catch((e) => { stopped++; h.report(`verify 异常未捕获：${c.id} ${String(e).slice(0, 120)}`); })
        .finally(() => { inflight.delete(c.id); h.notify(); });
    }
    if (h.settled() && inflight.size === 0 && h.candidates().filter((c) => !attempted.has(c.id)).length === 0) break;
    await h.wakeup();
  }
  return { dispatched, done, stopped };
}
