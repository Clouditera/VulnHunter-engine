# 运行操作（run / status / resume / report）

所有操作走 `vulnhunter` 工具；错误返回是教学式的（`ERROR:` 开头 + 正确用法），看懂了照改即可。

## run——启动

```
vulnhunter({ op: "run", workflow: "audit-lite", params: { vuln_focus: "内存安全" } })
```

后台执行，立刻返回；一次只能跑一个 workflow（已有在跑会先让你看 status）。

## status——查进度

返回当前在跑的 workflow、最近日志、历史 run 各阶段状态。用户问"跑到哪了"：先 status，再翻译，别自己猜。

## resume——断点续跑

阶段失败（如 API 故障）后：

```
vulnhunter({ op: "resume", workflow: "audit-lite" })                 // 自动从上次 failed 阶段续
vulnhunter({ op: "resume", workflow: "audit-lite", from: "hunt1" })  // 或显式指定阶段
```

续跑复用同一份 run-state 与已落盘产物，已完成的阶段不会重跑。

## report——结果

返回 findings 一览：编号 / finding_class（vulnerability 或 risk）/ CVSS / EV / 优先级 / 标题。解读给用户时：

- vulnerability 且高 EV 的是重点；risk 是弱点记录，不算漏洞；
- 每条的完整报告在 `.vulnforge/findings/<编号>/report.yaml`，用户要细节就指给他。

## 常见异常

| 现象 | 含义与处理 |
|---|---|
| status 显示 error + "API 不可用" | 模型端故障；稍后用 resume 续跑 |
| 某阶段 failed | 日志里有原因；修复环境后 resume from 该阶段 |
| 长时间无新日志 | 大概率是模型在生成超长内容；超过 20 分钟无动静再考虑报告用户 |
