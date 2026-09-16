# artifact 元工具设计（2026-09-08，fish 发起）

> 动机：不同任务用不同产物函数，同会话切任务时换工具集会破坏 KV cache（工具定义在系统提示词前缀里，一变全段重算）。
> 方案：参考 pi-mcp-adapter 的代理模式——会话只挂**一个恒定不变的元工具**，所有产物操作藏在其后；操作语义仿 HTTP 动词分层。
> 权限模型（fish 5088 裁定）：**放开工具权限**，不做节点级机械白名单；任务使用什么操作，由任务书直接指明（契约层约束）。

## 1. 工具定义（恒定，永不随任务变化）

所有节点会话统一注册同一个工具 `artifact`（约 200 token）：

```json
{
  "name": "artifact",
  "description": "审计产物统一管理。产物类型：profiler / build-state / wiki / adv / lead / hyp / finding / coverage / exploit。操作类型：query（读）/ create（新建）/ update（更新）/ spec（查字段规格）/ list（列可用操作）。不确定某类产物的字段时，先 artifact({op:\"spec\", type:\"<类型>\"})。",
  "parameters": {
    "op":     { "type": "string", "enum": ["query", "create", "update", "spec", "list"] },
    "type":   { "type": "string", "description": "产物类型（query/create/update 必填）" },
    "id":     { "type": "string", "description": "目标产物 id（update/定点 query 用）" },
    "fields": { "type": "object", "description": "载荷，字段规格见 spec" }
  },
  "required": ["op"]
}
```

**KV cache 论证**：同会话切任务（onboard→build→research→hunt；verify→poc→ev）只换 user prompt（任务书），工具定义字节不变 → 前缀稳定 → cache 保留。同时系统提示词从 8+ 个工具定义瘦身到 1 个。

## 2. 操作语义（仿 HTTP 动词分层）

| op | 类比 | 语义 | 副作用 |
|---|---|---|---|
| query | GET | 读产物/状态（查覆盖率、读既有 finding、列 leads 队列） | 无 |
| create | POST | 新建产物（emit_* 系列），幂等取号由服务端保证 | 写队列/产物文件 |
| update | PATCH | 按 id 更新既有产物的字段 | 改产物文件 |
| spec | OPTIONS | 返回某 type 的字段规格（字段名/必填/含义/示例） | 无 |
| list | GET /meta | 返回全部可用 (op, type) 组合清单 | 无 |

## 3. 现有函数 → 新形态映射

各 type 的 fields 详情（以 workspace-tools.ts 现有实现为准，是之前多轮沟通的沉淀）：

### 3.1 adv（create）——审计链路
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| body | string(md) | ✓ | 建议含：审计链路/锚点/认知依据/关注威胁 |
编号自动分配（ADV-<线><runNo>-A<n>）；线别 C/S 与 runNo 来自会话上下文（binding），不进 fields。

### 3.2 hyp（create）——风险假设
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| body | string(md) | ✓ | 漏洞主张/代码锚点(file:line)/风险类型/提出原因 |
编号继承会话 binding.advId（HYP-C1-A2-H<n>），初始序号取该链已有最大值防覆盖。

### 3.3 lead（create）——回流线索
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| type | enum | ✓ | research=补充检索；hunt=转审计链路继续挖 |
| body | string(md) | ✓ | 问题与锚点 |
编号自增 LEAD-L<n>。

### 3.4 finding（create）——漏洞报告（verify 裁决 confirmed 时）
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| title | string | ✓ | 受影响功能(业务职责称呼)+漏洞类型+后果 |
| vuln_type | string | ✓ | 简写枚举（sqli/cmdi/bof/uaf/path/deser/…） |
| finding_class | enum | ✓ | vulnerability / risk（risk=前提苛刻/影响有限/弱点） |
| cwe | string[] | ✓ | ["CWE-121"] |
| cvss_vector / cvss_score | string / number | ✓ | v3.1 |
| ev_vector / ev_score / ev_priority / ev_rationale | string/number/enum(P0-P3)/string | ✓ | EV 四维+依据 |
| affected_versions | string | ✓ | 未知写 unknown |
| summary / background | string | ✓ | 概览一段读懂 / 业务背景 |
| dataflow | object[] | ✓ | {step, location(file:line), function?, role?(source/propagation/sink), snippet(逐字复制), description, flaw?} |
| reproduction | object | 可选 | {medium, preconditions[], request, payload_variants[], success_condition, notes} |
| fix_patch | string | 可选 | diff --git 开头最小 unified diff |
| references | string[] | ✓ | |
编号继承 binding.hypId → BUG-<链>。副作用：finding_class=vulnerability 时 poc_status/exp_status 自动置 pending，risk 时 not-needed。

### 3.5 finding（update）——状态机更新
| 字段 | 说明 |
|---|---|
| id | BUG-…（必填） |
| poc_status / exp_status | 状态机：pending→reproduced/fail-reproduced/blocked/not-needed；reproduced/fail-reproduced/not-needed 为终态（blocked 可回 pending） |
| poc_evidence | 复现证据摘要 |
| ev_score / ev_priority / ev_rationale | EV 修正 |
| finding_class | 仅允许 vulnerability→risk 降级（降级时 poc/exp 自动 not-needed） |
缺省字段保持不变。

### 3.6 build-state（update）——构建/部署状态
| 字段 | 说明 |
|---|---|
| status | available / unavailable（沙箱可用性门禁） |
| body | string(md)，整体替换。结构约定：构建系统/依赖/编译命令/部署拓扑/实例连接信息（build 分离后由 build 任务书细化） |

### 3.7 profiler（update）——项目画像（分节深合并）
| 字段 | 说明 |
|---|---|
| language / frameworks / entrypoints | string[] |
| modules | {name, path, role}[] |
| build | {system, commands} |
给值的节深合并，缺省保持不变，可分多次补齐。

### 3.8 coverage（query）——覆盖查询
| 字段 | 说明 |
|---|---|
| scope | 必选，返回该 scope 的 hunt 精读覆盖情况 |

### 3.9 边界裁定
- **wiki**：自由 markdown 知识库，继续走基础 write/edit 文件工具，不收编进 artifact；
- **exploit 代码**：exp 本体是代码文件，走 write/edit；exp 状态走 `update finding`（exp_status）。

旧工具与新调用的对应：emit_hyp/emit_lead/emit_adv_*/emit_finding → `create <type>`；update_finding/update_profiler/update_build_state → `update <type>`；coverage 查询 → `query coverage`；新增 `query <type>` 支持定点读/列队。队列流转（leads/todo/done 幂等移动）逻辑不变，只是入口从独立工具收敛到 create/update 处理器。

## 4. 模型引导（防"不查就猜"）

1. **任务书指明**（主路径，fish 5088-1）：每本任务书写明该任务可用的 (op, type) 组合，如 hunt 任务书："产出只走 `artifact create hyp`；查已有假设用 `artifact query hyp`"；
2. **spec 自省**（兜底）：agent 不确定字段时 `artifact({op:"spec", type:"hyp"})` 返回字段表+示例；
3. **错误教学化**：参数校验失败时返回"你错在哪 + 正确用法示例"（参照 pi-mcp-adapter 的参数恢复思路）。

spec 返回的是该 type 的**权威字段规格**（字段名/类型/必填/约束/枚举/示例），服务端校验按同一份规格执行。示例（`artifact({op:"spec", type:"hyp"})` 的返回）：

```json
{
  "type": "hyp", "op": "create",
  "fields": {
    "title":     { "type": "string", "required": true, "desc": "一句话漏洞主张" },
    "anchors":   { "type": "array<string>", "required": true, "desc": "代码锚点 file:line，至少 1 个", "example": ["src/t_stream.c:1234"] },
    "path":      { "type": "string", "required": true, "desc": "攻击者可达的入口路径" },
    "risk_type": { "type": "string", "required": false, "enum": ["memory", "logic", "injection", "authz", "dos", "other"] }
  },
  "example": { "op": "create", "type": "hyp", "fields": { "title": "XACKDEL 栈溢出", "anchors": ["src/t_stream.c:1234"], "path": "XACKDEL 命令直参" } }
}
```

## 5. 实现

- 新扩展 `extensions/runner/artifact-tool.ts`：注册单一 custom tool + 操作注册表（type → {schema 描述, handler}）。handler 复用现有 workspace-tools.ts 的 emit_* 实现（业务逻辑不动，入口收敛）；
- nodes.ts 的 `fns` 字段废除（权限放开）；会话装配对所有节点挂同一个 artifact 工具；pi 内置工具（read/bash/edit/write…）维持默认不动；
- 监控/覆盖挂钩不变（create hyp 仍触发原事件，监控台无感）；
- `docs/workflow-authoring.md` 更新：workflow 作者只需写任务书声明操作，不再配函数集。

## 6. 风险与保留

- **弱模型越权**（hunt 直接 create finding）：契约层的代价。监控可见异常产物；如实测失控，保留一个运行时开关 `artifact.allow`（按节点过滤可见 type）作为回退——默认不开；
- ~~**schema 弱校验**：provider 侧只能校验 op/type 枚举，fields 是自由对象 → 服务端校验必须严格且报错带示例；~~（fish 5096 裁定：spec 自省返回权威字段规格，照着填即生效；本项降为"报错教学化"执行要求）
- **spec 内容也是 token 开销**：spec 文本存在扩展里，不进系统提示词，只在被查询时进上下文（一次几百 token，可接受）。

## 7. 与 build 分离的落地

build 任务（onboard 之后）的产物走 `update build-state`：理解段（构建系统/依赖/部署拓扑）+ 实例段（实际构建/部署后的连接信息）。任务书直接写这两个操作的用法，不需要新工具。
