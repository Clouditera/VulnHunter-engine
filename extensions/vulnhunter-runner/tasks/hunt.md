接下来执行 hunt 任务。

# 目标

围绕一条审计链路（ADV）做局部精读，找出值得后续论证的风险假设（HYP），目标是尽量不遗漏可能存在的安全风险。

本节点纯静态审计：不编译、不运行目标、不做任何动态验证；动态验证由后续节点负责。

# 工作方式

- 读任务正文给定的 ADV，按其意图聚焦重点与边界。
- 沿链路精读源码：普通链路沿 source → 传播 → 校验 → 状态 → sink 追踪；反向链路从已知危险位置反追，确认攻击者能否从真实入口到达 sink。阅读用 read 工具。
- 发现值得查的风险，用 `artifact create hyp` 落风险假设；一条链路可产多条，发现几条产几条。
- 知识空白或威胁模型修正，直接更新 `knowledge/wiki/` 或 `knowledge/wiki/threat-model.md`（write/edit）；新攻击面或已见危险但到达路径待续追的，用 `artifact create lead`（type=hunt）记录。

# 产出要求

- **风险假设 HYP**（artifact create hyp）：HYP 是待证实的怀疑，成立与否由后续研判（static-verify / dynamic-verify）裁决；提出时只需满足：有代码锚点、有可检查的路径。低置信度但值得查的也落 HYP。
- **回流线索**（artifact create lead）：新攻击面、到达路径待续追的危险。

# 备注

- 产出前用 `artifact({op:"query", type:"hyp"})` 查已有 HYP，确保每条假设是新增的——与前几轮已提的重复不提，「已提」包括：前轮 HYP、前轮排除过的方向、ADV 正文「关注的威胁」清单项。
- 有锚点的怀疑落 HYP；证据不足或暂缺锚点的方向落回流线索，保留追踪点。
- 本节点只读源码，精读计入覆盖率，读目标源代码请用 read 工具。

## 产物操作

- `create hyp`：风险假设
- `create lead`：回流线索（type=hunt）
- `query hyp`：查已有假设防重复

产出统一走 `artifact` 工具（op+type+fields 三段）；不确定字段规格时先 `artifact({op:"spec", type:"<类型>"})` 查权威字段表。HYP / LEAD 编号由 artifact 工具自动分配（HYP 继承当前 ADV 链），不要自己拟编号。落盘产物不要自行删除。
