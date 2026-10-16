/**
 * 有效产出停轮判定器单测（HALL-64 子任务3；规格 docs/design/small-audit-mode.md §3）。
 * 运行：node extensions/vulnhunter-runner/tests/stop-decider.spec.mjs
 */
import { shouldStop, hardCap, conversion, clamp } from "../src/stop-decider.ts";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { console.log("PASS", name); pass++; }
  else { console.log("FAIL", name); fail++; }
}

// ---- clamp / hardCap ----
ok(clamp(5, 2, 15) === 5 && clamp(1, 2, 15) === 2 && clamp(99, 2, 15) === 15, "clamp 边界");
// 缺省 k=0（HALL-69 追加：默认关闭自动上限）：loc=1000/k=5 显式 → 15；k≤0 → Infinity
ok(hardCap({ loc: 1000 }) === Infinity, "缺省 k=0 → 默认无自动上限");
ok(hardCap({ loc: 1000, k: 5 }) === 15, "显式 k=5 重新打开上限：loc=1000 → 15");
ok(hardCap({ loc: 100, k: 5 }) === 10, "k=5：loc=100 → 10");
ok(hardCap({ loc: 10, k: 5 }) === 5, "k=5：loc=10 → 5");
ok(hardCap({ loc: 1, k: 5 }) === 2, "k=5：loc=1 → 下限 2");
ok(hardCap({}) === Infinity, "无 loc 无 k → 无上限");
// HALL-69：显式 rounds 优先——给了就只以它为准，不再与 auto 取 min
ok(hardCap({ loc: 10, k: 5, explicitMaxRounds: 3 }) === 3, "显式 rounds=3 → 3");
ok(hardCap({ loc: 1000, k: 5, explicitMaxRounds: 1 }) === 1, "显式 rounds < 2 优先于下限保护");
ok(hardCap({ loc: 1000, k: 5, explicitMaxRounds: 100 }) === 100, "显式 rounds=100 不再被 auto=15 截断");
ok(hardCap({ loc: 1000, k: 5, explicitMaxRounds: 0 }) === Infinity, "显式 rounds=0 → 无上限");
// HALL-69：k ≤ 0 关闭自动上限
ok(hardCap({ loc: 1000, k: 0 }) === Infinity, "k=0 → 无自动上限");
ok(hardCap({ loc: 1000, k: -1 }) === Infinity, "k<0 → 无自动上限");
// 显式与自动双无上限 → Infinity（report 提示在 workflow 层）
ok(hardCap({ k: 0, explicitMaxRounds: 0 }) === Infinity, "双无上限 → Infinity");
ok(hardCap({ loc: 10, k: 2 }) === 2, "k 可配置（hunt_max_rounds）");

// ---- conversion ----
ok(conversion({ effectiveNew: 3, hypCount: 4, findings: 2 }) === 0.5, "conversion 正常值");
ok(conversion({ effectiveNew: 0, hypCount: 0, findings: 0 }) === 0, "conversion 零 HYP = 0");
ok(conversion({ effectiveNew: 3 }) === null, "conversion 无回填 = null");

const R = (effectiveNew, extra = {}) => ({ effectiveNew, ...extra });

// ---- HALL-69：rounds=0 显式无上限 + k=0 关闭自动上限（shouldStop 路径） ----
{
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 50, loc: 1000, explicitMaxRounds: 0 });
  ok(d.action === "continue", "rounds=0 → 50 轮也不触发硬上限");
}
{
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 20, loc: 1000, maxRoundsK: 0 });
  ok(d.action === "continue", "k=0 → 20 轮不触发硬上限");
}
{
  // 缺省 maxRoundsK（=0）：同样无自动上限
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 50, loc: 1000 });
  ok(d.action === "continue", "缺省 k=0 → 50 轮也不触发硬上限");
}
{
  // 显式 k≥1 重新打开自动上限
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 15, loc: 1000, maxRoundsK: 5 });
  ok(d.action === "stop" && /硬上限/.test(d.reason), "显式 k=5 重新打开上限 → 15 轮到顶 stop");
}
{
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 100, loc: 1000, explicitMaxRounds: 100 });
  ok(d.action === "stop" && /硬上限/.test(d.reason), "rounds=100 → 100 轮仍到顶 stop");
}

// ---- 覆盖未达标 → CONTINUE ----
{
  const d = shouldStop({ rounds: [R(0)], coverage: 50, coverageThreshold: 90, currentRound: 1 });
  ok(d.action === "continue", "覆盖未达标 → continue");
}

// ---- 有效新增 < 3 → CONFIRM ----
{
  const d = shouldStop({ rounds: [R(5), R(2)], coverage: 95, currentRound: 2 });
  ok(d.action === "confirm" && /有效新增 2 < 3/.test(d.reason), "有效新增<3 → confirm");
}

// ---- 确认轮零有效新增 → STOP ----
{
  const d = shouldStop({ rounds: [R(2), R(0, { isConfirmationRound: true })], coverage: 95, currentRound: 2 });
  ok(d.action === "stop" && /确认轮零有效新增/.test(d.reason), "确认轮零新增 → stop");
}

// ---- 确认轮仍有有效新增 → CONTINUE ----
{
  const d = shouldStop({ rounds: [R(2), R(2, { isConfirmationRound: true })], coverage: 95, currentRound: 2 });
  ok(d.action === "continue", "确认轮有新增 → continue");
}

// ---- 近 2 轮转化率均为 0 → CONFIRM ----
{
  const rounds = [
    R(4, { hypCount: 4, findings: 0 }),
    R(4, { hypCount: 4, findings: 0 }),
  ];
  const d = shouldStop({ rounds, coverage: 95, currentRound: 2 });
  ok(d.action === "confirm" && /转化率均为 0/.test(d.reason), "近2轮转化率=0 → confirm");
}

// ---- 转化率无回填数据 → 不触发该条件 ----
{
  const rounds = [R(4, { hypCount: 4 }), R(4, { hypCount: 4 })];
  const d = shouldStop({ rounds, coverage: 95, currentRound: 2 });
  ok(d.action === "continue", "转化率未回填 → 不触发");
}

// ---- 边际减半 → CONFIRM ----
{
  const d = shouldStop({ rounds: [R(6), R(2)], coverage: 95, currentRound: 2 });
  ok(d.action === "confirm" && /边际减半/.test(d.reason), "有效新增<前轮一半 → confirm");
}

// ---- 未触发 → CONTINUE ----
{
  const rounds = [R(4, { hypCount: 4, findings: 1 }), R(4, { hypCount: 4, findings: 2 })];
  const d = shouldStop({ rounds, coverage: 95, currentRound: 2 });
  ok(d.action === "continue", "健康轮 → continue");
}

// ---- 硬上限无条件 STOP（覆盖未达标也停；显式 k≥1 打开上限后生效） ----
{
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 15, loc: 1000, maxRoundsK: 5 });
  ok(d.action === "stop" && /硬上限/.test(d.reason), "达到硬上限 → stop");
}

// ---- 显式 rounds 封顶优先 ----
{
  const d = shouldStop({ rounds: [R(5)], coverage: 10, currentRound: 3, loc: 1000, explicitMaxRounds: 3 });
  ok(d.action === "stop", "显式 rounds=3 到顶 → stop");
}

// ---- SMALL 模式场景：第 1 轮后判定第 2 轮是否跑 ----
{
  // 第 1 轮有效新增充足 → continue（跑第 2 轮）
  const d1 = shouldStop({ rounds: [R(6)], coverage: 95, currentRound: 1 });
  ok(d1.action === "continue", "SMALL 第1轮新增充足 → continue");
  // 第 1 轮有效新增 < 3 且覆盖达标 → confirm（第 2 轮为确认轮）
  const d2 = shouldStop({ rounds: [R(1)], coverage: 95, currentRound: 1 });
  ok(d2.action === "confirm", "SMALL 第1轮新增<3 → confirm 第2轮");
}

console.log(`\nstop-decider.spec: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
