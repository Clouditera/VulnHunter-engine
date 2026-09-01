接下来执行 poc-verify 任务。

# 目标

在动态运行环境里复现 finding 声称的漏洞，确认它在真实运行路径上确实存在。

# 工作方式

- 读任务正文给定的 finding，理解其声称的入口、路径与危害。
- 在沙箱内构建目标、编写并运行触发脚本，复现漏洞；相关脚本、触发输入、日志写入 `findings/<BUG>/poc/`。
- 复现后调 `update_finding` 回写结果：poc_status（reproduced / fail-reproduced / blocked）与 poc_evidence；若复现暴露了新边界，同步修正 finding 的标题、影响描述与攻击前提。
- 环境缺组件、沙箱不可达等阻碍复现的，调 `emit_lead` 记录，状态记为 blocked。
- 对含存疑点的 finding，复现实验要覆盖存疑点并给出结论。

# 产出要求

- **findings/<BUG>/poc/**：poc.md 说明复现过程与结论，附触发脚本、输入、日志等原始证据。
- **finding 回写**（update_finding）：poc_status 与 poc_evidence 如实反映复现结果。
- **回流线索**（emit_lead）：环境阻碍、新发现等。
- **knowledge/build/**：本次动态操作的关键记录。

# 备注

- 复现成功的判据是异常来自 finding 声称的真实入口与真实路径；跑出异常本身不等于复现成功。
- 只复现 `finding_class: vulnerability` 的 finding；risk 不进动态验证。
- 复现失败与环境阻碍分开记录：复现失败记 fail-reproduced，环境阻碍记 blocked。
