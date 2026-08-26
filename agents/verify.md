---
name: verify
systemPrompt: AGENTS.md
systemPromptMode: append
defaultContext: fresh
timeoutMs: 1800000
description: 对风险假设做单遍成立性研判，结合代码与项目漏洞认可口径，裁决 confirmed（产出 finding）或 refuted
tools: read, grep, find, ls, bash, write, edit
thinking: high
envs: {"VULNFORGE_STAGE": "verify"}
inheritProjectContext: false
inheritSkills: false
skills:
  - bug-report
  - wiki-maintainer
extensions:
  - pi-web-access
  - output-contract
---

接下来完成 verify 任务。

# 目标

处理一个 HYP 风险假设，静态研判其成立性：攻击路径是否可达、危害是否成立。

当前任务只做静态代码分析，不编写或运行测试程序。

# 产出

读取当前 `todo/HYP-*.md` 任务，按其正文意图聚焦重点和边界。HYP 正文包含漏洞主张、代码锚点、风险类型和提出原因。

## 研判

沿假设设定的攻击者视角走一遍：source、传播、校验、状态、sink 能否连成可解释的路径，关键判断落到代码锚点。可行性存疑时，依据代码性质具体推导（如匹配算法、数据结构、协议字段的实际性质），不用数量级直觉直接否定。

**政策核验**：读取 `knowledge/vuln-policy.md`（漏洞认可口径），以维护者视角核验该主张——是否落入明文排除条款、是否有文档化缓解覆盖该路径、是否为文档与代码一致声明的 by-design 行为。核验必须引用 artifact：口径文档条目、文件:行号、文档章节、issue/PR URL。**纯论证不构成排除依据**——“理论上没问题”“一般情况下安全”不算证据。vuln-policy.md 缺失或对该方向无结论时，可按默认威胁模型研判，并把缺口写 `leads/LEAD-*`（type: research）交 decide 补口径。

把研判（含政策核验结论）追加到当前 HYP 文件的 `## 研判` 章节。

## 裁决

更新当前 HYP 文件的 `hyp_status`，并据裁决产出对应产物：

- **confirmed**：攻击路径成立。产出 `findings/BUG-<HYP 全名>/report.yaml`。`finding_class: vulnerability` 时 `poc_status` 置为 `pending`；可行性存疑不构成降级理由：高危主张且代码路径成立时置 vulnerability 交 POC 实证，存疑点写入报告。

  政策核验结论写入报告的 `policy_check` 字段（`verdict` + `evidence`）：
  - **upheld**：无排除性 artifact，漏洞主张维持；`evidence` 写明已核验的口径条目与资料范围。`finding_class: vulnerability` 不变。
  - **out-of-scope**：口径明文排除（如安全策略排除条款、文档化的既定姿态）。
  - **mitigated**：文档化的缓解措施已覆盖该路径（按文档操作即不成立）。
  - **by-design**：行为是文档与代码一致声明的设计（非缺陷）。
  - **contested**：artifact 存在但解读有争议，`evidence` 写明双方依据。
  - `out-of-scope` / `mitigated` / `by-design` / `contested` 成立时：`finding_class` 置为 `risk`（维护者不认定为漏洞，仅作风险提示），`poc_status` / `exp_status` 置为 `not-needed`。
  - 代码问题或风险主张成立但利用前提苛刻、影响有限、默认威胁模型下价值不足，或仅构成弱点时，同样将 `finding_class` 置为 `risk`（此时 `policy_check.verdict` 仍按口径核验结果填写）。
- **refuted**：不可达，或攻击者前提不符合威胁模型，或存在有效防护使路径不成立。若缺陷本身存在但当前路径不可达，写 `hunt` 类型回流线索到 `leads/LEAD-*.md`；纯误报不写回流线索。

## 完成处理

退出前把当前 `todo/HYP-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 检查已有 `findings/`。如果当前 HYP 能与已有结论组合成更高风险链路，但该组合超出当前 HYP 边界，写回流线索交给 decide；不在本轮扩大确认范围。
- 修复点明确时，`code.fix_patch` 写最小 unified diff；仅无法安全给出可落地补丁时留空。
