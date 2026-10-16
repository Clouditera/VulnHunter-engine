# 小规模审计模式 + 有效产出停轮 — 设计规格（HALL-64）

分支：`feature/small-audit-mode`。本文件是研发实现依据，判定规则以本文伪代码为准。

## 1. 小模式分流与全量直审

audit-lite 启动时在 onboard 后按 LOC 分流：

```
loc = count_loc(coverage_include, coverage_exclude)   # 复用现有覆盖率统计口径
if loc < audit_small_max_loc:                          # 新参数，默认 5000，可配置
    mode = SMALL
else:
    mode = HUNT   # 现有流程，行为不变
```

SMALL 模式流程：`onboard → build → research → 全文装配 → 1 轮 HYP 生成 → 有效产出判定 → 可选第 2 轮 → chains`。

- **跳过 hunt 多轮结构**：不创建 hunt 逐轮精读会话，无 Σhunt 摘要链。
- **全文装配**：coverage 口径内全部文本文件一次进入单会话上下文；装配预算 = 模型上下文窗口 × 60%（与现有摘要触发线一致）。若装配超预算（阈值内但文件特大），降级回 HUNT 模式并在日志记录原因。
- **第 2 轮是否必要**：由第 3 节判定器决定（第 1 轮后跑一次判定，触发即不跑第 2 轮直接进 chains）。
- 阶段落盘文件沿用 `.vulnforge/` 现有布局，小模式标记 `mode: small` 写入运行元数据，便于复盘统计。

## 2. HYP 卡 schema 扩展 + 准入闸

### 2.1 新字段（必填）

| 字段 | 取值 | 说明 |
|---|---|---|
| `novelty_basis` | 自由文本 | 与本项目已有 HYP 的差异点；必须为具体表述（"与 HYP-x 不同在于…"或"首个涉及 xx 函数 yy 模式的假设"），空值/占位文本视为缺失 |
| `confidence` | high / med / low | 提出者自评把握度 |

### 2.2 准入闸（入库前判定，伪代码）

```
def admit(new_hyp, existing_hyps):
    # 去重：同靶点(函数/代码位置) + 同漏洞模式 视为变体
    for h in existing_hyps:
        if same_target(h, new_hyp) and same_vuln_class(h, new_hyp):
            return REJECT_DUP        # 不计入新增，仅日志记录
    if new_hyp.confidence == "low" and is_empty(new_hyp.novelty_basis):
        return REJECT_LOW_QUALITY  # 不计入新增
    return ADMIT

same_target / same_vuln_class 第一版用规则判定：
- same_target: 归一化后的函数名/文件:行 相同
- same_vuln_class: 漏洞类别标签相同（CWE/模式词表匹配）
不引入语义向量，保持实现简单；接口留 `similarity(a,b)` 单点，后续可换实现。
```

被 REJECT 的 HYP 写入 `.vulnforge/rejected_hyps.log`（含理由），不进 chains，不计入任何新增统计。

## 3. 有效产出停轮判定器

### 3.1 定义

```
effective_new(round) = 该轮 ADMIT 的 HYP 数   # REJECT 不计
conversion(round)    = 该轮 HYP → finding 数 / 该轮 HYP 数（链裁决后回填）
```

### 3.2 停轮规则（伪代码）

```
def should_stop(rounds, coverage):   # rounds = 历史轮统计列表
    r = last(rounds)
    if coverage < hunt_coverage_threshold:      # 默认 90
        return CONTINUE
    trigger = (
        effective_new(r) < 3
        or conversion(last2(rounds)) == 0       # 近 2 轮转化率均为 0
        or effective_new(r) < effective_new(prev(r)) / 2   # 边际减半
    )
    if not trigger:
        return CONTINUE
    if r.is_confirmation_round:                 # 确认轮再零有效新增 → 停
        return STOP if effective_new(r) == 0 else CONTINUE
    return CONFIRM   # 下一轮为确认轮（最多 1 次）

# HALL-69：显式 rounds 优先（给了就只以它为准，0=无上限）；k ≤ 0 关闭自动上限
if rounds_param_given:
    hard_cap = Infinity if rounds_param == 0 else rounds_param
else:
    hard_cap = clamp(k * log10(loc), 2, 15)  # k=5 初始值，可配置 hunt_max_rounds；k ≤ 0 时 hard_cap = Infinity
当前轮数 ≥ hard_cap → STOP（无条件）
# 显式与自动都为 Infinity（完全无上限）时，启动 report 提示：只剩判定器熔断兜底
```

### 3.3 兼容策略

- `hunt_zero_rounds` 保留但标记 deprecated：文档注明"已废弃，由有效产出判定取代"，代码保留读取但不参与判定；运行时若用户显式传了该参数，打 warning 日志。
- `rounds` 显式封顶语义（HALL-69 修正）：给了就只以它为准，不再与自动上限取 min；`rounds=0` 表示显式无上限。`hunt_max_rounds`(k) ≤ 0 时关闭自动硬上限（auto=Infinity）。

## 4. 验收方式

用户自测（不在本次研发范围），参考预期：kilo（1.4k 行）复跑走 SMALL 模式、≤2 小时、findings 质量不劣于 HALL-63 基线（15 个）、第 2 轮应被判定跳过。

## 范围外（不做）

- 摘要外部化 / Digest Store / 召回机制（后续单独立项）
- 轮次并行化
- 动态验证默认开启
