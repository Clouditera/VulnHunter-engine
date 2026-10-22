# Runner 设计定稿：程序化调度引擎（engine-rework）

> **更新说明（2026-09-20 工具重构）**：产物函数层已被四套对象工具替代，队列机制退役（派发改由 system/hyp 状态驱动）；本文函数与队列细节过时，以源码（src/tools/、src/workflows/）为准，保留作架构背景。
> **09-21 补**：宏观池已收敛为 init / hunt / verify 三池（沙箱=资源容量非池）；hunt∥verify 并行消费、按池模型配置以 src/workflows/audit-lite.ts 头注与 src/model-config.ts 为准。本文「四池」为 08-27 历史设计。

> 2026-08-31 定稿 · 依据《08-引擎演进纲领》+ 08-27/28/31 与 fish 逐节对齐
> 核心裁定：workflow=TS 代码（无 JSON/YAML 定义）；pi-subagents 下线；主会话退为媒介；
> 结构化产物一律经函数写入；frontmatter markdown 去 frontmatter 化（ADV/HYP）。

## 1. 定位与总结构

runner 是 engine/core 的 pi 扩展，把审计流程从 decide 自由调度收回为确定性代码。
主会话只负责：对话 → mark_scope 确认范围 → 调 `scan` 启动 workflow → 答疑/查进度。

```
用户 ←→ 主会话（LLM 媒介）
            │ scan 工具（后台启动）
            ▼
   workflow（TS 函数，确定性控制流）
            │ ctx.node() 拉起进程内 SDK 会话
            ▼
   节点 LLM（onboard/research/cognize/hunt/verify/poc-verify/ev-assess/exp-build）
```

## 2. 宏观调度：四池 + 全局信号量

```
                     总并发信号量 max_concurrent（默认 5）
        ┌──────────┬──────────┬──────────┬──────────────────┐
        ▼ 池 A      ▼ 池 B      ▼ 池 C      ▼ 池 D
     cognize     hunt       verify    poc-verify/ev-assess/exp-build
     并发 1      并发 H      并发 V    并发=沙箱数
        │ ADV       │ HYP       │ BUG      ▲ poc_status=pending
        ▼           ▼           ▼ ─────────┘
   消费覆盖缺口  消费方向    消费假设     消费 finding
```

- **onboard/research 一次性**：run-state 标记，重跑幂等跳过；
- **动态门禁**：scan 参数含 sandbox_cfg 而 build 状态 unavailable → 退出 workflow；
- **槽位分配**：work-conserving + 下游优先（verify > poc/exp > hunt > cognize）+ 老化防饿死（等待超阈值提级）+ 池内硬上限（cognize 恒 1 防 wiki 写冲突、D 池恒=沙箱数）；
- **无死锁**：节点超时必终止 + 槽位释放即重派 + 老化保底；

## 2.1 调度细节裁定（09-02 fish）

1. 队列流转：派发即移 todo；会话异常结束退回 leads（可重派）；
2. 池间策略：下游优先，不设积压限速；
3. 池 D：有待处理 finding 优先调度 D；poc-verify→ev-assess 同 finding 链式连跑（占沙箱不放）；
4. exp-build：其余节点全部执行完毕后才启动；连续无新 exploits 产出即停；
5. 门禁阈值：mark_scope 时设定（scope.yaml 携带阈值）；
6. 预算：节点数/时长/token 默认无上限，外部指定才生效；
7. steer 注入：内外部 ADV 不区分，同队列同规则；
8. research 不做"出洞后针对性检索"（暂不）。

## 2.2 错误处理裁定（09-02 fish）

- 不设节点超时（节点跑到自然结束）；
- API 错误：pi 内部自带重试（有上限）；上限后 runner 注入恢复 prompt 继续会话；**连续 3 次 pi 异常且恢复无效 → 判定 API 不可用，中止整个 workflow**；
- 会话异常结束：任务退回 leads（可重派）；
- 零产出合法（cognize/research 尤其），不重试；
- 沙箱不可达：不做额外处理（节点如实 blocked 即可）。

## 2.3 LEAD 类型裁定（09-02 fish）

LEAD type 只留两值：**research**（→追加 research）/ **hunt**（→转 ADV 回池 B）。
threat-model 类型移除：知识/威胁模型的修订由节点**直接修改相关文件**（wiki/vuln-policy），不产生 LEAD。
原则：一条 LEAD 必须有池消费者，没有消费者的类型就 redesign。
- **终止**：A 停工 + 队列排空 + 无在跑节点 → coverage 门禁（scope.yaml 行覆盖率，hunt 口径）→ 达标收尾 / 预算尽输出缺口清单；
- **池 A 停工双信号**：①量化——scope 覆盖率达标（缺口不存在）；②判断——cognize 连续 2 轮零 ADV 产出（无值得深挖的方向）。
- **中断恢复**：run-state.json 记账（完成标记/队列快照/裁决/预算），重跑续跑。

## 3. 队列与文件流转（workflow 代码机械执行）

- 队列 = 文件：`leads/`（待消费）→ `todo/`（消费中）→ `done/`（完成）；agent 不管流转；
- 机械状态（ADV 消费完）workflow 直接改；判断状态（finding 产出与否）由节点行为判定：verify 产出 finding=confirmed，未产出=refuted，记 run-state；
- 回流 LEAD 按 type 路由：research→追加 research；hunt→转 ADV 回池 B；threat-model→wiki 维护；
- 用户中途插话 → 主会话转告 → workflow 注入定向 ADV。

## 4. 产物操作函数（定稿，8 个）

### 原则
1. 结构化产物走函数，散文产物走 write/edit（结构化唯一理由=程序要解析）；
2. 字段即参数，全平铺（函数签名=文件结构文档，禁止字典包字段）；
3. frontmatter markdown：frontmatter 字段各一参数 + 一个 body 参数；
4. 身份和状态归函数，内容归 edit。

### 创建类（emit_*，不给 id，编号函数内取）

| 函数 | 参数 | 说明 |
|---|---|---|
| `emit_adv({body})` | 纯正文 | 编号线按节点绑死（cognize=C线 / research=S线） |
| `emit_hyp({body})` | 纯正文 | 编号自动继承当前 ADV；一节点可多次调用产多条 |
| `emit_lead({type, body})` | type: research/hunt/threat-model | 回流线索 |
| `emit_finding({...})` | 参数面见下 | 编号继承 HYP；vulnerability 时 poc_status 自动 pending |

emit_finding 参数面（对齐 bug-report 新四段式模板）：
`title, vuln_type, finding_class, cwe, cvss_vector, cvss_score, ev_vector, ev_score, ev_priority, ev_rationale, affected_versions, summary, background, dataflow, reproduction, fix_patch, references`

### 更新类（update_*，必须给 id，null=保持不变）

| 函数 | 参数 | 说明 |
|---|---|---|
| `update_finding({id, ...})` | poc_status/poc_evidence/exp_status/ev_*/finding_class… | 池 D 回写；状态机校验 |
| `update_build_state({status?, body?})` | status: available/unavailable | 动态门禁依据 |
| `update_profiler({language?, frameworks?, entrypoints?, modules?, build?})` | 每节一参数深合并 | 供下游 app 消费 |

### 通用约定
- 返回值：落盘路径+编号 + 结果摘要 + "结构化字段函数维护勿手改，正文可用 edit 补充"；
- 校验在调用时：schema/枚举/状态机不合法当场打回；
- 编号自动化：取号/继承链/来源线全在函数内，进程内计数器防并发。

### 节点授权表

| 节点 | 函数 | 基础工具 |
|---|---|---|
| onboard | update_profiler · update_build_state · emit_lead | read/grep/find/ls/bash/write/edit |
| research | emit_adv(S线) · emit_lead | 基础 + web（pi-web-access） |
| cognize | emit_adv(C线) · emit_lead | read/grep/find/ls/write/edit |
| hunt | emit_hyp · emit_lead | 只读系 |
| verify | emit_finding · emit_lead | 只读系+edit（HYP 正文追加研判） |
| poc-verify | update_finding · emit_lead | 全量+沙箱 |
| ev-assess | update_finding · emit_lead | 全量 |
| exp-build | update_finding · emit_lead | 全量+沙箱 |

## 5. 退役清单

| 件 | 替代 |
|---|---|
| pi-subagents | runner 进程内 SDK 会话（createAgentSession） |
| output-contract | 函数内 schema 校验 |
| audit-lifecycle（nag/report 门禁） | coverage 门禁 + 程序化收尾 |
| report 节点 | 报告=按需查询产物 |
| VULNFORGE_STAGE env | 阶段身份=注入了哪些函数 |
| ADV/HYP frontmatter 及 schema | 纯散文 + 目录位置/run-state 管状态 |
| main-prompt 调度话术 | 主会话收敛为媒介（scan/scan_status） |

## 6. 里程碑

1. **M1 骨架**（已探路）：runner 扩展 + scan/scan_status + runNode 进程内会话；
2. **M2 函数层 + Phase 0**：8 个产物函数 + onboard/research 节点 + 一次性标记 + 动态门禁；
3. **M3 主循环**：cognize/hunt/verify 三池 + 队列流转 + 回流路由；
4. **M4 池 D + 门禁**：动态验证流水线 + coverage 收尾 + 预算护栏；
5. **M5 退役**：pi-subagents/output-contract/audit-lifecycle 摘除，main-prompt 瘦身，全量验证。
