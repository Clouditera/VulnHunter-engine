# 编写新 workflow

> 2026-10-08 按现行代码重写（原版写的是“放进 workflows/ 目录即可被发现”、队列文件流转等，均已退役）。整体设计见 [engine-design.md](engine-design.md)。

## 步骤

1. 在 `extensions/vulnhunter-runner/src/workflows/` 新建 `<name>.ts`，用 `defineStagedWorkflow` 声明阶段表。
2. 导出一个调用 `runStages` 的 `run` 函数（照 `audit-lite.ts` 末尾的写法），并在 `src/workflows/registry.ts` 登记。**只有登记过的 workflow 可执行**，不扫描目录。
3. 需要新节点时：在 `tasks/<节点>.md` 写任务书（纯散文），在 `src/nodes.ts` 配置该节点的工具、技能和扩展。
4. 写对应测试（`extensions/vulnhunter-runner/tests/*.spec.mjs`，在该目录跑 `pnpm test`），并在仓根跑 `pnpm typecheck`。

## 骨架

参考 `audit-lite.ts`，最小形态如下（示意）：

```ts
import { defineStagedWorkflow, type StageDef } from "../runtime.ts";
import { createExecutor } from "../executor/index.ts";
import { buildPrompt } from "../session.ts";

export default defineStagedWorkflow({
  name: "my-workflow",
  description: "一句话说明",
  stages(ctx) {
    const exec = createExecutor();
    exec.bindCapacity("model", { permits: 3 });
    const pool = exec.declarePool("main", { concurrency: 1, needs: ["model"] });

    const stages: StageDef[] = [];
    stages.push({ name: "step1", run: async (s) => {
      const h = await s.openSession("main", "<节点名>", { fresh: true });
      try {
        const r = await pool.submit(() => h.prompt(buildPrompt(ctx, "<节点名>", "<一句任务说明>")), { tag: "step1" });
        if (r.aborted) throw new Error("API 不可用");
      } finally { h.close(); }
    } });
    return stages;
  },
});
```

## 规则

1. **只编排，不实现机制**：workflow 只组合阶段、会话和执行器；工具、会话、解析逻辑不写在 workflow 文件里，能力不够就补到引擎公共模块。
2. **会话只经 `SessionHandle`**：`prompt / mark / goto / summarizeTo / compact / fork` 等，见 `session.ts`。
3. **模型消费一律经执行器**：会话请求放进池的 `submit`，需要沙箱的步骤再经沙箱容量 `acquire`；不绕过容量门。
4. **结构化产物只经对象工具落盘**（hyp、finding、sandbox、profiler），workflow 读文件判断结果，不解析模型输出文本。
5. **关键节点 `ctx.report()`**，那是用户可见的进度。
6. **异常即停**：会话返回 `aborted` 或阶段出错就结束该阶段，由 `runStages` 记录失败，之后可用 `from` / `only` 续跑或重试。

## 参数与模型

- 启动参数在 `ctx.params`，在文件头注释写清每个参数的含义和默认值。
- 平台模式下模型由 `ctx.modelRegistry` 按池提供（打开会话时传 `modelAgentKey`），独立 CLI 下读本地配置；做法参照 `audit-lite.ts`。
