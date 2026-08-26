---
name: onboard
systemPrompt: AGENTS.md
systemPromptMode: append
defaultContext: fresh
timeoutMs: 1800000
description: 初始化项目画像、wiki、威胁模型、漏洞认可口径与动态运行环境（首轮执行）
tools: read, grep, find, ls, bash, write, edit
thinking: high
envs: {"VULNFORGE_STAGE": "onboard"}
inheritProjectContext: false
inheritSkills: false
skills:
  - project-profiler
  - threat-modeling
  - wiki-maintainer
extensions:
  - output-contract
---

接下来 onboard 任务。

# 目标

初始化项目画像、wiki、威胁模型、漏洞认可口径。启用 POC/EXP 时，检查并配置动态运行环境。

# 产出

- `knowledge/profiler.yaml`：按 schema 输出项目画像。
- `knowledge/wiki/index.md`：知识库目录。
- `knowledge/wiki/overview.md`：项目结构、入口、关键模块和数据流概览。
- `knowledge/wiki/threat-model.md`：初始资产、信任边界、攻击面和优先审计方向。
- `knowledge/vuln-policy.md`：**漏洞认可口径**初版——该项目中什么样的漏洞会被维护者认可。从本地资料取证（SECURITY.md/安全策略、威胁模型文档、部署配置文档、代码注释/docstring/commit 信息中声明的设计取舍），分四节记录：**认可面**（历史或明文认可的漏洞类型）、**排除条款**（明文不认可的类型/场景）、**文档化缓解**（有缓解措施覆盖的路径）、**by-design 声明**（文档与代码一致声明的既定行为）。每条结论带证据锚点（文件:行号/文档章节）；本地无结论的方面留空标注「待 online 取证」，由 research 补齐。
- `knowledge/build/build.md`：记录动态运行环境的现状和配置情况；frontmatter 含 `sandbox: available | unreachable` 与 `updated` 时间。

## 完成处理

退出前把当前 `todo/ONBOARD-O*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 源码完整性：项目自身构建机制声明需要的源码缺席时（如 Makefile 的源码拉取目标、.gitmodules、vendoring 脚本），补齐源码（拉取属静态信息搜集）；用户提供的代码本身残缺（缺头文件/源文件）不补，在 `knowledge/build/build.md` 记为审计输入边界。缺代码区域不得直接划出审计面；无法补齐时写 `leads/LEAD-*`（type: threat-model）交 decide。
