# VulnHunter-engine 系统设计（engine-rework 定稿）

> 2026-08-31 · 依据《08-引擎演进纲领》+ 与 fish 逐节对齐（08-27~31）
> 姊妹篇：docs/runner-design.md（调度与函数层细节）；本文重点：**提示词体系**与**流程组织**。

## 1. 系统总览

```
用户 ←→ 主会话（LLM，媒介：对话/定方向/mark_scope/答疑）
            │ scan 工具启动（后台）
            ▼
   workflow（workflows/*.ts，确定性 TS 控制流）
            │ ctx.node() —— 进程内 SDK 会话
            ▼
   8 种节点 LLM（onboard/research/cognize/hunt/verify/poc-verify/ev-assess/exp-build）
            │ 产物经"操作函数"落盘（结构化）或 write/edit（散文）
            ▼
   工作区 <项目>/.vulnforge（队列/知识库/findings/exploits）
```

三条铁律：
1. **调度归代码**：流程顺序/循环/并发/门禁是确定性 TS，LLM 只在节点内部做专业判断；
2. **结构化产物归函数**：程序要解析的字段只能经函数产生/变更；散文归 write/edit；
3. **主会话归媒介**：不定调度、不管流转，只对用户负责。

## 2. 提示词体系（三层）

### 2.1 主会话提示词

- **systemPrompt = main-prompt.md + AGENTS.md（append 拼接）**；
- main-prompt.md 瘦身为媒介职责：启动参数对话（vuln_focus/sandbox_cfg/user_instr/output_lang）、mark_scope 对谈定范围、调 scan、运行期答疑与进度转告、用户中途插话转 steer 注入；
- 调度话术（派发/轮次/迁移）全部删除。

### 2.2 节点提示词

- **systemPrompt = agents/<name>.md（任务书，纯散文）+ AGENTS.md（append 基底）**；
- frontmatter 退役：节点配置（tools/skills/函数/扩展/超时）进代码 `extensions/runner/nodes.ts`（NodeSpec 类型，tsc 保证）；
- agents/*.md 只写：身份、目标、工作方式、产出要求、方法论备注。

### 2.3 任务正文（user message，workflow 代码生成）

每个节点会话的 user message 由 workflow 现场组装，极简：

| 节点 | 任务正文要点 |
|---|---|
| onboard | 目标根、是否启用动态 |
| research | 检索方向（项目/版本/关注面）或回流 LEAD 内容 |
| cognize | 目标区域（coverage 缺口）+ 边界 |
| hunt | 执行的 ADV 文件路径 |
| verify | 研判的 HYP 文件路径 |
| poc-verify / ev-assess | 目标 finding 编号 |
| exp-build | 组合方向 + 候选 finding 清单 |

### 2.4 skills

按节点挂载（nodes.ts 配置）：onboard=project-profiler/threat-modeling/wiki-maintainer；verify=bug-report/wiki-maintainer；……（沿用现有绑定表，配置化）。

## 3. 流程组织

### 3.1 生命周期

```
scan 启动
  → Phase 0：onboard（一次性）→ research（一次性）   [幂等跳过]
  → 动态门禁：启用动态而 build 不可用 → 退出
  → 四池循环（3.2）
  → 终止判定 → coverage 门禁 → 收尾/缺口清单
```

### 3.2 四池生产者-消费者

| 池 | 节点 | 并发 | 消费 | 产出 |
|---|---|---|---|---|
| A | cognize | 1（串行） | 节点内自查 scope 覆盖缺口（coverage 工具） | ADV（C 线） |
| B | hunt | H | leads/ADV-* | HYP、回流 LEAD |
| C | verify | V | leads/HYP-* | finding（或空=refuted） |
| D | poc-verify→ev-assess / exp-build | 沙箱数 | poc_status=pending 的 finding | 复现/评估/组合产物 |

- 全局信号量 max_concurrent（默认 5）；槽位分配 work-conserving + 下游优先（verify > D池 > hunt > cognize）+ 老化防饿死；
- research 产出 ADV-S 线直接进池 B 队列；回流 LEAD 按 type 机械路由（research→追加 research / hunt→转 ADV / threat-model→wiki）。

### 3.3 队列与状态

- 队列即目录：leads/（待消费）→ todo/（消费中）→ done/（完成），workflow 代码机械搬运；
- ADV/HYP 纯散文无 frontmatter；状态归目录位置 + run-state.json；
- 裁决判定：verify 产出 finding = confirmed，未产出 = refuted，记 run-state；
- run-state.json：onboard_done/research_done/队列快照/裁决/预算——中断重跑即续跑。

### 3.4 终止与门禁

四池排空 + A 停工 → coverage 门禁：scope.yaml 行覆盖率 ≥ 阈值 → 收尾；不足且预算未尽 → cognize 补轮；预算尽 → 如实输出缺口清单。无 nag、无 report 验收阶段。

**覆盖率口径**：覆盖率=审计覆盖率，即代码是否被 hunt 精读，仅 hunt 计入。cognize 是粗读——识别缺口、理解代码情况、切出合理审计链路（语义上=明确的功能点/数据流；量化≈百行至千行），其阅读不计入。

## 4. 产物函数层（8 个，详见 runner-design.md §4）

创建类：emit_adv / emit_hyp / emit_lead / emit_finding；
更新类：update_finding / update_build_state / update_profiler。
约定：emit 不给 id（编号函数内取，线别按节点绑定）；update 必须给 id、null 不动；返回值带"结构化字段勿手改"提示；校验在调用时。

## 5. 工作区布局（<项目>/.vulnforge）

```
scope.yaml            # mark_scope 产物，门禁基准（主会话写）
run-state.json        # workflow 账本（workflow 代码写）
knowledge/            # profiler.yaml / wiki/ / vuln-policy.md / build/ / research/ / worklog.md / exploits/
leads/  todo/  done/  # 队列三态
findings/BUG-*/       # report.yaml + poc/ + exp/
exploits/             # 组合链产物
```

## 6. 节点任务书编写规范（writter 按此撰写 agents/*.md）

**writter 负责 8 个节点的任务书正文**：onboard / research / cognize / hunt / verify / poc-verify / ev-assess / exp-build。

### 6.1 结构（五段，按序）

1. **身份句**：`接下来执行 X 任务。`（单行，无修饰）；
2. **# 目标**：这个节点为审计流水线做什么（一段话）；
3. **# 工作方式**：先做什么后做什么的节奏；**产物分工**——哪些产物调哪个函数（列函数名+一句职责）、哪些用 write/edit；
4. **# 产出要求**：产物清单及内容质量要求（写什么、写到什么程度）；
5. **# 备注**：方法论约束、边界、禁止事项（可选）。

### 6.2 禁令（机制内容一律不写）

- 不写 frontmatter（---块整个不存在）；
- 不写文件命名/编号规则（函数自动）；
- 不写 todo/done 流转、状态字段修改（workflow 管）；
- 不写"按 schema 输出/校验"（函数管）；
- 不提 pi-subagents、派发、decide、轮次等旧机制词。

### 6.3 基调

- 对象是专家级安全研究员 LLM，不是初学者——方法论指导点到为止；
- 中文，术语保留英文原词；语言风格参照现有 agents/*.md 正文；
- 每篇 30-60 行，超过即拆分或删减。

### 6.4 可用信息（撰写时可引用的函数与工具）

各节点函数授权表见 runner-design.md §4；基础工具按节点从 nodes.ts 配置（撰写时注明"该节点可用工具：…"即可，不必列参数细节——参数由函数签名自带）。

## 7. 退役清单

pi-subagents / output-contract / audit-lifecycle / report 节点 / VULNFORGE_STAGE / ADV·HYP frontmatter 与 schema / main-prompt 调度话术 / agents frontmatter。
