# 参数参考

`vulnhunter({ op: "run", workflow, params: {…} })` 的 params 全部可选键：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| vuln_focus | 建议给 | 无（全方向） | 漏洞关注方向，如"内存安全与输入解析问题" |
| sandbox_cfg | 否 | 无 | 沙箱 ssh 连接配置（如 `ssh sandbox-x`）。给了=研判含沙箱复现（dynamic-verify→ev-assess）；不给=纯静态（static-verify） |
| rounds | 否 | 按项目规模推断 | hunt 轮数 |
| chain_filter | 否 | 全部 | 每轮最多几条 HYP 走研判链（限成本用，如 "2"） |
| output_lang | 否 | zh-CN | 产物输出语言 |
| audit_scope | 否 | 全项目 | 审计范围说明（audit-direct 用得多） |

## 建议的询问策略

- 必问：无（当前目录即目标）。
- 建议问一句：漏洞关注方向（用户说"都看看"就留空）。
- 有沙箱需求才谈 sandbox_cfg：用户希望真复现漏洞时再给，并确认沙箱 ssh 可达。
- 其余都用默认，别逐项问。
