/**
 * 有效产出停轮判定器（HALL-64 子任务3；设计规格 docs/design/small-audit-mode.md 第 3 节）。
 *
 * 定义：
 *   effective_new(round) = 该轮 ADMIT 的 HYP 数（REJECT 不计）
 *   conversion(round)    = 该轮 HYP → finding 数 / 该轮 HYP 数（链裁决后回填，可为 null=尚无数据）
 *
 * 停轮规则（伪代码对应规格 §3.2）：
 *   coverage < 阈值 → CONTINUE
 *   trigger = 有效新增<3 / 近 2 轮转化率均为 0 / 有效新增 < 前轮一半
 *   未触发 → CONTINUE；触发且当前为确认轮 → 零有效新增即停；否则 → CONFIRM（下一轮为确认轮，最多 1 次）
 *
 * 硬上限 hardCap 语义（HALL-69 修正）：
 *   - 显式 rounds 优先：给了就只以显式值为准，不再与 auto 取 min；rounds=0 表示显式无上限（Infinity）。
 *   - 自动上限默认关闭（HALL-69 追加）：k（hunt_max_rounds）缺省 0，≤ 0 时 auto = Infinity；
 *     显式传 k ≥ 1 可重新打开（clamp(k·log10(loc), 2, 15)）。
 *   - 完全无上限（无显式 rounds 且 auto=Infinity）时 workflow 启动 report 提示——只剩判定器熔断兜底。
 *
 * 兼容（§3.3）：hunt_zero_rounds 保留读取但 deprecated——不参与判定；显式传入打 warning。
 *
 * 判定器同时服务 SMALL 模式（决定第 2 轮是否跑）与 HUNT 模式（替换零新增条件）。
 */

// ---------------------------------------------------------------------------
// 轮统计与输入输出类型
// ---------------------------------------------------------------------------

export interface RoundStat {
  /** 该轮 ADMIT 的 HYP 数（有效新增） */
  effectiveNew: number;
  /** 该轮提出的 HYP 总数（含后续可能被 REJECT 的；转化率分母） */
  hypCount?: number;
  /** 该轮 HYP 最终转成 finding 的条数（链裁决后回填；undefined=尚无数据） */
  findings?: number;
  /** 是否确认轮（上一轮触发条件后的最后一搏，最多 1 次） */
  isConfirmationRound?: boolean;
}

export interface StopDecisionInput {
  /** 历史轮统计（按轮序；最后一项 = 当前轮） */
  rounds: RoundStat[];
  /** 当前覆盖率（0-100 或 0-1 小数皆可，调用侧统一成 0-100 传入） */
  coverage: number;
  /** 覆盖率阈值（默认 90） */
  coverageThreshold?: number;
  /** 目标 LOC（自动硬上限用；undefined 时不启用自动上限） */
  loc?: number;
  /** 自动上限系数 k（hunt_max_rounds 参数，默认 0=关闭；≥1 启用 clamp(k·log10(loc),2,15)） */
  maxRoundsK?: number;
  /** rounds 显式封顶（给了就只以它为准，不再与 auto 取 min；0 = 无上限） */
  explicitMaxRounds?: number;
  /** 当前已完成轮数（含本轮） */
  currentRound: number;
}

export type StopDecision =
  | { action: "continue" }
  | { action: "confirm"; reason: string }
  | { action: "stop"; reason: string };

// ---------------------------------------------------------------------------
// 有效产出 / 转化率
// ---------------------------------------------------------------------------

export function effectiveNew(r: RoundStat): number {
  return r.effectiveNew;
}

/** 单轮转化率：无 HYP 记 0；无回填数据返回 null（不用于判定） */
export function conversion(r: RoundStat): number | null {
  const total = r.hypCount;
  if (total === undefined || r.findings === undefined) return null;
  if (total <= 0) return 0;
  return r.findings / total;
}

/** 近 2 轮转化率：两轮都有数据才返回数组，否则 null */
function last2Conversions(rounds: RoundStat[]): number[] | null {
  if (rounds.length < 2) return null;
  const a = conversion(rounds[rounds.length - 2]);
  const b = conversion(rounds[rounds.length - 1]);
  return a === null || b === null ? null : [a, b];
}

// ---------------------------------------------------------------------------
// 硬上限
// ---------------------------------------------------------------------------

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * 硬上限（HALL-69 修正版 + 默认值追加）：
 *   - 显式 rounds 优先：给定时只以显式值为准（不再与 auto 取 min）；0 表示无上限（Infinity）。
 *   - 自动上限 auto = clamp(k*log10(loc), 2, 15)；k 缺省 0（默认关闭），≤ 0 时 auto = Infinity；
 *     显式传 k ≥ 1 可重新打开；无 loc 时亦 Infinity。
 */
export function hardCap(opts: { loc?: number; k?: number; explicitMaxRounds?: number }): number {
  if (opts.explicitMaxRounds !== undefined) return opts.explicitMaxRounds <= 0 ? Infinity : opts.explicitMaxRounds;
  const k = opts.k ?? 0;
  if (k <= 0) return Infinity;
  return opts.loc !== undefined && opts.loc > 0 ? clamp(k * Math.log10(opts.loc), 2, 15) : Infinity;
}

// ---------------------------------------------------------------------------
// 停轮判定
// ---------------------------------------------------------------------------

export function shouldStop(input: StopDecisionInput): StopDecision {
  const threshold = input.coverageThreshold ?? 90;
  const rounds = input.rounds;
  const r = rounds[rounds.length - 1];
  if (!r) return { action: "continue" };

  // 无条件硬上限
  const cap = hardCap({ loc: input.loc, k: input.maxRoundsK, explicitMaxRounds: input.explicitMaxRounds });
  if (input.currentRound >= cap) {
    return { action: "stop", reason: `达到轮数硬上限（${input.currentRound} ≥ ${cap}）` };
  }

  if (input.coverage < threshold) return { action: "continue" };

  // 触发条件（规格 §3.2）
  const reasons: string[] = [];
  if (effectiveNew(r) < 3) reasons.push(`有效新增 ${effectiveNew(r)} < 3`);
  const last2 = last2Conversions(rounds);
  if (last2 !== null && last2[0] === 0 && last2[1] === 0) reasons.push("近 2 轮转化率均为 0");
  const prev = rounds.length >= 2 ? rounds[rounds.length - 2] : undefined;
  if (prev && effectiveNew(r) < effectiveNew(prev) / 2) {
    reasons.push(`有效新增边际减半（${effectiveNew(r)} < ${effectiveNew(prev)}/2）`);
  }
  if (!reasons.length) return { action: "continue" };

  if (r.isConfirmationRound) {
    return effectiveNew(r) === 0
      ? { action: "stop", reason: `确认轮零有效新增（触发：${reasons.join("；")}）` }
      : { action: "continue" };
  }
  return { action: "confirm", reason: reasons.join("；") };
}
