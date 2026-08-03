# VulnForge-chat — 会话化安全审计流程

VulnForge 审计流程的会话化形态：**一个 pi 会话即整个编排器**。主会话（decide）持有任务意图，通过 subagent 派发各阶段任务；pi-context 管理长跑上下文；工作区文件系统是三池共享记忆。无自研编排二进制。

## 架构

```
pi（main-prompt 扩展自动注入主提示词）← 主会话（decide，持久）
  ├─ pi-context       上下文纪律：根锚点/轮锚点/checkout 新鲜分支
  ├─ workspace-diff   轮次增量；code-coverage-viewer 覆盖读数
  └─ subagent(...)    阶段执行（天然会话隔离）
       ├─ onboard / research / cognize / hunt / verify   （默认模型）
       ├─ poc-verify / ev-assess / exp-build             （强模型，agentOverrides）
       └─ report                                        （隔离审计）
```

## 安装

```bash
git clone --recurse-submodules https://github.com/Clouditera/VulnForge-Chat.git
cd VulnForge-Chat

# 1. 模型端点：cp models.json.example models.json，填入你的 provider 与 key（key 用 $VAR 引用时同步配置 .env）
# 2. 扩展依赖（有外部依赖的三个）
npm install --prefix extensions/pi-subagents --omit=dev
npm install --prefix extensions/pi-web-access --omit=dev
npm install --prefix extensions/output-contract --omit=dev
# 3. 指认 agent dir（建议写进 shell rc）
export PI_CODING_AGENT_DIR=$PWD
```

## 使用

**仓库根即 agent dir**；启动走仓库自带的 `vf` 启动器（它会自动 export `PI_CODING_AGENT_DIR`）。

主会话（decide）系统提示词 = `AGENTS.md`（全局身份）+ `main-prompt.md`（decide 任务）；扩展按需显式挂载（tracker 不挂主会话，decide 阅读不计 coverage）；子会话提示词 = AGENTS.md + 任务书正文（pi-subagents fork 自动前置拼接）。

### 启动（交互 TUI，可同时测试多个项目）

```bash
# 审计专用入口（建议写进 shell rc）：--no-skills 屏蔽 ~/.agents/skills 等外部技能源，
# 保证审计会话的工具面干净；日常 pi 使用不受影响
alias pia='/path/to/VulnForge-Chat/vf --no-skills'

cd /path/to/项目A && pia     # 每个项目一个 TUI 会话，互不干扰
cd /path/to/项目B && pia     # 会话按 cwd 自动隔离（sessions/<目录编码>/）
```

> 改提示词/agents/扩展后重启会话（pi -c）即生效。

第一句话给出意图：`开始审计。audit_scope: …；vuln_focus: …`（目标即当前目录；参数英文名 + 中文备注见 main-prompt）
产物位置：**工作区根默认 `<项目>/.vulnforge`**（todo/ findings/ knowledge/ report/ 等全部在其下，项目根零污染；意图中可用 `output_dir: <路径>` 另指）。
恢复中断：同目录 `pi -c`（继续上次）/ `pi -r`（会话选择器）；开新会话：直接 `pi`。

### 查看会话文件

会话文件仍在 agent dir 下：
```
<repo>/sessions/<项目目录编码>/
├── <时间戳>_<主会话uuid>.jsonl        ← 主会话全量转录（消息/思考/工具/token）
└── <时间戳>_<主会话uuid>/<runId>/run-N/session.jsonl   ← 各 subagent 会话
```

- 测试**进行中**：`tail -f` 主会话 jsonl 观察调度；`cat <repo>/run-history.jsonl` 看 subagent 运行登记（agent/状态/耗时）；
- 测试**结束后**：同目录 `pi -r` 在 TUI 里回看任意会话（含分支树）；或直接读 jsonl（每行一个 JSON 事件，jq 可任意切片，如 `jq -r 'select(.type=="message") | .message.role' file.jsonl`）；
- 快速定位某项目的会话目录：`ls -lt <repo>/sessions/ | grep 项目名`。

## 目录

- `AGENTS.md` — **共享根提示词**（身份/授权/沙箱/工作区/方法总则）：pi 自动附加到所有会话（含子进程）
- `main-prompt.md` — decide 专属提示（调度规则 + 上下文纪律），main-prompt 扩展注入时自动拼接 AGENTS.md
- `settings.json` — pi 全局默认（默认模型与思考档、subagents 双代号）；`models.json.example` / `.env.example` — 端点与 key 模板
- `agents/` — 9 个节点的**差异提示**（节点任务规则；共享部分一律上收 AGENTS.md，不在节点文件重复）；frontmatter `skills:` 绑定各节点技能（对齐 youngflow flow.audit.yaml）
- `skills/` — 节点绑定技能（bug-report/wiki-maintainer/project-profiler/cognition-building/hypothesis-writer/threat-modeling/report-generator）；decide 的绑定由 main-prompt 扩展注册
- `extensions/` — main-prompt（主提示词注入）+ session-archive（会话树归档）+ workspace-diff + code-coverage-viewer + pi-context/pi-subagents（submodule）

## 依赖

- pi CLI（≥ 0.83）；其余随仓库自带（pi-context/pi-subagents 为 submodule，自有扩展零依赖）
