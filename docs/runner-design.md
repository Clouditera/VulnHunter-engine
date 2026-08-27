# Runner 设计：程序化调度引擎（engine-rework）

> 2026-08-27 · 依据《08-引擎演进纲领》§二§三§四，fish 裁定：workflow 直接用 TS 代码实现，不搞 JSON/YAML 声明式定义；pi-subagents 下线；主会话从调度者退为媒介（定方向/参数）。

## 1. 定位

runner 是 engine/core 的一个 pi 扩展，把"审计流程"从 decide 的自由调度手里收回来，变成**可执行的 TS 代码**。主会话只负责与用户对话、确定任务方向和参数，然后调 `scan` 工具启动 workflow；之后主会话不再参与调度。

## 2. 核心抽象

### 2.1 workflow = 一个 TS 函数

`workflows/` 下每个文件导出一个 workflow：

```ts
// workflows/static-audit.ts
export default defineWorkflow({
  name: "static-audit",
  async run(ctx) {
    await ctx.node("onboard", { task: "初始化项目画像与漏洞认可口径" });
    // 认知循环：覆盖率驱动
    while (!(await ctx.coverageMet())) {
      await ctx.node("cognize", { task: ctx.nextUncovered() });
    }
    // hunt → verify 循环...
  },
});
```

- workflow 代码即流程：分支、循环、并行（`Promise.all`）、预算控制都是普通 TS，没有 DSL；
- 多 workflow 变体 = 多个文件（如 `static-audit.ts` / `full-audit.ts`（含动态验证）），由 scan 参数选择；
- 参考 pi-workflows 的图执行模型，但我们的"图"就是代码本身的控制流。

### 2.2 节点 = 进程内 SDK 会话

`ctx.node(agentName, opts)` 的实现（pi-subagents 的替代）：

- 用 pi SDK `createAgentSession()` **进程内**起隔离会话：
  - systemPrompt = `AGENTS.md`（基底，append 模式）+ `agents/<name>.md`（节点任务书）；
  - tools = 节点 frontmatter 的白名单（read/bash/write/...）；
  - model/thinking = settings 的 subagents 配置（含 agentOverrides）；
  - sessionManager = 每节点独立（可持久化到 sessions/ 供审查）；
  - 环境变量注入 `VULNFORGE_STAGE=<name>`（output-contract 契约依赖它）。
- 返回节点的最终输出文本 + 结构化结果；
- 超时/取消：AbortController 传入会话。

### 2.3 门禁 = 代码判定

- `ctx.coverageMet()`：读 scope.yaml + code-coverage 数据，行覆盖率达标 → true；
- workflow 的循环退出条件就是门禁本身，没有 nag、没有 report 验收阶段；
- 预算护栏：workflow 代码里显式写（如最大轮数、最大节点数），耗尽即收尾并输出缺口。

## 3. 与主会话的接口

- runner 注册 `scan` 工具：参数 = 启动参数（audit_scope / vuln_focus / sandbox_cfg / workflow 变体）；
- 主会话职责收敛为：对话 → mark_scope 确认范围 → 调 scan → 之后只回答用户提问、查询进度（`scan_status`）；
- scan 后台执行，进度事件以 steer 消息回到主会话（用户可见）；
- main-prompt 的调度话术整段退役（派发节、轮次、迁移规则），瘦身为"媒介职责"。

## 4. 退役清单（runner 验收后执行）

| 件 | 处置 |
|---|---|
| pi-subagents 扩展 | 删除（最大外部依赖消除） |
| audit-lifecycle | 删除（nag 钩子 + report 门禁） |
| report 节点 | 删除（报告=按需查询产物，非流水线阶段） |
| main-prompt 调度节 | 瘦身（见 §3） |
| agents/*.md | 保留（节点任务书仍是 workflow 的 systemPrompt 来源） |

## 5. 里程碑

1. **M1 骨架**：runner 扩展能加载 workflow，`ctx.node()` 用 SDK 起一个真会话并拿回输出（拿 cognize 单节点冒烟）；
2. **M2 首个 workflow**：static-audit 全链（onboard → cognize 循环 → hunt/verify 循环 → 覆盖率门禁收尾），mini 项目端到端；
3. **M3 门禁接线**：scope.yaml 行覆盖率判定 + 预算护栏；
4. **M4 退役**：pi-subagents / audit-lifecycle / report 摘除，main-prompt 瘦身，grok-build 全量验证。
