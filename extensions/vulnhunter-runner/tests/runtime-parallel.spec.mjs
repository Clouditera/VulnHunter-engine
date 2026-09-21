/**
 * runtime 并行组语义回归：相邻同组并发、组间串行、失败聚合、only/selected、断点续跑跳过。
 * 运行：node tests/runtime-parallel.spec.mjs（先构建 .dist；stub 阶段不碰模型/会话）
 */
import { runStages } from "../.dist/src/runtime.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m ?? "assert"); };
async function t(n, f) { try { await f(); console.log("PASS", n); pass++; } catch (e) { console.log("FAIL", n, "-", e?.message ?? e); fail++; } }

const mkctx = (workdir) => ({ cwd: workdir, engineDir: workdir, workdir, params: {}, node: async () => ({ agent: "stub", output: "", aborted: false }), report: () => {} });
const mkworkdir = () => mkdtempSync(join(tmpdir(), "rt-par-"));

await t("runtime：同组并发、组间串行、收齐再走", async () => {
  const W = mkworkdir();
  const events = [];
  const wf = { name: "stub-par", description: "", stages: () => [
    { name: "one", run: async () => { events.push("one:start"); await sleep(50); events.push("one:end"); } },
    { name: "p1", parallelGroup: "g", run: async () => { events.push("p1:start"); await sleep(150); events.push("p1:end"); } },
    { name: "p2", parallelGroup: "g", run: async () => { events.push("p2:start"); await sleep(80); events.push("p2:end"); } },
    { name: "tail", run: async () => { events.push("tail:start"); } },
  ] };
  await runStages(wf, mkctx(W), { runId: "t1" });
  const idx = (x) => events.indexOf(x);
  assert(idx("one:end") < idx("p1:start"), "one 完成先于组（组间串行）");
  assert(idx("p1:start") < idx("p2:start") && idx("p2:start") < idx("p1:end"), "同组成员执行重叠");
  assert(idx("p1:end") < idx("tail:start") && idx("p2:end") < idx("tail:start"), "tail 等全组完成");
  assert(idx("one:start") === 0, "顺序起跑");
  rmSync(W, { recursive: true, force: true });
});

await t("runtime：组内失败——全组落定后抛错、各成员状态如实记录", async () => {
  const W = mkworkdir();
  let p1Finished = false;
  const wf = { name: "stub-fail", description: "", stages: () => [
    { name: "p1", parallelGroup: "g", run: async () => { await sleep(120); p1Finished = true; } },
    { name: "p2", parallelGroup: "g", run: async () => { await sleep(30); throw new Error("boom"); } },
    { name: "tail", run: async () => { throw new Error("tail 不应执行"); } },
  ] };
  let threw = null;
  try { await runStages(wf, mkctx(W), { runId: "t2" }); } catch (e) { threw = e; }
  assert(threw, "组内有失败必须抛出");
  assert(p1Finished, "失败不掐断并发成员（等全组落定）");
  const st = JSON.parse(readFileSync(join(W, "system", "runs", "stub-fail-t2.json"), "utf-8"));
  assert(st.stages.p2 === "failed", `p2=failed，实际 ${st.stages.p2}`);
  assert(st.stages.p1 === "done", `p1=done，实际 ${st.stages.p1}`);
  assert(st.stageErrors && st.stageErrors.p2, "stageErrors 记录 p2");
  assert(!st.stages.tail || st.stages.tail === "pending" || st.stages.tail === undefined ? true : st.stages.tail === "pending", "tail 未执行");
  rmSync(W, { recursive: true, force: true });
});

await t("runtime：only 单步——只跑目标阶段、selected 如实", async () => {
  const W = mkworkdir();
  const events = [];
  let seenSelected = null;
  const wf = { name: "stub-only", description: "", stages: () => [
    { name: "a", run: async () => { events.push("a"); } },
    { name: "b", parallelGroup: "g", run: async (s) => { seenSelected = s.selected; events.push("b"); } },
    { name: "c", parallelGroup: "g", run: async () => { events.push("c"); } },
  ] };
  await runStages(wf, mkctx(W), { runId: "t3", only: "b" });
  assert(JSON.stringify(events.sort()) === JSON.stringify(["b"]), `only 只跑 b，实际 ${events.join(",")}`);
  assert(seenSelected && JSON.stringify(seenSelected) === JSON.stringify(["b"]), `selected=["b"]，实际 ${JSON.stringify(seenSelected)}`);
  const st = JSON.parse(readFileSync(join(W, "system", "runs", "stub-only-t3.json"), "utf-8"));
  assert(st.stages.a === "pending" && st.stages.c === "pending", "非目标阶段不动");
  rmSync(W, { recursive: true, force: true });
});

await t("runtime：断点续跑——done 跳过、不重复执行", async () => {
  const W = mkworkdir();
  let runs = 0;
  const wf = { name: "stub-resume", description: "", stages: () => [
    { name: "a", run: async () => { runs++; } },
    { name: "b", parallelGroup: "g", run: async () => { runs++; } },
    { name: "c", parallelGroup: "g", run: async () => { runs++; } },
  ] };
  await runStages(wf, mkctx(W), { runId: "t4" });
  assert(runs === 3, `首跑 3 个阶段，实际 ${runs}`);
  await runStages(wf, mkctx(W), { runId: "t4" });
  assert(runs === 3, `二次跑全部跳过，实际 ${runs}`);
  // from 语义：把 b/c 改成 failed 再续跑
  const p = join(W, "system", "runs", "stub-resume-t4.json");
  const st = JSON.parse(readFileSync(p, "utf-8"));
  st.stages.b = "failed"; st.stages.c = "failed";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(p, JSON.stringify(st));
  await runStages(wf, mkctx(W), { runId: "t4", from: "b" });
  assert(runs === 5, `续跑只补 b/c，实际 ${runs}`);
  rmSync(W, { recursive: true, force: true });
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
