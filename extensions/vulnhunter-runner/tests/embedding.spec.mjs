/**
 * Embedding API: a run can continue an earlier run (same id, from a stage); dynamic mode is a parameter.
 * Build .dist first, then: node tests/embedding.spec.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunnerEngine } from "../.dist/src/control.js";
import { isDynamic } from "../.dist/src/params.js";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (error) { console.log("FAIL", name, "-", error?.stack ?? error); fail++; }
}

await t("start：resume 沿用原 runId，并把 from 交给 workflow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vh-embed-"));
  try {
    const calls = [];
    const engine = new WorkflowRunnerEngine({
      engineDir: dir,
      loadWorkflow: async () => ({ name: "w", run: async (_ctx, opts) => { calls.push(opts); } }),
    });
    const first = await engine.start({ workflow: "w", target: dir, workdir: join(dir, "out") });
    await engine.wait(first.runId);
    const again = await engine.start({ workflow: "w", target: dir, workdir: join(dir, "out"), resume: { runId: first.runId, from: "hunt" } });
    await engine.wait(again.runId);
    assert.equal(again.runId, first.runId);
    assert.deepEqual(calls[0], { runId: first.runId });
    assert.deepEqual(calls[1], { runId: first.runId, from: "hunt" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await t("isDynamic：mode=dynamic 或独立使用的 sandbox_cfg", () => {
  assert.equal(isDynamic({}), false);
  assert.equal(isDynamic({ mode: "static" }), false);
  assert.equal(isDynamic({ mode: "dynamic" }), true);
  assert.equal(isDynamic({ sandbox_cfg: "ssh sandbox-x" }), true);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
