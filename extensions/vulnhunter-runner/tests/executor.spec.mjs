/**
 * 执行器验收用例（fish 09-15 五条 + 附加）
 * 运行：node tests/executor.spec.mjs（先构建 .dist）
 */
import { createExecutor, TaskTimeoutError } from "../.dist/src/executor/index.js";

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
