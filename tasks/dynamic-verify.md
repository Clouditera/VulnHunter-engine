接下来执行 dynamic-verify 任务。

# 目标

对一条风险假设（HYP）做成立性研判，并对裁决 confirmed 的 vulnerability 立即在沙箱中复现：先用代码路径判断假设是否成立，再用动态证据检验它。

# 工作方式

## 成立性研判

- 读任务正文给定的 HYP，按其主张、锚点与边界聚焦。
- 沿攻击者视角走一遍：source → 传播 → 校验 → 状态 → sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（匹配算法、数据结构、协议字段的实际性质），让结论落在代码事实上。
- 对照口径：读 `knowledge/vuln-policy.md`（onboard 初版 + research online 增量）。口径资料明确把这类问题定性为允许存在的（by-design、文档化缓解、安全策略排除），则 `finding_class` 置 risk。
- 保守口径：只有确认不可达、攻击者前提不符合威胁模型或找到有效防护时才判 refuted；静态无法确定不构成证伪理由——可疑但证不了的保留为 confirmed 或 `risk`，并在 finding 的 summary 中标注置信度。可达性依赖目标外组件行为（如浏览器、中间件）的尤其照此处理，不要长篇摇摆。
- 成立 → 用 `artifact create finding` 落 finding，并把研判追加进 HYP 正文（edit）。
- 不成立 → 把研判理由写回 HYP 正文（edit），如实收尾；缺陷本身存在但当前路径不可达的，用 `artifact create lead`（type=hunt）保留追踪点。

## 动态复现

- 裁决 confirmed 且 `finding_class: vulnerability` 时，转入沙箱复现；`risk` 与 refuted 不做动态复现。
- 读 finding 声称的入口、路径与危害，在沙箱内构建目标、编写并运行触发脚本；脚本、触发输入、日志写入 `findings/<BUG>/poc/`。
- 复现后用 `artifact({op:"update", type:"finding", id:"<BUG编号>", fields:{poc_status, poc_evidence}})` 回写：poc_status 取 reproduced / fail-reproduced / blocked；若复现暴露了新边界，同步修正 finding 的标题、影响描述与攻击前提。
- 环境缺组件、沙箱不可达等阻碍复现的，状态记为 blocked，如实收尾。

# 产出要求

- **finding**（artifact create finding）：结论准确可复现——标题一句话说清漏洞，summary 一段读懂，dataflow 逐步落到代码锚点，附 CVSS 定级与修复建议（明确时给最小 diff）。
- **HYP 正文追加**（edit）：把研判结论（含口径核验）追加到 HYP，供后续追溯。
- **findings/<BUG>/poc/**：poc.md 说明复现过程与结论，附触发脚本、输入、日志等原始证据。
- **finding 回写**（artifact update finding）：poc_status 与 poc_evidence 如实反映复现结果。
- **回流线索**（artifact create lead）：缺陷存在但路径不可达，或复现中暴露的新攻击面。
- **knowledge/build/**：本次动态操作的关键记录。

# 备注

- 成立分类：高危且路径成立 → `finding_class: vulnerability`，进入动态复现；利用前提苛刻、影响有限、价值不足或仅构成弱点 → `finding_class: risk`，不进动态复现。
- 复现成功的判据是异常来自 finding 声称的真实入口与真实路径；跑出异常本身不等于复现成功。
- 复现失败与环境阻碍分开记录：复现失败记 fail-reproduced，环境阻碍记 blocked。
- 对含存疑点的 finding，复现实验要覆盖存疑点并给出结论。

## 产物操作

- `create finding`：裁决 confirmed 时的漏洞报告（字段多，先 spec 查规格再调）
- `update finding`：poc_status / poc_evidence 回写（状态机受控）
- `create lead`：缺陷存在但路径不可达的追踪点，或复现暴露的新攻击面（type=hunt）
- `query hyp` / `query finding`：读既有产物

产出统一走 `artifact` 工具（op+type+fields 三段）；不确定字段规格时先 `artifact({op:"spec", type:"<类型>"})` 查权威字段表。落盘产物不要自行删除。
