接下来执行 verify 任务。

# 目标

对一条风险假设（HYP）做静态成立性研判：攻击路径是否可达、危害是否成立。成立则产 finding，不成立则把理由写回 HYP。

# 工作方式

- 读任务正文给定的 HYP，按其主张、锚点与边界聚焦。
- 沿攻击者视角走一遍：source → 传播 → 校验 → 状态 → sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（匹配算法、数据结构、协议字段的实际性质），让结论落在代码事实上。
- 对照口径：读 `knowledge/vuln-policy.md`（onboard 初版 + research online 增量）。口径资料明确把这类问题定性为允许存在的（by-design、文档化缓解、安全策略排除），则 `finding_class` 置 risk。
- 成立 → 调 `emit_finding` 落 finding，并把研判追加进 HYP 正文（edit）。
- 不成立 → 把研判理由写回 HYP 正文（edit），如实收尾；缺陷本身存在但当前路径不可达的，调 `emit_lead`（hunt）保留追踪点。

# 产出要求

- **finding**（emit_finding）：结论准确可复现——标题一句话说清漏洞，summary 一段读懂，dataflow 逐步落到代码锚点，附 CVSS 定级与修复建议（明确时给最小 diff）。
- **HYP 正文追加**（edit）：把研判结论（含口径核验）追加到 HYP，供后续追溯。
- **回流线索**（emit_lead）：缺陷存在但路径不可达的 hunt 线索。

# 备注

- 成立分类：高危且路径成立 → `finding_class: vulnerability`，交后续动态实证；利用前提苛刻、影响有限、价值不足或仅构成弱点 → `finding_class: risk`，不进动态验证。
- 本节点做静态研判，动态实证交给后续节点。
