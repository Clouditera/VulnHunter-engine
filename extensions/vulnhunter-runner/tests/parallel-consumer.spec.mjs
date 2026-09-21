/**
 * dry run：hunt ∥ verify 常驻消费——事件驱动验证（真执行器/真事件/真选举；假任务不碰模型）。
 * 运行：node tests/parallel-consumer.spec.mjs（先构建 .dist）
 * 断言：容量重叠窗口、不重复派发、收干退出、断点续跑语义、下游优先。
 */
import { createExecutor } from "../.dist/src/executor/index.js";
import { createWakeQueue, electVerifyCandidates, runVerifyConsumer } from "../.dist/src/workflows/lib.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

function makeWorkdir() {
  const W = join(tmpdir(), `dryrun-parallel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(W, "system", "hyp"), { recursive: true });
  return W;
}
function writeHyp(W, id, status = "new", conclusion = "") {
  writeFileSync(join(W, "system", "hyp", `${id}.json`),
    JSON.stringify({ id, tag: "hunt", status, conclusion, body: "", verdict: "", createdAt: "", updatedAt: "" }));
}

await t("dryrun：并行消费——重叠窗口、不重复、收干", async () => {
  const W = makeWorkdir();
  const exec = createExecutor();
  exec.bindCapacity("model", { permits: 2 });
  const verifyPool = exec.declarePool("verify", { concurrency: 2, priority: 10, needs: ["model"] });
  const wakeups = createWakeQueue();
  const unsub = exec.on((e) => { if (e.type === "task.end") wakeups.push(); });

  const data = { roundHyps: { hunt1: [], hunt2: [] }, roundSigma: { hunt1: [], hunt2: [] } };
  const ctx = { workdir: W, report: () => {} };
  const completed = new Map();
  const startedAt = new Map();
  let active = 0, maxActive = 0;
  let settled = false;

  const produce = (rn, id) => { writeHyp(W, id); data.roundHyps[rn].push(`${id}.json`); wakeups.push(); };

  const consumer = runVerifyConsumer({
    candidates: () => electVerifyCandidates(ctx, data, { includeResearch: settled }),
    markRunning: () => {},
    runOne: (c) => verifyPool.submit(async () => {
      startedAt.set(c.id, Date.now());
      active++; maxActive = Math.max(maxActive, active);
      await sleep(60 + Math.floor(Math.random() * 80));
      active--;
      completed.set(c.id, (completed.get(c.id) ?? 0) + 1);
      writeHyp(W, c.id, "closed", "confirmed");   // 模拟裁决回写
      return "done";
    }).then(() => "done"),
    slotsFree: () => { const p = exec.stats().pools.find((x) => x.name === "verify"); return p ? Math.max(0, p.concurrency - p.running.length) : 0; },
    settled: () => settled,
    wakeup: () => wakeups.pop(),
    notify: () => wakeups.push(),
    report: () => {},
  });

  const t0 = Date.now();
  wakeups.push();
  await sleep(140); produce("hunt1", "HYP-hunt1-H1");
  await sleep(140); produce("hunt1", "HYP-hunt1-H2");
  await sleep(140); produce("hunt2", "HYP-hunt2-H1");
  await sleep(140); settled = true; wakeups.push();   // 模拟 hunt 收尾
  const settleAt = Date.now();
  const r = await consumer;
  unsub();

  assert(r.dispatched === 3, `派发数=3，实际 ${r.dispatched}`);
  assert(r.done === 3, `完成数=3，实际 ${r.done}`);
  assert([...completed.values()].every((n) => n === 1), "不重复派发");
  assert(maxActive <= 2, `并发不超池上限，实际 ${maxActive}`);
  assert(startedAt.size === 3, "三条都启动过");
  assert(Math.min(...startedAt.values()) < settleAt, "消费在 hunt 落定前就已开工（重叠）");
  console.log("  时间线:", [...startedAt.entries()].map(([k, v]) => `${k.replace("HYP-", "")}@+${v - t0}ms`).join(" "), `| settled@+${settleAt - t0}ms`);
  rmSync(W, { recursive: true, force: true });
});

await t("dryrun：断点续跑——已办结跳过、未办结续派、立即收干", async () => {
  const W = makeWorkdir();
  writeHyp(W, "HYP-hunt1-H1", "closed", "confirmed");   // 已办结
  writeHyp(W, "HYP-hunt1-H2");                          // 上次被杀的残留
  const wakeups = createWakeQueue();
  const data = { roundHyps: { hunt1: ["HYP-hunt1-H1.json", "HYP-hunt1-H2.json"] }, roundSigma: {} };
  const ctx = { workdir: W, report: () => {} };
  const ran = [];
  const r = await runVerifyConsumer({
    candidates: () => electVerifyCandidates(ctx, data, { includeResearch: true }),
    markRunning: () => {},
    runOne: (c) => { ran.push(c.id); return Promise.resolve("done"); },
    slotsFree: () => 2,
    settled: () => true,
    wakeup: () => wakeups.pop(),
    notify: () => wakeups.push(),
    report: () => {},
  });
  assert(r.dispatched === 1 && ran[0] === "HYP-hunt1-H2", `只补未办结的，实际 ${JSON.stringify(ran)}`);
  rmSync(W, { recursive: true, force: true });
});

await t("dryrun：容量紧时下游优先（verify 先于 hunt 拿到许可）", async () => {
  const exec = createExecutor();
  exec.bindCapacity("model", { permits: 1 });
  // 两池容量都留足，让两个任务都真实排到容量门上——优先级只在门上生效
  const verifyPool = exec.declarePool("verify", { concurrency: 2, priority: 10, needs: ["model"] });
  const huntPool = exec.declarePool("hunt", { concurrency: 2, priority: 30, needs: ["model"] });
  const order = [];
  let releaseHold;
  const hold = verifyPool.submit(async () => {
    order.push("holder");
    await new Promise((r) => { releaseHold = r; });
  });
  await sleep(20);
  const h = huntPool.submit(async () => { order.push("hunt"); });   // 先到门上（p30）
  await sleep(20);
  const v = verifyPool.submit(async () => { order.push("verify"); });   // 后到门上（p10）
  await sleep(20);
  releaseHold();
  await Promise.all([hold, h, v]);
  assert(order[0] === "holder", "占位任务先跑");
  assert(order[1] === "verify" && order[2] === "hunt", `下游优先顺序，实际 ${order.join(">")}`);
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
