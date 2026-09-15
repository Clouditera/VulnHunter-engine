# 编写新 workflow（供外层 agent 现场编排）

workflow = 一个导出 `defineWorkflow({ name, description, run })`（或 `defineStagedWorkflow({ name, description, stages })`，注册表会自动适配）的 TS 文件，放在 `workflows/` 下，并在 `src/workflows/index.ts` 注册表里加一行 `staged(xxx)`（或 `xxx`）——加载经静态 import 走 pi 宿主的 jiti，与扩展本体同一机制；漏注册 = 该 workflow 不可用（HALL-47 后目录不再热扫描）。之后即可 `scan({workflow: "<name>", params})` 启动。

## 规则

1. **编排，不实现机制**：只能用 `workflows/lib.ts` 的编排件 + `ctx`。禁止在 workflow 里写工具/会话/解析逻辑——能力不够就提需求，不在文件里造轮子；
2. **会话操作只经 SessionHandle 六动词**：`prompt / mark / compact / goto / fork / close`。mark 纯打标记，compact 独立，消费方式你定；
3. **队列流转只经 queue.ts**：`pending/toTodo/toDone/backToLeads`（幂等，agent 手动动过文件也不崩）；
4. **每个 ctx.report() 都是用户可见的进度**，关键节点报一声；
5. **异常即停**：任何编排件返回 aborted/null 就 return，不硬撑。

## 模板

```ts
import { defineWorkflow } from "../extensions/runner/runtime.ts";
import { Pool } from "../extensions/runner/pools.ts";
import { pending } from "../extensions/runner/queue.ts";
import { runInit, runHuntRounds, runHypChain, runExpBuild } from "./lib.ts";

export default defineWorkflow({
  name: "my-run",
  description: "一句话说明",
  async run(ctx) {
    const init = await runInit(ctx);                    // init-session（onboard→research 同会话）
    if (!init) return;

    if (!(await runHuntRounds(ctx, init, { maxRounds: 4 }))) { init.close(); return; }

    const verifyPool = new Pool("verify", 5);
    const sandboxPool = new Pool("sandbox", 1);
    const chains = pending(ctx.workdir, "HYP").map((f) =>
      runHypChain(ctx, init, f, { verifyPool, sandboxPool, dynamic: !!ctx.params.sandbox_cfg }));
    await Promise.allSettled(chains);

    if (ctx.params.sandbox_cfg) await runExpBuild(ctx, init);
    init.close();
  },
});
```

## 可用编排件（workflows/lib.ts）

| 编排件 | 做什么 |
|---|---|
| `runInit(ctx)` | onboard→research 同会话 → compact → mark("init")，返回 init-session handle（幂等：已初始化则复活） |
| `runHuntRounds(ctx, init, opts)` | 分支往返多轮 hunt；停止：maxRounds（默认按代码行数推）/ 一轮零新 HYP / 覆盖达标 |
| `runHypChain(ctx, init, hypFile, opts)` | 从 "verify-start" fork 独立会话，verify→poc→ev 同会话跑完；verify 池并发、沙箱池串行 |
| `runExpBuild(ctx, init)` | fork 自 init 的 exp-build，无新 exploits 即停 |

池：`new Pool(name, maxConcurrent)`，`pool.run(fn)`。队列：`pending(workdir, "ADV"|"HYP"|"LEAD")`。
