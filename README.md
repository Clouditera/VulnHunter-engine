# VulnHunter Engine

审计 workflow 的独立执行内核，同时提供 pi 扩展入口与平台编程入口。平台身份、授权、Task 产品数据与部署不在此仓。

## 开发说明（必读）

动手写代码或评审之前，阅读并**遵循**以下文档；与之冲突的实现不予合并。注意 `extensions/vulnhunter-runner/AGENTS.md` 是审计节点的基底提示词，不是开发说明。

文档：

- [docs/engine-design.md](docs/engine-design.md)：现行引擎设计（结构、阶段、会话、执行器、产物）。
- [docs/workflow-authoring.md](docs/workflow-authoring.md)：编写新 workflow。
- [docs/model-control.md](docs/model-control.md)：模型控制面。
- [docs/archive/](docs/archive/)：历史设计，只读，不能作为实现依据。
- 平台整体架构原则：Community 仓 `docs/architecture.md` 与其 README 的开发说明。

规则：

1. **引擎独立于平台**：不引用平台代码、不访问平台数据库、不处理平台身份与授权；平台需要的能力通过编程入口和机器可读声明提供。
2. **workflow 显式登记**在 `src/workflows/registry.ts`；workflow 只编排，不实现机制（见 workflow-authoring.md）。
3. **结构化产物只经对象工具落盘**；产物只增不删。
4. **模型消费一律经执行器容量门**，许可在成功、失败、中止时都释放。
5. **Pi SDK 是唯一 agent 框架**，不做 adapter。
6. 单个源码文件不超过 500 行；不留没有上下文的 `TODO`；密钥不进代码和日志。
7. 改动后在仓根跑 `pnpm typecheck`，runner 测试在 `extensions/vulnhunter-runner` 下跑 `pnpm test`。
8. 平台以 submodule 固定本仓版本，升级顺序 Engine → Community → Enterprise。

## 安装

Node 22.22+，pnpm 11.18.0。递归初始化子模块后，在仓根执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

仓根 workspace 统一安装 runner 和节点的 pi-web-access 依赖；不再依赖全局 pi、工作站 node_modules 软链接或分目录 npm install。

## 编程入口

```ts
import { createRunner } from '@vulnhunter/engine-runner';

const runner = createRunner({ engineDir: '/path/to/engine' });
const run = await runner.start({
  workflow: 'audit-lite',
  target: '/path/to/project',
  params: { rounds: '1' },
  // agents: 每个 agent 的模型与凭证配置；见 docs/model-control.md
});
const result = await runner.wait(run.runId);
```

包入口只暴露 Runner API，不注册聊天工具、不启动控制端口。引擎目前仍用文件 checkpoint 和进程内运行登记；这不是平台持久化 Task 服务，不能将它等同于用户侧任务数据库。

`close()` 等待已开始工作结束，不是取消。工作流续跑能力仍由阶段执行接口提供；平台级统一取消/恢复契约属于任务执行改造，不在包入口整理中假装已完成。

## 独立 pi 使用

配置 `models.json`/`settings.json`（见 example），凭证保留在本地，随后从目标代码目录调用仓库的 `vf`。它执行仓内安装的 pi，并通过此仓 agentDir 装载扩展。

- `extensions/vulnhunter-runner/index.ts`：pi 工具与 TUI 入口。
- `extensions/vulnhunter-runner/src/api.ts`：平台编程入口。
- `src/workflows/registry.ts`：唯一的已安装 workflow 清单；不扫描目录猜测可执行工作流。
- `src/runtime.ts` / `session.ts` / `executor/`：阶段、会话与调度。
- `tasks/`、`skills/`、`node-ext/`：执行所需资源；平台镜像必须连同源码/编译产物一起包含，不能只复制 API 文件。

## 包与嵌入方式

包名：`@vulnhunter/engine-runner`（private，不发 npm）。Community/Enterprise 用 submodule 固定本仓提交，并在自己的 pnpm workspace 中包含 runner 和节点扩展目录；以 `workspace:*` 建依赖，不穿透相对路径引用 `src/`。

当前 exports：默认 Runner/模型会话 API、`/workflow` 阶段编排 API、`/extension` pi 工具入口、`/model-provider` 原生内存 provider 适配及 `/package.json`。平台显式装配扩展；此处不改变现有任务启动、阶段调度和 Task/Run 归属。

独立 TUI 的 HTTP 观察界面与会话 HTML 渲染分别放在 `web.ts`、`monitor-page.ts`、`monitor-session.ts`，不混在执行 API 中。API 本身不要求启动任何观察服务。

## 平台模型配置

平台使用 `AgentModelRuntime` 的 `inline` 快照：provider 实例 ID、providerType、多个模型定义、内存凭证及精确选择。记录 ID 只在平台选择/授权中使用；Pi 的 Provider.id、Model.provider 和认证索引使用 providerType（如 zai）。每个 agent 的独立内存 runtime 只注册它所选记录，同类型多账号不在同一 Pi registry 中混放。原生 Pi provider 直接消费 key/headers 字符串，不经过 `models.json` 的表达式解释器。

装配 `/extension` 时显式提供 `getModelSnapshot`，使 init/hunt/verify 从同一个已提交父快照建立独立 SDK runtime。后续主对话配置不会无意改动已开始任务；任务模型变更走自己的 registry。`.vulnforge/system/model.json` 只记录任务的模型选择引用，绝不是 provider/凭证来源。独立 CLI 的本地配置入口仍与平台隔离。

子会话的设置保留 Pi 的 global/project 合并规则，但 SDK 更新默认选择时只写内存。分支摘要使用所属会话的 SDK runtime、模型和思考档，保留原来的闭区间、挂载位置、摘要结构和 32768 输出预算，不再读 key 文件或强制开启思考。所有明确的模型/思考选择均检查 SDK 实际值，不允许静默代选或降档。
