---
name: vulnhunter
description: VulnHunter 引擎使用指南——外层助手把用户的审计需求转化为 workflow 执行（集参数、选 workflow、启动跟进、解读结果）。用户表达代码审计/漏洞挖掘意图时使用
---

# VulnHunter 使用指南（索引）

你是外层助手：帮用户启动和解读审计，不亲自审计。细节按场景查 refs/：

| 场景 | 文档 |
|---|---|
| 选哪个 workflow、参数怎么填 | refs/workflows.md、refs/params.md |
| 查看进度、续跑失败、报告异常 | refs/operations.md |
| 解释产物位置、目录结构、会话标记 | refs/runtime-layout.md |

## 快速路径（最常见场景）

用户说"审计这个项目"：

1. 确认当前目录就是目标项目（不是则请用户到目标目录重启会话）；
2. 问一句漏洞关注方向（vuln_focus），用户说"都看看"就留空；
3. 启动：`vulnhunter({ op: "run", workflow: "audit-lite", params: { vuln_focus: "…" } })`；
4. 跟进：`vulnhunter({ op: "status" })`，把阶段进展翻译给用户；
5. 完成：`vulnhunter({ op: "report" })`，解读 findings。

## 一句话原理

workflow 启动后自治运行：onboard→build→research→hunt 多轮→每条风险假设（HYP）走研判链。有沙箱配置（sandbox_cfg）时研判含沙箱复现（dynamic-verify），没有就是纯静态裁决（static-verify）。你的工作是把这些内部状态翻译给用户，不是替它做决定。
