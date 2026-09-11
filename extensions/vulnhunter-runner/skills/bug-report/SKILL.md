---
name: bug-report
description: 漏洞报告撰写技能。把已确认的安全问题整理成结构化报告
---

# bug-report

漏洞报告撰写技能。把已确认的安全问题整理成结构化报告。

## 核心原则

发现漏洞后，你脑子里已经有完整的理解——位置、原因、影响、修复。报告只是把这些理解整理成第三方可读的结构化材料，不需要额外发明结论。

漏洞报告服务于不参与审计过程的读者：上游开发者、安全响应人员、产品安全负责人。报告必须只描述目标项目、漏洞事实、影响和修复建议，不暴露审计任务过程。

### 第三方读者视角

报告中可以保留代码路径、函数名、协议字段、命令参数、日志关键字等技术原文；但不要写审计系统内部语言或任务过程信息，例如：

- 不写“本次任务”“旧产物”“历史 finding”“动态复现阶段”“模型判断”等过程描述。
- 不写审计流程内部的产物和节点概念（假设、链路、认知切面、回流线索、动态复现阶段等），除非它们本身是目标项目的术语。
- 不把复现脚本执行过程、调试尝试、环境搭建过程塞进漏洞正文；这些属于 reproduction.md / 日志。

报告正文的判断依据应表达为代码事实和运行事实：由哪个输入或前提触发、经过什么处理、到达哪个缺陷点、造成什么可观察影响。

## 报告结构

复制 `skills/bug-report/template.yaml` 作为起点，填充四段：metadata / description / code / references。

### metadata（索引 + 评分）

| 字段 | 说明 |
|------|------|
| title | 一句话标题（见下） |
| vuln_type | 类型简写（见枚举表） |
| finding_class | vulnerability（漏洞）/ risk（风险或弱点） |
| cwe | CWE 编号（如 CWE-190，参考 cwe-guide.md 确定） |
| cvss_vector / cvss_score | CVSS v3.1 向量与分数 |
| ev_vector / ev_score / ev_priority / ev_rationale | 利用价值向量、分数、优先级、逐维度依据 |
| poc_status | pending（待复现）/ reproduced（已复现）/ fail-reproduced（已具备条件但复现失败，终态）/ blocked（执行环境或外部条件不足）/ not-needed（风险类不做动态复现） |
| affected_versions | 通过 git 等信息，确定受影响版本范围；未知时写 `unknown` |

**标题是一句话**：`[受影响功能（按业务职责称呼）] + [漏洞类型] + [后果]`，连起来能顺读。功能段用它对用户/系统承担的职责来称呼，让没读过代码的人也认得是哪个功能；类型与后果各用一个惯用词（RCE 这类保留惯用简写）。下列示例即目标形态：

- `MOV/MP4 解复用器 trun 样本尺寸解析整数截断导致拒绝服务`
- `HTTP 请求头解析器缓冲区越界读取导致信息泄露`
- `模板渲染引擎表达式注入导致 RCE`
- `头像上传功能路径遍历导致任意文件写入`
- `订单查询接口 SQL 注入导致数据库信息泄露`

### description（概览 + 业务背景）

| 字段 | 说明 |
|------|------|
| summary | 漏洞概览。用一段话说清：缺陷在哪个 `file:line`、怎样被触发或在什么条件下成立、造成什么后果、触发前提是否容易满足。以清晰为先——读者只看本字段就能把握漏洞全貌与严重程度；在说清楚的前提下再尽量凝练，逐步的代码流程交给 dataflow，不重复 metadata 已有的标签。 |
| background | 给不熟悉该项目的读者补上下文：项目/组件是什么、出问题的模块负责什么、以及跟这个漏洞相关的输入或数据（按类型可能是外部输入、敏感数据，或某个认证/配置前提）。先清晰再简洁——先让读者看懂再精简；不讲漏洞机制，也不评“为什么重要”。 |

#### summary 写法

`summary` 是漏洞的概览层。写作优先级是先清晰、再简洁：先保证读者只看这一段就能看懂漏洞，在此前提下再删可省的字——顺序不能反，不能为压短而丢掉理解漏洞必需的信息。

讲清楚一个漏洞，通常要让读者把握三件事：

1. **触发**：缺陷在哪个 `file:line`，怎样被触发或在什么条件下成立——按类型可能是受控输入经某路径到达触发点、某种先后顺序或状态致错、或某默认/配置下即成立。
2. **利用与影响**：攻击者要做什么（提交什么 payload、发起什么操作）即可触发，得手后造成什么后果。
3. **触发前提**：触发还需要哪些前提（如身份/权限、用户交互、特定配置、时序窗口），这些前提是否容易满足。

这是“说明白”所需覆盖的要素，不是必须逐条罗列的句式——能并进一句就并，只要因果链不断、读者不必自己脑补。逐步的代码流程是 dataflow 的职责，summary 不展开；metadata 已有的标签（CWE/类型/严重级别）不再重复。

#### background 写法

background 只做一件事：让不熟这个项目的读者能读懂后面的 summary 和 dataflow。交代清楚漏洞发生的场景：项目是什么、出问题的模块负责什么、以及跟这个漏洞相关的输入或数据是什么——按类型可能是外部输入、敏感数据，或某个认证/配置前提。停在缺陷本身之前，缺陷怎么出错、怎么触发、有多严重都不在这写（分别归 dataflow/flaw、summary、评分）。别堆版本、端口这类与理解漏洞无关的环境细节。

#### 版本影响写法

`affected_versions` 服务于“这个问题影响哪些版本”的判断，不能凭感觉编。能确认范围时写清边界，例如 `<= 2.1.6`、`1.20.0..1.22.3`、`main before <commit>`；未做版本考古或证据不足时写 `unknown`。

### code（触发步骤 + 复现配方 + 修复补丁）

| 字段 | 说明 |
|------|------|
| dataflow | 列表，逐步走到触发点的关键代码步骤（有污点流时即数据流）。每步骨架（所有类型通用）：step / location(file:line) / snippet / description；另按需加 function / role / flaw。 |
| reproduction | 复现配方（可选整块）：medium / preconditions / request / payload_variants / success_condition / notes。让复现者直接照做，不必从描述里反推。poc_status 未复现时可只写设想的请求与判据。 |
| fix_patch | 修复点明确时写以 `diff --git a/` 开头的最小 unified diff；仅无法安全给出可落地补丁时留空 |

写报告前判断修复点；边界检查、长度钳制、状态校验、错误返回等能明确定位时给出补丁。

#### dataflow 写法：先搭通用骨架

不论什么漏洞，`dataflow` 都是“逐步走到触发点的关键代码步骤”。每步先填这套所有类型通用的骨架：

- **location**：`file:line`，关键代码锚点。
- **snippet（每步必填）**：该 location 处的**真实代码原文，逐字复制**，不转述、不改写、不省略成伪代码。snippet 就是 location 那行（或那几行）的实际内容，两者必须自洽——对不上即行号错了。若根因是“缺了某检查/释放/边界”，snippet 就贴现有那行脆弱代码，缺什么交给 description / flaw 说。
- **description**：这一步发生了什么——讲清如何进入 / 怎样传播或被解析 / 在触发点被如何（不当）使用，术语点到即止。
- **function（可选）**：该行所在的函数或路由名，让读者不必翻源码就知道这行在谁体内。

根因那一步再加 **flaw**：一句话点明“这一步为什么是根因”（有 sink 时通常就是 sink 步）。其余步骤不必写。

#### role：数据在流动时才标

`role`（`source`→`propagation`→`sink`）只给**有污点流**的漏洞用，判据是“有没有一份受控数据值在步骤间流动”：

- **有数据流** → 逐步标 role，让读者看清数据从哪进入、在哪触发：
  - 注入类（sqli/cmdi/codei/xss/xxe/ldapi/httpi/xpathi）：source = 用户可控输入，sink = 危险函数 / 拼接点
  - ssrf/redirect：source = 可控地址，sink = 请求 / 跳转处；deser/proto：source = 可控字节流或对象属性，sink = 反序列化点 / 被污染方法；sandbox：source = 用户代码，sink = 逃逸点（如 vm.runInContext）
  - 内存类之 bof/intovf/fmtstr：source = 可控长度或字符串，sink = memcpy / 分配 / printf
  - info/idor/auth：source = 敏感数据来源或未认证请求，sink = 暴露方式（API/日志/响应）或受保护资源
- **无数据流**，靠时序、生命周期或静态状态成立 → role **留空**，改用 description 讲清关系：
  - race/TOCTOU：检查与使用之间的窗口、两个操作如何交错
  - uaf/double-free/memleak：free 与 use 的先后、哪条路径漏了释放
  - nullptr / 逻辑 / 配置弱点：哪个前提缺失、哪个默认状态即成立

#### reproduction 写法

`reproduction` 是给复现者的可操作配方，不是又一段散文。每个子字段分工明确：

- **medium**：复现介质，如 `http_request` / `cli` / `script`。
- **preconditions**：触发前必须先满足的条件（如“先 POST /register 注册账号拿到登录 Cookie”）。
- **request**：**完整、可直接复制**的请求或命令，含必要的 header / cookie / body。不要只给片段。
- **payload_variants**：变体列表，每项可加 `#` 注释说明用途。
- **success_condition**：**明确的成功判据**——观察到什么现象即证明触发成功。盲注类尤其要写清怎么确认（带外、时延、副作用文件等）。
- **notes**：平台差异、注意事项、“仅在授权环境操作”等。

### references

CWE / OWASP / 相关文档参考链接。

## vuln_type 枚举表

| 类型 | 简写 | 类型 | 简写 |
|------|------|------|------|
| SQL 注入 | sqli | 命令注入 | cmdi |
| 代码注入 | codei | XSS | xss |
| SSRF | ssrf | XXE | xxe |
| 路径遍历 | path | 文件上传 | upload |
| 开放重定向 | redirect | CSRF | csrf |
| 越权访问 | idor | LDAP 注入 | ldapi |
| 信息泄露 | info | 认证缺陷 | auth |
| HTTP 头注入 | httpi | XPath 注入 | xpathi |
| 沙箱逃逸 | sandbox | 反序列化 | deser |
| 原型链污染 | proto | 其他 | other |

> C/C++ 额外类型:intovf(整数溢出) bof(缓冲区溢出) heap(堆破坏) uaf(UAF) memleak(内存泄漏) race(竞态) nullptr(空指针) fmtstr(格式化字符串)

确定 `vuln_type` 与填写 `cwe` 编号时，查 `cwe-guide.md`（各类型 → CWE 编号 + 一句话定义 + 匹配场景）。

## 严重程度与 CVSS

漏洞的技术严重程度由 CVSS v3.1 基础分数度量，不用主观判断。报告只存 cvss_vector / cvss_score（危险分档由分数按 NVD 档位映射：9.0–10.0 critical / 7.0–8.9 high / 4.0–6.9 medium / 0.1–3.9 low / 0.0 none，不单独存 severity 字段）。

### 评估流程

1. 根据漏洞特征确定 8 个 CVSS 基础指标的值
2. 用 `cvss-calc.py` 计算精确分数:`python3 skills/bug-report/cvss-calc.py "CVSS:3.1/AV:N/AC:L/..."`
3. 将输出的向量和分数填入 `cvss_vector` 和 `cvss_score`

分档参考（供人工速择，不入字段）:9.0+ critical / 7.0+ high / 4.0+ medium / 0.1+ low / 0.0 info。

### CVSS 评分参考

完整的 CVSS v3.1 指标定义、判断标准和常见场景速查在 `cvss-v3.1-guide.md` 中。评估前先阅读该文件。

### 关键原则

- CVSS 评估必须**逐项列出 8 个指标的取值和判断理由**,不得跳过推导直接给出向量
- C/I/A 必须基于**已证明或高度确信的影响**,不得仅凭"理论上可达到代码执行"标 C:H/I:H/A:H
- 完整的判断标准和 C/I/A 规则见 `cvss-v3.1-guide.md`

## 利用价值评估 (EV)

CVSS 衡量技术严重性，EV 衡量攻击者实际利用的可能性和收益。评估标准见 `exploit-value-guide.md`。

评估流程：

1. 根据漏洞特征确定 4 个 EV 维度：Reachability / Exposure / Certainty / Impact
2. 用 `cvss-calc.py` 计算分数：`python3 skills/bug-report/cvss-calc.py ev "EV:1.0/R:N/E:D/C:D/I:X"`
3. 将输出的分数和优先级填入报告的 `ev_vector`、`ev_score`、`ev_priority` 字段
4. 在 `ev_rationale` 中逐维度写明判断依据，并说明这些判断如何落在目标项目的威胁模型里
