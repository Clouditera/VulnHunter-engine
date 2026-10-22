/**
 * pi 0.87 session-manager contract regression.
 * Build .dist first, then: node tests/session-manager-087.spec.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchSummarize } from "../.dist/src/branch-summary.js";

const temp = () => mkdtempSync(join(tmpdir(), "vh-session-087-"));
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (error) { console.log("FAIL", name, "-", error?.stack ?? error); fail++; }
}

await t("分支摘要通过 refreshContext 刷新，而不是写 agent.state.messages", async () => {
  const engineDir = temp();
  const oldFetch = globalThis.fetch;
  try {
    const entries = [
      { id: "root", parentId: null, type: "message", message: { role: "user", content: "root" } },
      { id: "anchor", parentId: "root", type: "label", label: "hunt-start[init]" },
      { id: "leaf", parentId: "anchor", type: "message", message: { role: "assistant", content: "work" } },
    ];
    const labels = new Map([["anchor", "hunt-start[init]"]]);
    const stateMessages = [{ role: "user", content: "canonical" }];
    let refreshes = 0;
    let appendedLabel;
    const sm = {
      getEntries: () => entries,
      getLeafId: () => "leaf",
      getLabel: (id) => labels.get(id),
      branchWithSummary: (targetId, summary) => {
        assert.equal(targetId, "root");
        assert.equal(summary, "summary text");
        return "summary-entry";
      },
      appendLabelChange: (id, label) => { appendedLabel = [id, label]; },
    };
    const sess = {
      sessionManager: sm,
      model: { provider: "summary", id: "summary-model" },
      thinkingLevel: "low",
      modelRuntime: { completeSimple: async (model, context, options) => {
        assert.strictEqual(model, sess.model);
        assert.equal(options.reasoning, "low");
        assert.equal(options.maxTokens, 32768);
        assert.match(context.systemPrompt, /任务定义/);
        return { content: [{ type: "text", text: "summary text" }], stopReason: "stop", usage: { totalTokens: 1 } };
      } },
      agent: { state: { messages: stateMessages } },
      refreshContext: () => { refreshes++; },
    };
    const result = await branchSummarize(sess, "hunt-start", { summaryLabel: "Σhunt1" });
    assert.equal(result.summaryId, "summary-entry");
    assert.deepEqual(appendedLabel, ["summary-entry", "Σhunt1"]);
    assert.equal(refreshes, 1);
    assert.strictEqual(sess.agent.state.messages, stateMessages);
  } finally {
    globalThis.fetch = oldFetch;
    rmSync(engineDir, { recursive: true, force: true });
  }
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
