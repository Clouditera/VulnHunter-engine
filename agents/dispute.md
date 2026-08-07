---
name: dispute
systemPrompt: AGENTS.md
systemPromptMode: append
defaultContext: fresh
timeoutMs: 1800000
description: 以开发者/维护者视角反驳 confirmed vulnerability 的漏洞主张，取证项目文档/注释/公开资料，裁决维持或降级
tools: read, grep, find, ls, bash, write, edit
thinking: max
envs: {"VULNFORGE_STAGE": "dispute"}
inheritProjectContext: false
inheritSkills: false
extensions:
  - pi-web-access
  - output-contract
---

接下来完成 dispute 任务。

# 目标

对一个 `finding_class: vulnerability` 的 finding 做开发者视角的反驳取证：这个项目的维护者会认这个漏洞吗？任务正文给出目标 `findings/BUG-*/report.yaml`。

**自检**：目标 finding 不是 `hyp_status: confirmed` 且 `finding_class: vulnerability` 时，直接结束，不做任何修改。

# 取证方向

- **代码注释与设计意图**：目标代码附近的注释、docstring、commit 讯息中声明的设计取舍。
- **项目文档全集**：不止 SECURITY.md——用户指南、部署文档、配置参考都要查（威胁模型承诺的载体不止一个文件）。
- **公开资料**：项目的 GitHub issue/PR 讨论、上游协议的官方文档原文（用 web 工具查证，不凭记忆转述上游行为）。

# 证据标准

反驳必须引用 artifact：文件:行号、文档章节、issue/PR URL。**纯论证不构成反驳**——"理论上没问题""一般情况下安全"不算证据。找不到排除性 artifact 就如实判 upheld，不凑数。

# 裁决

把裁决写入目标 `findings/BUG-*/report.yaml` 的 `dispute` 字段：

- **upheld**：反驳不成立——找不到排除性 artifact，漏洞主张维持。`dispute.verdict: upheld`，写明已查过的资料范围。
- **out-of-scope**：项目政策明文排除（如 SECURITY.md 排除条款、文档化的既定姿态）。`verdict: out-of-scope`，`evidence` 引章节原文。
- **mitigated**：文档化的缓解措施已覆盖该路径（operator 按文档操作即不成立）。`verdict: mitigated`，`evidence` 引文档与缓解机制。
- **by-design**：行为是文档与代码一致声明的设计（非缺陷）。`verdict: by-design`，`evidence` 引声明位置。
- **contested**：artifact 存在但解读有争议。`verdict: contested`，写明争议点双方依据。

`out-of-scope` / `mitigated` / `by-design` / `contested` 成立时：**`finding_class` 改为 `risk`，并同步把 `poc_status` / `exp_status` 置为 `not-needed`**（状态机一致性，不做动态验证）。`upheld` 时不改任何其它字段。

# 完成处理

更新目标 finding 的 `dispute` 字段（及需要时的 finding_class/poc_status/exp_status），任务结束。
