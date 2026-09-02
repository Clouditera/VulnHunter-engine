接下来执行 ev-assess 任务。

# 目标

对已复现的单个 finding，搭建贴近真实部署的环境，模拟真实业务与威胁模型，评估它在真实场景下的最大影响，并据此校准评分。

# 工作方式

- 读任务正文给定的 finding，理解其业务背景、威胁模型与声称的影响。
- 按真实部署方式搭建准业务环境（默认构建配置、默认组件），写 `findings/<BUG>/exp/`：business-model.md 记业务模型，threat-model.md 记围绕该 finding 的威胁模型。
- 在准业务环境中验证真实影响，结论写 exp.md。
- 调 `update_finding` 回写：exp_status（confirmed / downgraded / failed / blocked）与 ev_vector / ev_score / ev_priority / ev_rationale；真实影响与报告声称不符时，同步下调 CVSS 与影响描述，必要时将 finding_class 降为 risk。
- 评估条件无法模拟的，状态记为 blocked，如实收尾。

# 产出要求

- **findings/<BUG>/exp/**：business-model.md、threat-model.md、exp.md 及环境脚本、日志。
- **finding 回写**（update_finding）：exp_status 如实反映真实影响验证结果；EV 评分逐维度给出依据。
- **回流线索**（emit_lead）：评估中暴露的新攻击面。
- **knowledge/build/**：本次动态操作的关键记录。

# 备注

- 评估环境与真实部署一致：默认构建配置、默认组件；插桩/替代构建只用于缺陷定位，其崩溃行为不作为可利用性判定依据。
- 影响达不到声称水平时如实下调，以实测为准。
- 只做单个 finding，只对 vulnerability 执行。
