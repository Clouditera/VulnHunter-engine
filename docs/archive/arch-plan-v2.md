# VulnHunter-engine 架构规划 v2（fish 09-05 十点设想落地）

> 目标：workflow 多变性 + 二次开发灵活性。外围对话 agent 未来可以现场编写一个新 workflow 文件来设计新调度。

## 0. 总体分层

```
┌─ 入口层：pi（裸命令）+ vulnhunter skill（对接用户、选 run、传参）
├─ workflow 层：workflows/*.ts —— 可组合的编排脚本（LLM 可编写）
├─ 基建层（runner/）：SessionService / Pool / Queue / 产物函数 / 任务书装配 / 覆盖 / 监控
└─ pi 平台层：session tree（label/navigateTree/compact/branch）、SDK 会话、扩展
```

## 1. 入口层：pi + vulnhunter skill

- 启动 = 裸 `pi`（环境 `PI_CODING_AGENT_DIR=<engine>`）。`vf` 退化为可选别名。
- `main-prompt.md` 的职责移入 `skills/vulnhunter/SKILL.md`：引擎能力说明、参数引导（沙箱/关注方向/输出语言）、**run 类型选择指引**、scan 工具用法。
- **run 选择在外层 agent（skill 指引），不在 workflow 内自动路由**（fish 09-05 裁定 #2）。workflow 保持纯粹，只接收"运行哪个"的决定。skill 给出判断方法（有效代码行/token 估算 → direct/full）。
- 用户有自定义调度需求时，agent 参照 `docs/workflow-authoring.md` 现场写一个 workflow 文件放进 workflows/ 并启动（fish #3）。

## 2. 基建层

### 2.1 SessionService（runner/session.ts）——核心新组件

对 pi 会话树的程序化封装，handle 对象：

```ts
interface SessionHandle {
  readonly id: string;                    // 血缘 id
  prompt(text: string): Promise<void>;    // 发送任务（user prompt 承载任务目标）
  mark(label: string): Promise<void>;     // 纯打标记（拓扑动作，不含任何上下文处理）
  compact(instructions?: string): Promise<void>;  // 独立操作，与打标记解耦
  goto(label: string, opts?: { summarize?: boolean; label?: string; customInstructions?: string }): Promise<void>;
  // navigateTree 封装：带摘要回到标记点（分支往返）
  fork(label?: string): Promise<SessionHandle>;   // 提取当前路径成独立会话（并发链用）
  close(): Promise<void>;
}
```

- **打标记即 checkpoint**（fish #5）：label 落在会话树条目上，永久可作起始点。
- **mark 与 compact 解耦**（fish 09-05 补充裁定）：mark 只打标记；compact 独立成动词。打好标记的点**如何被消费由下游决定**——直接 goto 继续、先 compact 再继续、先 fork 再各自 compact，都是合法姿势，workflow 编排时显式写出。
- **分支往返**（fish #6）：`goto(mark, {summarize:true})` 即"开分支执行→带摘要回起点"，上一轮摘要留在会话里保持连续性。这是基础组件，hunt 多轮、verify 起点都靠它。
- **血缘登记**：每次 mark/goto/fork 写入 run-state.json 的 session 血缘表，监控台可见。

### 2.2 统一节点工具（fish #4）

onboard 与 research 的 NodeSpec 合并为同一份：同 extensions（pi-web-access）、同 skills、产物函数取并集（update_profiler / update_build_state / emit_adv_s / emit_lead）。同会话连续执行不再有工具差异。

### 2.3 Pool（runner/pools.ts）

池 = { name, maxConcurrent, 资源语义 }。内置两种：
- `verifyPool`（无沙箱依赖，默认高并发）——verify 单独成池（fish 最简 run #4）；
- `sandboxPool`（=1，串行）——poc-verify/ev-assess/exp-build。
池只是调度器；**任务上下文在会话文件里**，池间移交 = 传递 handle。

### 2.4 既有保留

queue.ts（队列原语）、workspace-tools.ts（产物函数）、coverage（hunt read 记录）、monitor（F9）、任务书装配（参数头部+任务书+任务句，user prompt 保障任务目标——fish #8）。

### 2.5 编号体系 = 会话标记命名（fish #9）

编号不动。标记直接用编号命名：`init`、`hunt-r1`、`ADV-C1-A2`、`HYP-C1-A2-H3`、`verify-HYP-C1-A2-H3`……下游节点按编号在会话树上找自己的起点。

## 3. workflow 层

### 3.1 共享编排件（workflows/lib.ts）

```ts
runInit(ctx): Promise<SessionHandle>
  // 起会话 → onboard 任务书 prompt → research 任务书 prompt（同会话，fish 设想 #3）
  // → compact → mark("init") → 返回 init-session handle（fish 设想 #4；压缩与否是消费侧选择，
  //   runInit 作为初始化编排件选择"压完再标"，其它消费方从 init 出发时可自行决定）

runHuntRounds(ctx, init: SessionHandle, opts): Promise<void>
  // 在 init 上 mark("hunt-start") → 循环：
  //   发 hunt 任务 prompt（第 N 轮，换角度指令随轮注入）
  //   → goto("hunt-start", {summarize: true, label: `hunt-r${n}`})
  //   停止：行数定上限 + 一轮零新 HYP + 覆盖达标（可选）
  // 结束后 mark("verify-start")

runHypChain(ctx, startLabel, hypId, cfg): Promise<void>
  // fork 出该 HYP 的独立会话（从 verify-start 继承 hunt 摘要，fish #7）
  // verify（verifyPool）→ confirmed → 移交 sandboxPool：同会话 poc-verify → reproduced → 同会话 ev-assess
  // 动态环节是否启动由任务配置决定（fish 最简 run #3）

runExpBuild(ctx, init) // 收尾
```

### 3.2 最简 run（workflows/audit-direct.ts）

```
init = runInit(ctx)
runHuntRounds(ctx, init, { maxRounds: f(有效行数), stopOnZeroHyp: true })
for each HYP（verifyPool 并发）:
    runHypChain(ctx, "verify-start", hyp, { sandbox: !!sandbox_cfg })
runExpBuild(ctx, init)（可配）
```

### 3.3 编写新 workflow

`docs/workflow-authoring.md`：workflow = defineWorkflow({name, run(ctx)})，只能用 lib 编排件 + ctx.params；给出完整示例，供外层 agent 仿写（fish #3）。

## 4. 迁移

- 现有 `audit.ts` 保留为 `audit-full` 的基线，新基建先在 audit-direct 上验证；
- `vf` 改薄（或删）；main-prompt.md → skills/vulnhunter/SKILL.md；
- 会话血缘进 run-state.json，监控台加"会话树/标记"页（后续）。

## 5. 已确认的平台 API（pi-mono 源码）

| 能力 | API |
|---|---|
| 打标记 | `sessionManager.appendLabelChange(entryId, label)` |
| 分支往返带摘要 | `session.navigateTree(targetId, {summarize, label, customInstructions})` |
| 压缩 | `session.compact(instructions)` |
| 分叉独立会话 | `sessionManager.createBranchedSession(leafId)` |
| 复活会话 | `SessionManager.open(path)` + createAgentSession({sessionManager}) |
