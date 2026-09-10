接下来执行 verify 任务。

# 目标

对一条风险假设（HYP）做静态成立性研判：攻击路径是否可达、危害是否成立。成立则产 finding，不成立则把理由写回 HYP。

# 工作方式

- 读任务正文给定的 HYP，按其主张、锚点与边界聚焦。
- 沿攻击者视角走一遍：source → 传播 → 校验 → 状态 → sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（匹配算法、数据结构、协议字段的实际性质），让结论落在代码事实上。
- 对照口径：读 `knowledge/vuln-policy.md`（onboard 初版 + research online 增量）。口径资料明确把这类问题定性为允许存在的（by-design、文档化缓解、安全策略排除），则 `finding_class` 置 risk。
- 保守口径：只有确认不可达、攻击者前提不符合威胁模型或找到有效防护时才判 refuted；静态无法确定不构成证伪理由——可疑但证不了的保留为 confirmed 或 `risk`，并在 finding 的 summary 中标注置信度。可达性依赖目标外组件行为（如浏览器、中间件）的尤其照此处理，不要长篇摇摆。
- 成立 → 用 `artifact create finding` 落 finding，并把研判追加进 HYP 正文（edit）。
- 不成立 → 把研判理由写回 HYP 正文（edit），如实收尾；缺陷本身存在但当前路径不可达的，用 `artifact create lead`（type=hunt）保留追踪点。

# 产出要求

- **finding**（artifact create finding）：结论准确可复现——标题一句话说清漏洞，summary 一段读懂，dataflow 逐步落到代码锚点，附 CVSS 定级与修复建议（明确时给最小 diff）。
- **HYP 正文追加**（edit）：把研判结论（含口径核验）追加到 HYP，供后续追溯。
- **回流线索**（artifact create lead）：缺陷存在但路径不可达的 hunt 线索。

# 备注

- 成立分类：高危且路径成立 → `finding_class: vulnerability`，交后续动态实证；利用前提苛刻、影响有限、价值不足或仅构成弱点 → `finding_class: risk`，不进动态验证。
- 本节点做静态研判，动态实证交给后续节点。

## 产物操作

- `create finding`：裁决 confirmed 时的漏洞报告（字段多，先 spec 查规格再调）
- `create lead`：缺陷存在但路径不可达的追踪点（type=hunt）
- `query hyp` / `query finding`：读既有产物

产出统一走 `artifact` 工具（op+type+fields 三段）；不确定字段规格时先 `artifact({op:"spec", type:"<类型>"})` 查权威字段表。落盘产物不要自行删除。
