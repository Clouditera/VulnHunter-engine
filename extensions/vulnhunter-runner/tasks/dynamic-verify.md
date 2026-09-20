接下来执行 dynamic-verify 任务。

# 目标

对一条风险假设（HYP）做成立性研判，并对裁决 confirmed 的 vulnerability 立即在沙箱中复现：先用代码路径判断假设是否成立，再用动态证据检验它。

# 工作方式

## 成立性研判

- 读任务正文给定的 HYP（`hyp({op:"get", id:"…"})`），按其主张、锚点与边界聚焦。
- HYP 正文中支撑前提的事实断言（格式能力、库行为等）需复核；不成立的，在裁决追加中修正，不得原样带进 finding。
- 沿攻击者视角走一遍：source → 传播 → 校验 → 状态 → sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（匹配算法、数据结构、协议字段的实际性质），让结论落在代码事实上。
- 对照口径：读 `knowledge/security.md`。口径明确把这类问题定性为允许存在的（by-design、文档化缓解、安全策略排除），则 `finding_class` 置 risk。
- 裁决轴：只有确认不可达、攻击者前提不符合威胁模型或找到有效防护时才判 refuted；静态无法确定不构成证伪理由——可疑但证不了的一律 confirmed（不证伪）。可达性依赖目标外组件行为（如浏览器、中间件）的尤其照此处理，不要长篇摇摆。
- 分类轴：`finding_class` 按实际影响定 vulnerability / risk；凡结论依赖环境前提的 confirmed，summary 必须一句话注明前提 + 置信度。
- 评分口径：`finding({op:"create", …})` 前先读 `skills/bug-report/SKILL.md`；CVSS 与 EV 一律用 `python3 skills/bug-report/cvss-calc.py` 计算，禁止手算，向量与分数以脚本输出为准。
- 成立 → 用 `finding({op:"create", …})` 落 finding，并用 `hyp({op:"update", id:"…", conclusion:"confirmed", verdict:"…"})` 把研判追加进 HYP。
- 不成立 → 用 `hyp({op:"update", id:"…", conclusion:"refuted", verdict:"…"})` 写回研判理由，如实收尾。

## 动态复现

- 裁决 confirmed 且 `finding_class: vulnerability` 时，转入沙箱复现；`risk` 与 refuted 不做动态复现。
- 动态操作前先确认沙箱可达（按沙箱连接配置短重试不超过 3 次）；不可达时用 `sandbox({op:"report", status:"unavailable", note:"…"})` 回报，本任务如实收尾。
- 读 finding 声称的入口、路径与危害，在沙箱内构建目标、编写并运行触发脚本；脚本、触发输入、日志先落本地，再用 `finding({op:"update", id:"…", attachments:[{op:"add", file:"…", kind:"poc", note:"…"}]})` 收进附件（沙箱产物先 scp 回本地再 add）。
- 复现后用 `finding({op:"update", id:"…", poc_status:"…", poc_evidence:"…"})` 回写：poc_status 取 reproduced / fail-reproduced / blocked；若复现暴露了新边界，同步修正 finding 的标题、影响描述与攻击前提。
- 环境缺组件等阻碍复现的，状态记为 blocked，如实收尾。

# 产出要求

- **finding**（finding create）：结论准确可复现——标题一句话说清漏洞，summary 一段读懂，dataflow 逐步落到代码锚点，附 CVSS 定级与修复建议（明确时给最小 diff）。
- **HYP 裁决回写**（hyp update）：conclusion + verdict（含口径核验），供后续追溯。
- **poc 附件**（finding update attachments，kind=poc）：复现过程说明与触发脚本、输入、日志等原始证据。
- **finding 回写**（finding update）：poc_status 与 poc_evidence 如实反映复现结果。
- **knowledge/env/**：本次动态操作的关键记录。

# 备注

- 成立分类：高危且路径成立 → `finding_class: vulnerability`，进入动态复现；利用前提苛刻、影响有限、价值不足或仅构成弱点 → `finding_class: risk`，不进动态复现。触发前提在项目自带或默认部署配置下即满足的不算苛刻，可判 vulnerability；需非常规运维操作才成立的判 risk。
- 复现成功的判据是异常来自 finding 声称的真实入口与真实路径；跑出异常本身不等于复现成功。
- 复现失败与环境阻碍分开记录：复现失败记 fail-reproduced，环境阻碍记 blocked。
- 对含存疑点的 finding，复现实验要覆盖存疑点并给出结论。
- `fix_patch`：不确定 hunk 范围时以函数为单位给出替换说明，不要伪造 hunk 头行号。

## 产物工具

- `hyp({op:"get"|"update", …})`：读 HYP / 裁决回写（body 不可改，修正进 verdict）
- `finding({op:"create"|"update"|"get", …})`：报告 / poc_status 等回写（状态机受控）/ 附件收编（attachments 三操作）
- `sandbox({op:"report"|"get"})`：沙箱状态
- write/edit：knowledge/ 知识

结构化产物由工具独占落盘（system/、findings/），不要手改存储文件。落盘产物不要自行删除。
