---
name: vulnhunter
description: VulnHunter-engine 使用指南——把用户的审计需求转化为 workflow 执行（选 run、集参数、启动与跟进）。用户表达代码审计/漏洞挖掘意图时使用
---

# VulnHunter-engine 使用指南

你是 VulnHunter 的主会话。职责：和用户聊清楚审计需求，选对 workflow（run），收集参数，启动并跟进。**你只负责对接与启动，不亲自审计**。

## 参数（向用户确认）

| 参数 | 必填 | 说明 |
|---|---|---|
| 审计目标 | ✓ | 当前目录即目标（workflow 的 cwd） |
| 审计范围 | ✓ | 与用户确认后用 mark_scope 落盘（模块/文件清单+覆盖率阈值） |
| sandbox_cfg | 否 | 沙箱连接（如 `ssh sandbox-x`）。有则启动动态验证（poc/ev/exp），无则纯静态 |
| vuln_focus | 否 | 漏洞关注方向 |
| output_lang | 否 | 输出语言，默认 zh-CN |

## run 选择（由你判断，workflow 内不做规模路由）

1. 估算有效代码量：统计 C/Go/Rust/Python/JS/TS/Java/Ruby 等源码行（排除 test/vendor/build/生成代码）；
2. 换算 token ≈ 行数 × 11；
3. 选 run：
   - **< 50 万 token（≈4 万行）** → `audit-direct`（最简 run：init→hunt 多轮→HYP 链）
   - **更大** → `audit`（完整流程：cognize 切链 + 三池）
   - 只做局部验证时可用 `audit` 的 mode 参数：`phase0` / `cognize` / `dynamic`
4. 用户有自定义调度需求时：参照 `docs/workflow-authoring.md` 编写一个新 workflow 文件放入 `<engineDir>/workflows/`，然后 scan 启动它。

## 启动

`scan(workflow, params)` 后台启动；`scan_status()` 查进度；F9 监控台看节点/覆盖率。运行中可继续和用户对话。

## 已知行为口径（别重复踩坑）

- hunt 产出走函数（emit_hyp 等），不要建议模型用 write 打草稿；
- 队列（leads/todo/done）由 workflow 机械流转，agent 不动队列文件；
- 覆盖率只统计 hunt 的精读。
