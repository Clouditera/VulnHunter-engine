接下来执行 ev-assess 任务。

# 目标

对已复现的单个 finding，搭建贴近真实部署的环境，模拟真实业务与威胁模型，评估它在真实场景下的最大影响，并据此校准评分。

# 工作方式

- 读任务正文给定的 finding（`finding({op:"get", id:"…"})`），理解其业务背景、威胁模型与声称的影响。
- 按真实部署方式搭建准业务环境（默认构建配置、默认组件）；白板材料先落本地，再用 `finding({op:"update", id:"…", attachments:[{op:"add", file:"…", kind:"exp", note:"business-model | threat-model | exp"}]})` 收进附件：business-model.md 记业务模型，threat-model.md 记围绕该 finding 的威胁模型，exp.md 记结论。
- 在准业务环境中验证真实影响，结论写 exp.md。
- 用 `finding({op:"update", id:"…", exp_status:"…", ev_vector:"…", ev_score:…, ev_priority:"…", ev_rationale:"…"})` 回写：exp_status（状态机枚举：reproduced / fail-reproduced / blocked / not-needed）与 EV 四维；真实影响与报告声称不符时，同步下调 CVSS 与影响描述，必要时将 finding_class 降为 risk。
- 评估条件无法模拟、沙箱不可用的：状态记为 blocked（沙箱不可达时以 `sandbox({op:"report", status:"unavailable", note:"…"})` 回报），如实收尾。

# 产出要求

- **exp 附件**（finding update attachments，kind=exp）：business-model、threat-model、exp 文档及环境脚本、日志。
- **finding 回写**（finding update）：exp_status 如实反映真实影响验证结果；EV 评分逐维度给出依据。
- **knowledge/env/**：本次动态操作的关键记录。

# 备注

- 评估环境与真实部署一致：默认构建配置、默认组件；插桩/替代构建只用于缺陷定位，其崩溃行为不作为可利用性判定依据。
- 影响达不到声称水平时如实下调，以实测为准。
- 只做单个 finding，只对 vulnerability 执行。

## 产物工具

- `finding({op:"get"|"update", …})`：读 finding / exp_status + EV 四维回写 / 附件收编（attachments 三操作）
- `sandbox({op:"report"|"get"})`：沙箱状态
- write/edit：knowledge/env/ 记录

结构化产物由工具独占落盘（system/、findings/），不要手改存储文件。落盘产物不要自行删除。
