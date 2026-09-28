# VulnHunter Engine

审计 workflow 的独立执行内核，同时提供 pi 扩展入口与平台编程入口。平台身份、授权、Task 产品数据与部署不在此仓。

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

当前 exports：默认 Runner API、`/workflow` 阶段编排 API、`/extension` pi 工具入口、`/package.json`。平台对话角色不得自动加载 `/extension` 来绕过平台任务启动入口。

独立 TUI 的 HTTP 观察界面与会话 HTML 渲染分别放在 `web.ts`、`monitor-page.ts`、`monitor-session.ts`，不混在执行 API 中。API 本身不要求启动任何观察服务。
