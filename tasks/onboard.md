接下来执行 onboard 任务。

# 目标

为审计建立基线：摸清项目结构、技术栈与入口，产出项目画像、快速认知 wiki、威胁模型和漏洞认可口径初版；启用动态验证时，确认沙箱可用并如实记录构建状态。后续节点的判断都依赖这里落下的知识。

# 工作方式

先通读项目全貌（README、目录结构、构建脚本），再进入关键模块与入口，边读边落盘：

- **项目画像**：调 `update_profiler` 分节填写结构化字段——语言、框架、入口、模块、构建。一次填一部分，缺口分多次补齐，不追求一次填全。
- **动态环境**：启用动态验证时，在沙箱内实际构建验证，调 `update_build_state` 记录可用性与说明；不可达就如实记 unavailable，不回落本地跑动态操作。
- **知识留档**：项目结构与关键模块写 `knowledge/wiki/`，威胁模型写 `knowledge/wiki/threat-model.md`，漏洞认可口径写 `knowledge/vuln-policy.md`，用 write/edit。

# 产出要求

- **项目画像**（update_profiler）：语言栈、框架依赖、入口点、模块清单（名称/路径/职责）、构建方式，覆盖关键模块，不留大面积空白。
- **knowledge/wiki/**：index.md 知识库目录 + overview.md 项目结构、入口、关键模块与数据流概览，让后续节点快速建立上下文。
- **knowledge/wiki/threat-model.md**：初始资产、信任边界、攻击面和优先审计方向——是安全判断的基准，宁可从简但要成立。
- **knowledge/vuln-policy.md**：漏洞认可口径初版——该项目中什么样的漏洞会被维护者认可。从本地资料取证（SECURITY.md/安全策略、威胁模型文档、部署配置文档、代码注释/docstring/commit 信息中声明的设计取舍），分四节记录：认可面、排除条款、文档化缓解、by-design 声明。每条结论带证据锚点（文件:行号/文档章节）；本地无结论的方面留空标注「待 online 取证」，由 research 补齐。
- **knowledge/build/build.md**（update_build_state + write）：动态环境的现状与配置说明。

# 备注

- 源码完整性：项目自身构建机制声明需要的源码缺席时（Makefile 的源码拉取目标、.gitmodules、vendoring 脚本），补齐源码（拉取属静态信息搜集）；用户提供的代码本身残缺（缺头文件/源文件）不补，记为审计输入边界。
- 缺代码区域不得直接划出审计面；无法补齐时在 threat-model.md 标注为边界。
