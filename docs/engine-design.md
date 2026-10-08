# VulnHunter Engine 设计（现行）

> 2026-10-08 由 `runner-design.md`（9/2 定稿）与 `system-design.md`（8/27 定稿）合并整理，两篇原文已归档到 `docs/archive/`。
> 以代码为准；本文给出结构和不变量，细节看文中列出的源文件。平台侧如何使用引擎见 Community 仓 `docs/architecture.md`。

## 1. 定位

引擎是审计 workflow 的独立执行内核：
- 可脱离平台运行（`vf` 命令 + Pi TUI）；
- 也作为平台的编程入口（`@vulnhunter/engine-runner`，平台以 submodule 固定版本引入）。

平台身份、授权、Task 产品数据与部署不在引擎内。

## 2. 结构

```text
extensions/vulnhunter-runner/
  index.ts              Pi 扩展入口（独立使用时的工具与 TUI）
  src/api.ts            编程入口：createRunner()
  src/control.ts        WorkflowRunnerEngine：启动、等待、运行登记
  src/runtime.ts        workflow 原语：defineWorkflow / defineStagedWorkflow / runStages
  src/workflows/        registry.ts（唯一的已安装清单）、audit-lite.ts、lib.ts（编排件）
  src/session.ts        会话服务：SessionHandle
  src/executor/         并发执行器：容量、池、调度门
  src/nodes.ts          节点定义：每个节点的工具、技能、扩展
  src/tools/            对象工具：hyp、finding、sandbox、profiler
  src/agent-model.ts    模型运行时（平台 inline 快照 / 独立 CLI 本地配置）
  AGENTS.md             所有节点共用的基底提示词
  tasks/*.md            各节点任务书（纯散文）
  skills/               技能
  node-ext/             节点用到的扩展（代码覆盖率、pi-web-access）
```

## 3. workflow 与阶段

- 可执行的 workflow 只来自 `src/workflows/registry.ts` 的显式登记，不扫描目录。目前只有 `audit-lite`。
- 阶段化 workflow 用 `defineStagedWorkflow` 声明阶段表，由 `runStages` 驱动：
  - 每次运行在 `<目标>/.vulnforge/system/runs/<workflow>-<runId>.json` 记录各阶段状态（pending / done / failed / skipped）、会话文件、阶段错误；
  - `from` 断点续跑，`only` 单步重试；
  - 相邻同名 `parallelGroup` 的阶段并发执行（如 hunt ∥ verify 消费）。
- audit-lite 阶段：onboard → build → research → compress → hunt（单会话多轮）→ chains（每条 HYP 一条研判链）。研判链在提供 `sandbox_cfg` 时走 dynamic-verify，否则走 static-verify。参数和停轮条件见 `audit-lite.ts` 文件头。

## 4. 会话

`SessionHandle`（`session.ts`）是 workflow 操作会话的唯一方式：

- `prompt`：发送任务并等待完成，自动打起止标记、记台账；
- `mark` / `goto` / `summarizeTo` / `compact`：在会话树上打标记、回到标记点（可给离开的分支留摘要）、引导式摘要、压缩；
- `fork`：把当前路径提取为独立会话（并发研判链用），可换 agent 与工具绑定；
- `setModel` / `setResolvedModel`：运行中切换模型，下一次请求生效。

会话标记语法与编号规则见 `skills/vulnhunter/refs/runtime-layout.md`。

## 5. 提示词

- 节点的 systemPrompt = `tasks/<节点>.md`（任务书）+ `AGENTS.md`（基底）。
- 任务书只写身份、目标、工作方式、产出要求；工具、技能、扩展等机制配置在 `nodes.ts`，不写进任务书。
- 用户提示（任务正文）由 workflow 按固定模板机械组装，只填启动参数等机械值。

## 6. 并发执行器

`executor/` 是与业务无关的生产者-消费者基础设施：

- **容量**：命名许可池，是真正的闸门（如模型并行度、沙箱容量）；
- **池**：需求组织，由 workflow 声明，用于限流（audit-lite：init、hunt、verify 三池）；
- **调度门**：容量拥塞时下游优先、同级先来先服务，并有老化提升。

不变量：所有模型消费都经过容量门；成功、失败、中止都释放许可；等待关系严格单向嵌套，任意并行度都不会死锁。

## 7. 产物与工作区

- 工作区：`<目标>/.vulnforge/`。`knowledge/` 是唯一可自由读写的文档区；`findings/BUG-*/` 是漏洞出口；`system/` 是引擎内部状态（HYP、runs、sandbox、profiler、会话台账）。
- 结构化对象（HYP、finding、沙箱状态、项目画像）只能经对象工具（`src/tools/`）落盘，产物只增不删。
- 完整布局见 `skills/vulnhunter/refs/runtime-layout.md`；平台读取这些产物的契约见 Community 仓 `docs/modules/engine-artifacts.md`。

## 8. 模型

- 平台模式：`AgentModelRuntime` 的 inline 快照，每个池独立的内存 runtime；provider 实例 ID 只用于平台选择，Pi 的 provider 身份用 providerType。详见 `docs/model-control.md`。
- 独立 CLI：本地 `settings.json` / `models.json`，与平台隔离。

## 9. 与平台目标架构的差距

按平台的目标架构（Community `docs/architecture.md` §3.3），以后需要：
- 每个 workflow 提供机器可读的声明：参数格式、runner 运行环境、需要的附加沙箱、产出文件；
- 统一的生命周期状态、取消与产物位置约定；
- 沙箱以参数交给 runner，agent 用统一沙箱工具操作。

这些属于任务模块重构，尚未实现。
