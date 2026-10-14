# 运行时目录结构（产物都在这）

目标项目根目录下运行后：

```
<目标项目>/.vulnforge/          ← 工作区根，所有产物都在这
├── knowledge/                  ← 知识区（纯文档，自由读写）
│   ├── wiki/                   ← 项目理解知识库（index、overview、各主题）
│   ├── security.md             ← 安全基线（威胁模型＋漏洞认可口径）
│   ├── research/               ← 情报档案（历史漏洞、上游动态…）
│   └── env/                    ← 环境记录（构建/部署理解、沙箱使用）
├── findings/                   ← 漏洞出口（引擎工具维护）
│   └── BUG-<编号>/             ← record.json（报告全字段）＋ attachments/（poc/exp 证据附件）
└── system/                     ← 内部状态（引擎独占，助手不用看）
    ├── hyp/                    ← HYP 风险假设记录
    ├── runs/<runId>.json       ← run 状态：各阶段 pending/done/failed
    ├── sandbox.json            ← 沙箱可用性（调度门禁依据）
    ├── profiler.json           ← 项目画像
    └── sessions-lineage.jsonl  ← 会话台账（血缘、任务、折叠）
```

会话记录（含思考过程）在**工作区** `<workdir>/system/sessions/--<目标路径slug>--/*.jsonl`（平台任务模式即任务卷的 `output/system/sessions/`；随工作区迁移，沙箱重建后可续跑）。

说明：`knowledge/` 是唯一自由文档区；HYP/finding/sandbox/profiler 等结构化对象由引擎工具独家落盘，内容不要手改。旧版队列目录（leads/todo/done）与 vuln-policy.md、build.md、profiler.yaml 已下线——口径并入 security.md、环境并入 env/、画像进系统侧。

## 对象流转语义

HYP 状态：待判 → 在判 → 办结（裁决回写后办结）；finding 一经产出即为最终出口，poc/exp 状态由研判链回写。产物只增不删。

## 会话标记（marks）速览

会话树上的结构标记，回答“跑到哪了”靠它：

- `<任务>-start[成分]` / `<任务>-done[成分][+产物]`——任务起止；成分 = 该会话启动时的上下文（如 `Σ(on,bu,re)` = onboard/build/research 的摘要）；
- `Σ(...)` = 摘要，裸代号 = 完整现场；
- 常见形态：`init`、`hunt1-done`、`Σhunt1`（小轮摘要）、`Σhunt1-5`（大轮摘要）、`Σ(init..h1)·hunt1-H1`；
- 研判链阶段代号：`sv`=static-verify、`dv`=dynamic-verify、`ev`=ev-assess。

编号：`HYP-<来源>-H<n>`（如 `HYP-hunt1-H2`）；确认后 BUG 继承同号（`BUG-hunt1-H2`）。

## 覆盖率

hunt 精读过的文件计入覆盖率（只统计 hunt 阶段）；统计目标由 `coverage.yaml`（引擎参数 coverage_include/exclude 落盘，支持 `*` 通配如 `*.c`）圈定，默认全项目仅排点目录。文件按内容判定文本/二进制（文本类计入分母，二进制不计）；工作区 `.vulnforge` 不记录不统计。
