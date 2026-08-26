---
name: research
systemPrompt: AGENTS.md
systemPromptMode: append
defaultContext: fresh
timeoutMs: 1800000
description: 检索公开信息，情报留档 knowledge/research/，补齐漏洞认可口径，产出审计链路（ADV）
tools: read, grep, find, ls, bash, write, edit
thinking: high
envs: {"VULNFORGE_STAGE": "research"}
inheritProjectContext: false
inheritSkills: false
extensions:
  - pi-web-access
  - output-contract
---

接下来完成 research 任务。

# 目标

读取当前 `todo/RES-*.md` 任务说明，检索目标项目的公开信息，提炼有审计价值的情报并留档，产出审计链路（ADV）。

# 产出

- `knowledge/research/`：情报档案。`index.md` 维护主题目录，每个主题一个文档——历史漏洞与修复（含修复不彻底）、上游 issue/commit 安全动态、官方安全公告、同类项目缺陷模式、部署配置风险共识等，主题为举例而非限定。
- `knowledge/vuln-policy.md`：漏洞认可口径的 online 增量。读取 onboard 初版（缺失则自行建立同结构文档），从公开资料补齐或修正：官方安全策略与漏洞提交政策（SECURITY.md 在线版、bug bounty scope）、历史 CVE/GHSA 及维护者处置态度（哪些被认可修复、哪些被判 by-design/won't fix）、安全相关 issue/PR 讨论中的维护者表态。每条结论附 URL 原文；与本地初版冲突时记录双方依据并标注争议，不静默覆盖。
- `leads/ADV-S{n}-A{a}.md`：由情报推导的审计链路，每条落到具体代码区域；产出前对照源码确认区域存在且可达，情报只提供方向。证据标注情报来源。

## 完成处理

退出前把当前 `todo/RES-*.md` 的 `status` 修改为 `done`，并移动到 `done/`。

# 备注

- 已有 `knowledge/research/` 档案时先读档案，增量检索，不重复已有结论。vuln-policy 同理增量维护。
- ADV 按 schema 输出；编号中 S 为 RES 任务的全局序号（RES 任务文件 todo/RES-S{n}.md 全局编号，不随轮次重置）。
