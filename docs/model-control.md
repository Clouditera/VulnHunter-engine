# 模型控制面

runner 的模型控制分两层，但只有一份语义：纯引擎直接调用 `WorkflowRunnerEngine`，SaaS 分进程时调用它的 HTTP 适配器。HTTP 不是 pi 的接口；pi 只在 runner 内部消费已经归一化的 agent 快照。

## 纯引擎

```ts
const engine = new WorkflowRunnerEngine({
  engineDir,
  loadWorkflow: async (name) => workflows.get(name),
});

const run = await engine.start({
  workflow: "audit-lite",
  target: "/workspaces/sample",
  params: { rounds: "4" },
  agents: {
    init:   { version: 1, source: "local",  selection: { providerId: "acme", modelId: "reasoner", thinking: "high" } },
    hunt:   { version: 1, source: "local",  selection: { providerId: "acme", modelId: "fast", thinking: "medium" } },
    verify: { version: 1, source: "inline", selection: { providerId: "tenant-a", modelId: "reasoner", thinking: "high" }, providers: [/* 完整 provider/model */], credentials: [/* 内存凭证 */] },
  },
});
await engine.replaceAgentModel(run.runId, "verify", nextSnapshot, 1);
```

`source=local` 只传选择，provider/model 和凭证由 `engineDir/models.json`、`auth.json` 提供；`source=inline` 必须传该 agent 的完整 providers/models/credentials 快照。每个 agent 有独立 `ModelRuntime`，会话创建时注入同一 runtime；全量替换先校验候选，再在原 runtime 内替换，失败不污染旧配置。一个 run 内 `source` 保持不变：local run 的切换目标仍来自本地文件，inline run 的切换请求必须带新的完整快照。

`inline.providers` 的每项必须有 `id`（平台记录主键）和 `providerType`（Pi provider ID，如 `zai`），模型定义仍在 `models`。`selection.providerId` 和 `credentials[].providerId` 引用记录 `id`，不是厂商类型。同一快照允许多份同类型记录；每个 agent 只在自己的 Pi 内存 registry 中注入所选记录，注册 ID / `Model.provider` / 认证索引使用它的 `providerType`。切换同类型的另一账号也全量替换该作用域的 URL、模型和 key，不改 SDK、不伪造厂商名，其他 agent 保持自己的快照。`source=local` 的选择仍直接使用本地 Pi provider ID，不作平台记录解释。

## HTTP

扩展进程默认不监听控制端口。需要 SaaS 分进程调用时设置：

```sh
VULNHUNTER_CONTROL=1 \
VULNHUNTER_CONTROL_PORT=4200 \
VULNHUNTER_CONTROL_TOKEN='由部署系统注入' \
pi ...
```

接口：

- `POST /v1/runs`：body `{ workflow, target, params?, agents? }`，返回 `202 { runId }`。
- `GET /v1/runs/{runId}`：查询状态；凭证只返回 `<redacted>`。
- `PUT` 或 `PATCH /v1/runs/{runId}/agents/{agentKey}/model-config`：body 是该 agent 的完整快照，可带 `baseVersion`；版本冲突 `409`，模型/凭证校验失败 `422`。

HTTP 默认绑定 `127.0.0.1`。绑定非本机地址必须配置 `VULNHUNTER_CONTROL_TOKEN`；生产环境仍应由 HTTPS/mTLS 代理承载跨主机访问。密钥只进入对应 agent 的内存 credential store，不写模型文件、run 参数或日志。

## Pi 会话边界（自 0.87 起）

runner 的会话上下文以 `SessionManager` 为唯一事实源。workflow 的分支摘要落树后调用 `session.refreshContext()` 刷新检查缓存，不再写 `session.agent.state.messages`；恢复、`goto`、`fork` 和后续 provider 请求都通过 `SessionManager` 读取规范化上下文。
