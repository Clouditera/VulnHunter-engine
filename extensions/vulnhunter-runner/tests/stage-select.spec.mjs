/**
 * 阶段选择语义测试：only 单步 / from 续跑 / 普通全跑（fish 09-16 稳定性实验暴露 only 跳空，修复后补）
 * 运行：node tests/stage-select.spec.mjs（先构建 .dist）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStages } from "../.dist/src/runtime.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

const mkCtx = (dir) => ({
  cwd: dir, engineDir: "/home/lhy/dev/llm/VulnHunter-engine", workdir: dir,
  params: {}, node: () => {}, report: () => {},
});
const mkWf = (ran) => ({ name: "spec", stages: () => [
  { name: "a", run: async () => { ran.push("a"); } },
  { name: "b", run: async () => { ran.push("b"); } },
  { name: "c", run: async () => { ran.push("c"); } },
] });
const tmp = () => mkdtempSync(join(tmpdir(), "stage-select-"));

await t("only=b：单步只跑 b", async () => {
  const ran = [];
  await runStages(mkWf(ran), mkCtx(tmp()), { runId: "x1", only: "b" });
  assert(ran.join(",") === "b", `expect [b] got [${ran}]`);
});

await t("from=b：续跑 b 及其后（b,c）", async () => {
  const ran = [];
  await runStages(mkWf(ran), mkCtx(tmp()), { runId: "x2", from: "b" });
  assert(ran.join(",") === "b,c", `expect [b,c] got [${ran}]`);
});

await t("默认：全跑 a,b,c", async () => {
  const ran = [];
  await runStages(mkWf(ran), mkCtx(tmp()), { runId: "x3" });
  assert(ran.join(",") === "a,b,c", `expect [a,b,c] got [${ran}]`);
});

await t("only 可重复执行：阶段已 done 仍会再跑", async () => {
  const dir = tmp();
  const ran = [];
  await runStages(mkWf(ran), mkCtx(dir), { runId: "x4", only: "b" });
  ran.length = 0;
  await runStages(mkWf(ran), mkCtx(dir), { runId: "x4", only: "b" });
  assert(ran.join(",") === "b", `second run expect [b] got [${ran}]`);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
