# 运行时目录结构（产物都在这）

目标项目根目录下运行后：

```
<目标项目>/.vulnforge/          ← 工作区根（产物全在这）
├── leads/                      ← 新产出队列（HYP/ADV/LEAD 落盘第一站）
├── todo/                       ← 已派发待处理
├── done/                       ← 已办结
├── findings/BUG-*/report.yaml  ← 确认的漏洞报告（最终产物）
├── knowledge/                  ← 项目认知（wiki/vuln-policy/worklog…）
├── runs/<runId>.json           ← run 状态：各阶段 done/failed/pending
└── sessions-lineage.jsonl      ← 会话血缘（每次 mark/跳转/fork/摘要一行）
```

会话记录（含思考过程）在引擎仓 `sessions/--<目标路径slug>--/*.jsonl`。

## 队列语义

`leads → todo → done`：产出不删，只移动。同一文件重复进出是幂等的（模型有手，编排器只挪位置）。

## 会话标记（marks）速览

会话树上打的结构标记，回答"跑到哪了"就靠它：

- `<任务>-start[成分]` / `<任务>-done[成分][+产物]`——任务起止；成分=它继承的上下文（如 `Σ(on,bu,re)`=onboard/build/research 的摘要）
- `Σ(...)` = 该内容是摘要；裸代号 = 活的上下文
- `init`、`hunt1-done`、`Σhunt1-5`、`Σ(init..h2)·hunt1-H1` 是常见形态
- 研判链阶段代号：`sv`=static-verify、`dv`=dynamic-verify、`ev`=ev-assess

编号：HYP-<来源>-H<n>（如 HYP-hunt1-H2），确认后 BUG 继承同号（BUG-hunt1-H2）。

## 覆盖率

hunt 精读过的文件计入覆盖率（只统计 hunt 阶段）。scope.yaml 存在时有门禁（默认 90%）。
