/**
 * audit-direct：最简 run（fish 09-04 设计）。
 *
 * 流程：init（onboard→research 同会话）→ hunt 多轮（分支往返）→
 *       每条 HYP 的 verify→poc→ev 同会话链（verify 池并发、沙箱池串行）→ exp-build 收尾。
 *
 * 适用：小体量项目（外层 agent 按代码量选择本 run，workflow 内不做规模路由）。
 */

import { defineWorkflow } from "../extensions/runner/runtime.ts";
import { Pool } from "../extensions/runner/pools.ts";
import { pending } from "../extensions/runner/queue.ts";
import { runInit, runHuntRounds, runHypChain } from "./lib.ts";

export default defineWorkflow({
  name: "audit-direct",
  description: "最简 run：init 会话 → hunt 多轮（分支往返）→ HYP 链（verify 池+沙箱池）→ exp-build",
  async run(ctx) {
    const init = await runInit(ctx);
    if (!init) return;

    if (!(await runHuntRounds(ctx, init))) { init.close(); return; }

    // HYP 链：verify 池并发 5、沙箱池 1（无沙箱依赖的 verify 不受并发限制，fish 09-04）
    const verifyPool = new Pool("verify", 5);
    const sandboxPool = new Pool("sandbox", 1);
    const chains: Promise<void>[] = [];
    for (const hypFile of pending(ctx.workdir, "HYP")) {
      chains.push(runHypChain(ctx, init, hypFile, { verifyPool, sandboxPool }));
    }
    await Promise.allSettled(chains);

    // exp-build 已从所有 workflow 移除（fish 09-10：初始会话怎么准备还没想好，想好再恢复）

    const findings = (() => { try { return pending(ctx.workdir, "HYP").length; } catch { return 0; } })();
    ctx.report(`audit-direct 结束（剩余未消费 HYP：${findings}）`);
    init.close();
  },
});
