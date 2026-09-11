接下来执行 research 任务。

# 目标

通过代码文件之外的内容，找出对当前漏洞审计有价值的信息：在线资料（CVE/GHSA/issue/writeup）与 git 信息（版本、安全修复史、回退记录、变更热点）。产出情报档案与审计链路（ADV），并更新漏洞认可口径与 wiki。

# 工作方式

- 先读 `knowledge/research/` 已有档案、`knowledge/vuln-policy.md` 与项目画像，确认项目与版本，增量推进。
- 在线检索：历史 CVE/GHSA、上游 issue/commit 安全动态、官方安全公告、同类项目缺陷模式、部署配置风险共识，写情报笔记（write/edit）。
- git 考古：跑 git log/tag 查版本演进、安全修复史、回退记录与变更热点，补在线检索之外的线索。
- **漏洞认可口径 online 增量**：补官方安全策略与漏洞提交政策、历史漏洞的维护者处置态度（认可修复还是 won't fix）、issue/PR 表态，写进 `knowledge/vuln-policy.md`。
- **wiki 更新**：值得沉淀的项目背景与攻击面认知写入 `knowledge/wiki/`（write/edit）。
- **审计链路**：情报指向值得深挖的代码区域时，用 `artifact create adv` 落审计链路；源码只在落 ADV 前做存在性抽查（确认函数/文件还在、位置正确），精读交给 hunt/cognize。
- **回流线索**：值得追加检索的新方向，用 `artifact create lead` 记录。
- 在线与 git 通道都缺失、且对项目没有明确记忆时，如实收尾；零产出是合法结果，情报只写有出处的。

# 产出要求

- **knowledge/research/**：情报档案——index.md 维护主题目录，每个主题一个文档（历史漏洞与修复、上游安全动态、官方安全公告、同类项目缺陷模式、部署配置风险共识等），每条情报注明来源 URL。
- **knowledge/vuln-policy.md**：online 增量——官方安全策略与漏洞提交政策、历史 CVE/GHSA 维护者处置态度、issue/PR 表态，每条结论标注来源 URL。
- **审计链路**（artifact create adv）：每条指向具体代码区域，写明为什么值得深挖（含情报依据）与关注的威胁方向。
- **wiki 更新**：值得沉淀的背景与攻击面认知。

# 备注

- 情报提供方向，漏洞结论由后续节点基于源码得出。
- 已有结论不重复，重点补增量。
- 信息通道缺失时如实收尾，零产出是合法结果。

## 产物操作

- `create adv`：情报指向的审计链路（S 线编号）
- `create lead`：回流线索（type=research）

产出统一走 `artifact` 工具（op+type+fields 三段）；不确定字段规格时先 `artifact({op:"spec", type:"<类型>"})` 查权威字段表。落盘产物不要自行删除。
