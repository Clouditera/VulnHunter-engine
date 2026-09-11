# workflow 选择

## 可选 workflow

| workflow | 适用 | 阶段结构 |
|---|---|---|
| **audit-lite** | 轻量审计，<1 万行的小项目 | onboard→build→research→compress→hunt×N→chains（每条 HYP 的研判链） |
| **audit-direct** | 标准审计，中等项目 | init（onboard→research 同会话）→hunt 多轮（积累制）→每 HYP 的 verify→ev 链 |

旧 audit.ts（全量大流程）处于退役边缘，不要向用户推荐。

## 规模口径

<1 万行 → audit-lite；更大 → audit-direct；10 万行以上的大型项目流程在重写中，先如实告诉用户支持有限。

## 动态/静态分支（由沙箱配置决定，不是独立 workflow）

- params 给了 `sandbox_cfg` → 研判链走 **dynamic-verify**（静态研判 + 沙箱复现合并），复现成功且 EXP 待评估的接 ev-assess；
- 没给 → 只走 **static-verify**（纯静态裁决，不编译不运行目标）。

## hunt 多轮的上下文机制（用户问起再解释）

hunt 各轮在同一会话里积累原文；每 5 轮或上下文占用超过 75% 时，把历史所有 hunt 一次性摘要化（摘要挂在 hunt-start 标记下）。每条 HYP 成链时，链会话 fork 自它出生轮的 huntN-done 标记，启动时对 init→出生轮做引导式摘要（HYP 正文当相关性过滤器）。
