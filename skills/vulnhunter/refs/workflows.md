# workflow 选择

## 可选 workflow

| workflow | 适用 | 阶段结构 |
|---|---|---|
| **audit-lite** | 轻量审计（<1 万行小项目） | onboard→build→research→compress→hunt→chains |

`chains` 指每条 HYP 的研判链。**当前只提供 audit-lite**；中等/大型项目的流程在重写中，用户问起如实说明支持有限。

## 动态 / 静态分支（由沙箱配置决定，不是独立 workflow）

- 给了 `sandbox_cfg` → 研判链走 **dynamic-verify**（研判 + 沙箱复现合并），复现成功且 EXP 待评估的接 ev-assess；
- 没给 → 只走 **static-verify**（纯静态裁决，不编译、不运行目标）。

## hunt 多轮与摘要（用户问起再展开）

hunt 单会话逐轮推进：每轮选一个千行级小功能点精读；停轮 = 有效产出判定器（覆盖≥阈值 且（有效新增<3 / 近 2 轮转化率=0 / 有效新增边际减半）→ 确认轮零有效新增即停），硬上限 = min(rounds 显式封顶, clamp(5·log10(loc), 2, 15))，k 可用 hunt_max_rounds 调。摘要两档：每轮结束把本轮压成小摘要（ΣhuntN），上下文占用超 60% 时对历史全 hunt 做一次大摘要（Σhunt1-N）。每条 HYP 成链时，链会话 fork 自它出生轮的 `huntN-done` 标记，启动时对 init→出生轮做引导式摘要（HYP 正文当相关性过滤器）。
