# 运行时目录结构（产物都在这）

目标项目根目录下运行后：

```
<目标项目>/.vulnforge/          ← 工作区根，产物全在这
├── leads/                      ← 新产出队列（HYP/ADV/LEAD 落盘第一站）
├── todo/                       ← 已派发待处理
├── done/                       ← 已办结
├── findings/BUG-*/report.yaml  ← 确认的漏洞报告（最终产物）
├── knowledge/                  ← 项目认知（wiki、vuln-policy、worklog…）
├── runs/<runId>.json           ← run 状态：各阶段 pending/done/failed
└── sessions-lineage.jsonl      ← 会话血缘（每次 mark/跳转/fork/摘要一行）
```

会话记录（含思考过程）在引擎仓 `sessions/--<目标路径slug>--/*.jsonl`。

## 队列语义

`leads → todo → done`：产物只移动、不删除；重复进出幂等，编排器只挪位置，不会重复派发。

## 会话标记（marks）速览

会话树上的结构标记，回答"跑到哪了"靠它：

- `<任务>-start[成分]` / `<任务>-done[成分][+产物]`——任务起止；成分 = 该会话启动时的上下文（如 `Σ(on,bu,re)` = onboard/build/research 的摘要）；
- `Σ(...)` = 摘要，裸代号 = 完整现场；
- 常见形态：`init`、`hunt1-done`、`Σhunt1`（小轮摘要）、`Σhunt1-5`（大轮摘要）、`Σ(init..h1)·hunt1-H1`；
- 研判链阶段代号：`sv`=static-verify、`dv`=dynamic-verify、`ev`=ev-assess。

编号：`HYP-<来源>-H<n>`（如 `HYP-hunt1-H2`）；确认后 BUG 继承同号（`BUG-hunt1-H2`）。

## 覆盖率

hunt 精读过的文件计入覆盖率（只统计 hunt 阶段）；统计目标由 `coverage.yaml`（runner 参数 coverage_include/exclude 落盘，支持 `*` 通配如 `*.c`）圈定，默认全项目仅排点目录。文件按内容判定文本/二进制（文本类计入分母，二进制不计）；工作区 `.vulnforge` 不记录不统计。
