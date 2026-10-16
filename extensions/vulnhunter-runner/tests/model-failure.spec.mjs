/**
 * A failing model call (rate limit, server error) is not a finished task: Pi reports it on the assistant message
 * without throwing, so the session has to look. Build .dist first, then: node --test tests/model-failure.spec.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentModelRegistry } from "../.dist/src/agent-model.js";
import { startSession } from "../.dist/src/session.js";

const engineDir = fileURLToPath(new URL("../../../", import.meta.url));

/** Answers 429 for the first `failures` requests, then "done". */
function flakyModel(failures) {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.requests += 1;
      if (state.requests <= failures) {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "1302", message: "rate limit" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...d })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const snapshot = (baseUrl) => ({
  version: 1, source: "inline",
  selection: { providerId: "flaky", modelId: "m", thinking: "off" },
  providers: [{
    id: "flaky", providerType: "flaky-type", name: "flaky", api: "openai-completions", baseUrl, headers: {},
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }],
  credentials: [{ providerId: "flaky", type: "api_key", apiKey: "test-key" }],
});

async function prompt(failures) {
  const root = mkdtempSync(join(tmpdir(), "vh-model-failure-"));
  const target = join(root, "project"), workdir = join(root, "workspace");
  mkdirSync(target); mkdirSync(workdir);
  const model = await flakyModel(failures);
  const registry = await AgentModelRegistry.create({ init: snapshot(model.url) }, { engineDir, agentKey: "" });
  let handle;
  try {
    handle = await startSession(
      { cwd: target, engineDir, workdir, params: {}, modelRegistry: registry, retryDelaysMs: [10, 10] },
      { agent: "build", id: "flaky-session", modelAgentKey: "init", sessionManager: SessionManager.inMemory(target) },
    );
    return { result: await handle.prompt("go"), requests: model.state.requests };
  } finally {
    handle?.close();
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a model that keeps failing ends the task as aborted, not as done", async () => {
  const { result } = await prompt(1000);
  assert.equal(result.aborted, true);
});

test("a model that recovers after a few failures completes the task", async () => {
  const { result } = await prompt(4);
  assert.equal(result.aborted, false);
});
