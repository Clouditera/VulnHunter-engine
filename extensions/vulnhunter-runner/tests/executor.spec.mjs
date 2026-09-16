/**
 * 执行器验收用例（fish 09-15 五条 + 附加）
 * 运行：node tests/executor.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, writeFileSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor, MemoryQueue, FileQueue, TaskTimeoutError } from "../.dist/src/executor/index.js";

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

// ① N=1 顺序退化 + 下游优先：单发动机下两个池竞争，等待者按 priority 授让
await t("A. N=1 下游优先（verify 先于 hunt 得到发动机）", async () => {
  const ex = createExecutor();
  ex.bindCapacity("model", { permits: 1, agingMs: 60_000 });
  const up = ex.declarePool("up", { concurrency: 5, priority: 30, needs: ["model"] });
  const down = ex.declarePool("down", { concurrency: 5, priority: 10, needs: ["model"] });

  const order = [];
  const blocker = ex.acquire({ model: 1 }, async () => { await sleep(250); order.push("blocker"); });
  await sleep(20); // 确保 blocker 先占机
  const pDown = down.submit(async () => { await sleep(30); order.push("down"); }, { tag: "down-1" });
  await sleep(20);
  const pUp = up.submit(async () => { await sleep(30); order.push("up"); }, { tag: "up-1" });
  await Promise.all([blocker, pDown, pUp]);
  assert(JSON.stringify(order) === JSON.stringify(["blocker", "down", "up"]), `顺序=${order}`);
});

// ② 老化提升：低优先级等待超阈值后压过后来的高优先级
await t("B. 老化（等待超阈值的低优先任务先获得发动机）", async () => {
  const ex = createExecutor();
  ex.bindCapacity("model", { permits: 1, agingMs: 500 });
  const low = ex.declarePool("low", { concurrency: 5, priority: 50, needs: ["model"] });
  const high = ex.declarePool("high", { concurrency: 5, priority: 10, needs: ["model"] });

  const order = [];
  const blocker = ex.acquire({ model: 1 }, async () => { await sleep(700); order.push("blocker"); });
  await sleep(20);
  const pLow = low.submit(async () => { order.push("low"); }, { tag: "low-1" });
  await sleep(450); // low 已等待 ~430ms（>500ms 阈值的边缘）→ 再等一点
  await sleep(80);
  const pHigh = high.submit(async () => { order.push("high"); }, { tag: "high-1" });
  await Promise.all([blocker, pLow, pHigh]);
  assert(order[0] === "blocker" && order[1] === "low" && order[2] === "high", `顺序=${order}`);
});

// ③ 嵌套继承：N=1 下任务内嵌套加需不二次取发动机（否则死锁）
await t("C. 嵌套继承（model=1 沙箱嵌套不重入，不卡死）", async () => {
  const ex = createExecutor();
  ex.bindCapacity("model", { permits: 1 });
  ex.bindCapacity("sandbox", { permits: 1 });
  const pool = ex.declarePool("chain", { concurrency: 2, priority: 10, needs: ["model"] });

  let sawModelHeld = -1, sawSandboxHeld = -1;
  await pool.submit(async () => {
    await sleep(20);
    await ex.acquire({ sandbox: 1 }, async () => {
      const s = ex.stats();
      sawModelHeld = s.capacities.find((c) => c.name === "model").held.length;
      sawSandboxHeld = s.capacities.find((c) => c.name === "sandbox").held.length;
      await sleep(30);
    });
  }, { tag: "chain-1" });
  const s2 = ex.stats();
  assert(sawModelHeld === 1, `嵌套中 model held=${sawModelHeld}（应为 1，继承）`);
  assert(sawSandboxHeld === 1, `嵌套中 sandbox held=${sawSandboxHeld}`);
  assert(s2.capacities.every((c) => c.held.length === 0), "结束后全部释放");
});

// ④ 队列驱动：serve 抽干 + 失败重派（attempts 递增）
await t("D. serve 队列驱动（claim/ack/requeue，失败重派后成功）", async () => {
  const ex = createExecutor();
  const q = new MemoryQueue(["a", "failme", "b", "failme2", "c"]);
  ex.declareQueue("items", { backend: q });
  ex.declarePool("worker", { concurrency: 2 });

  const done = [], errors = [];
  await ex.serve({
    queue: "items", pool: "worker",
    consumer: async (item) => {
      await sleep(25);
      if ((item.payload === "failme" || item.payload === "failme2") && item.attempts === 1) throw new Error("第一次必挂");
      done.push(`${item.payload}#${item.attempts}`);
    },
    onError: (item) => { errors.push(item.id); },
  });
  assert(q.size() === 0 && q.inflight() === 0, `队列未抽干 size=${q.size()} inflight=${q.inflight()}`);
  assert(done.length === 5, `完成=${done.length}`);
  assert(errors.length === 2, `onError 次数=${errors.length}`);
  assert(done.some((d) => d === "failme#2") && done.some((d) => d === "failme2#2"), `重派后成功=${done}`);
  const ev = ex.events().map((e) => e.type);
  assert(ev.includes("queue.claim") && ev.includes("queue.ack") && ev.includes("queue.requeue"), "事件流含 claim/ack/requeue");
});

// ⑤ 释放保证：任务失败 → 许可与名额全释放 + 错误上抛
await t("E. 释放保证（失败任务释放许可，池计数正确）", async () => {
  const ex = createExecutor();
  ex.bindCapacity("model", { permits: 1 });
  const pool = ex.declarePool("p", { concurrency: 2, needs: ["model"] });
  let threw = false;
  try { await pool.submit(async () => { await sleep(20); throw new Error("boom"); }, { tag: "bad" }); }
  catch { threw = true; }
  assert(threw, "错误应上抛");
  const s = ex.stats();
  assert(s.capacities[0].held.length === 0, "许可未释放");
  assert(s.pools[0].running.length === 0, "名额未释放");
  assert(s.pools[0].failed === 1, `failed=${s.pools[0].failed}`);
});

// ⑥ 超时：abort + 拒绝 + 释放
await t("F. 超时（TaskTimeoutError，许可释放）", async () => {
  const ex = createExecutor();
  ex.bindCapacity("model", { permits: 1 });
  const pool = ex.declarePool("p", { concurrency: 1, needs: ["model"] });
  let typed = false;
  try { await pool.submit(async () => { await sleep(500); }, { timeoutMs: 100 }); }
  catch (e) { typed = e instanceof TaskTimeoutError; }
  assert(typed, "应为 TaskTimeoutError");
  assert(ex.stats().capacities[0].held.length === 0, "超时后许可未释放");
});

// ⑦ 文件队列：leads→todo→done 流转 + 重派 + 崩溃恢复
await t("G. FileQueue（流转/重派/recover）", async () => {
  const root = mkdtempSync(join(tmpdir(), "exq-"));
  const dirs = { pending: join(root, "leads"), inflight: join(root, "todo"), archive: join(root, "done") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  for (const f of ["HYP-1.md", "HYP-2.md", "HYP-bad.md"]) writeFileSync(join(dirs.pending, f), f);

  const ex = createExecutor();
  const fq = new FileQueue({ ...dirs, filter: (n) => n.startsWith("HYP-") });
  ex.declareQueue("HYP", { backend: fq });
  ex.declarePool("verify", { concurrency: 2 });

  const seen = [];
  await ex.serve({
    queue: "HYP", pool: "verify",
    consumer: async (item) => {
      await sleep(15);
      if (item.id === "HYP-bad.md" && item.attempts === 1) throw new Error("首试挂");
      seen.push(`${item.id}#${item.attempts}`);
    },
  });
  assert(readdirSync(dirs.archive).length === 3, `归档=${readdirSync(dirs.archive)}`);
  assert(readdirSync(dirs.pending).length === 0 && readdirSync(dirs.inflight).length === 0, "源目录未清空");
  assert(seen.includes("HYP-bad.md#2"), `重派=${seen}`);

  // 崩溃恢复：手工把一件放进 inflight，recover 回 pending
  renameSync(join(dirs.archive, "HYP-1.md"), join(dirs.inflight, "HYP-1.md"));
  fq.recover();
  assert(readdirSync(dirs.pending).includes("HYP-1.md"), "recover 未退回");
});

// ⑧ locked 池：并发锁死拒绝调整
await t("H. locked 池拒绝调整并发", async () => {
  const ex = createExecutor();
  const hunt = ex.declarePool("hunt", { concurrency: 1, locked: true, priority: 30 });
  let threw = false;
  try { hunt.setConcurrency(3); } catch { threw = true; }
  assert(threw, "locked 池应拒绝调整");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
