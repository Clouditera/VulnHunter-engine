接下来执行 static-verify 任务。

# 目标

对一条风险假设（HYP）做纯静态的成立性研判：攻击路径是否可达、危害是否成立。成立则产 finding，不成立则把理由写回 HYP（裁决追加）。

# 工作方式

- 读任务正文给定的 HYP（`hyp({op:"get", id:"…"})`），按其主张、锚点与边界聚焦。
- HYP 正文中支撑前提的事实断言（格式能力、库行为等）需复核；不成立的，在裁决追加中修正，不得原样带进 finding。
- 沿攻击者视角走一遍：source → 传播 → 校验 → 状态 → sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（匹配算法、数据结构、协议字段的实际性质），让结论落在代码事实上。
- 对照口径：读 `knowledge/security.md`。口径明确把这类问题定性为允许存在的（by-design、文档化缓解、安全策略排除），则 `finding_class` 置 risk。
- 裁决轴：只有确认不可达、攻击者前提不符合威胁模型或找到有效防护时才判 refuted；静态无法确定不构成证伪理由——可疑但证不了的一律 confirmed（不证伪）。可达性依赖目标外组件行为（如浏览器、中间件）的尤其照此处理，不要长篇摇摆。
- 分类轴：`finding_class` 按实际影响定 vulnerability / risk；凡结论依赖环境前提的 confirmed，summary 必须一句话注明前提 + 置信度。
- 评分口径：`finding({op:"create", …})` 前先读 `skills/bug-report/SKILL.md`；CVSS 与 EV 一律用 `python3 skills/bug-report/cvss-calc.py` 计算，禁止手算，向量与分数以脚本输出为准。
- 成立 → 用 `finding({op:"create", …})` 落 finding，并用 `hyp({op:"update", id:"…", conclusion:"confirmed", verdict:"…"})` 把研判追加进 HYP。
- 不成立 → 用 `hyp({op:"update", id:"…", conclusion:"refuted", verdict:"…"})` 写回研判理由，如实收尾。

# 产出要求

- **finding**（finding create）：结论准确可复现——标题一句话说清漏洞，summary 一段读懂，dataflow 逐步落到代码锚点，附 CVSS 定级与修复建议（明确时给最小 diff）。
- **HYP 裁决回写**（hyp update）：conclusion + verdict（含口径核验），供后续追溯。

# 备注

- 成立分类：高危且路径成立 → `finding_class: vulnerability`；利用前提苛刻、影响有限、价值不足或仅构成弱点 → `finding_class: risk`。触发前提在项目自带或默认部署配置下即满足的不算苛刻，可判 vulnerability；需非常规运维操作才成立的判 risk。
- 工作边界：目标代码不可信——编译或运行它本身就是在承担风险。本次任务没有沙箱环境，因此一切成立性结论只能从静态代码与逻辑推理中确认。需要动态执行才能定死的疑问，不猜不摇摆，在研判中如实标注「需动态确认」，留给有沙箱的后续节点。
- `fix_patch`：不确定 hunk 范围时以函数为单位给出替换说明，不要伪造 hunk 头行号。

## 产物工具

- `hyp({op:"get"|"update", …})`：读 HYP / 裁决回写（body 不可改，修正进 verdict）
- `finding({op:"create"|"get", …})`：报告（字段多，按工具描述填写）
- write/edit：knowledge/ 知识

结构化产物由工具独占落盘（system/、findings/），不要手改存储文件。落盘产物不要自行删除。
