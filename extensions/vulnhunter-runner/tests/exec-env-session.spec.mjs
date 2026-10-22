/**
 * A real Pi session with an execution environment: the model's bash / write / read calls reach the
 * environment (our tools replace Pi's built-ins of the same name), and the workspace stays local.
 * Build .dist first, then: node --test tests/exec-env-session.spec.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentModelRegistry } from "../.dist/src/agent-model.js";
import { startSession } from "../.dist/src/session.js";

const engineDir = fileURLToPath(new URL("../../../", import.meta.url));
const text = (content) => (typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join(""));

/** An OpenAI-compatible endpoint that plays a fixed list of tool calls, then says "done". */
function scriptedModel(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const messages = JSON.parse(body).messages ?? [];
      const results = messages.filter((m) => m.role === "tool").length;
      seen.push(messages.filter((m) => m.role === "tool").map((m) => text(m.content)));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (d) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "scripted", ...d })}\n\n`);
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const step = script[results];
      if (step) {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${results}`, type: "function", function: { name: step.name, arguments: "" } }] } }] });
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
      } else {
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const snapshot = (baseUrl) => ({
  version: 1, source: "inline",
  selection: { providerId: "scripted", modelId: "scripted", thinking: "off" },
  providers: [{
    id: "scripted", providerType: "scripted-type", name: "scripted", api: "openai-completions", baseUrl, headers: {},
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }],
  credentials: [{ providerId: "scripted", type: "api_key", apiKey: "test-key" }],
});

test("the model's file and shell calls act on the environment, the workspace stays local", async () => {
  const root = mkdtempSync(join(tmpdir(), "vh-env-session-"));
  const target = join(root, "project");
  const workdir = join(root, "workspace");
  mkdirSync(target); mkdirSync(workdir);
  const calls = [];
  const inner = new NodeExecutionEnv({ cwd: target });
  const env = new Proxy(inner, { get(t, prop) { const v = t[prop]; return typeof v === "function" ? (...a) => { calls.push(String(prop)); return v.apply(t, a); } : v; } });
  const model = await scriptedModel([
    { name: "write", args: { path: join(target, "poc.sh"), content: "echo from-run-sandbox\n" } },
    { name: "bash", args: { command: "sh poc.sh" } },
    { name: "write", args: { path: join(workdir, "knowledge/note.md"), content: "# note\n" } },
  ]);
  const registry = await AgentModelRegistry.create({ init: snapshot(model.url) }, { engineDir, agentKey: "" });
  let handle;
  try {
    handle = await startSession(
      { cwd: target, engineDir, workdir, params: {}, modelRegistry: registry, env: { env, localRoots: [workdir] } },
      { agent: "build", id: "env-session", modelAgentKey: "init", sessionManager: SessionManager.inMemory(target) },
    );
    await handle.prompt("go");
    assert.equal(readFileSync(join(target, "poc.sh"), "utf8"), "echo from-run-sandbox\n");
    assert.ok(model.seen.flat().some((t) => t.includes("from-run-sandbox")), "bash output reached the model");
    assert.ok(calls.includes("exec") && calls.includes("writeFile"), `environment calls: ${calls}`);
    assert.equal(readFileSync(join(workdir, "knowledge/note.md"), "utf8"), "# note\n");
    assert.equal(calls.filter((c) => c === "writeFile").length, 1, "only the project file was written through the environment");
  } finally {
    handle?.close();
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("without an environment the tools stay Pi's own", async () => {
  const root = mkdtempSync(join(tmpdir(), "vh-env-session-"));
  const target = join(root, "project");
  const workdir = join(root, "workspace");
  mkdirSync(target); mkdirSync(workdir);
  const model = await scriptedModel([{ name: "write", args: { path: join(target, "a.txt"), content: "a" } }]);
  const registry = await AgentModelRegistry.create({ init: snapshot(model.url) }, { engineDir, agentKey: "" });
  let handle;
  try {
    handle = await startSession(
      { cwd: target, engineDir, workdir, params: {}, modelRegistry: registry },
      { agent: "build", id: "plain-session", modelAgentKey: "init", sessionManager: SessionManager.inMemory(target) },
    );
    await handle.prompt("go");
    assert.equal(existsSync(join(target, "a.txt")), true);
  } finally {
    handle?.close();
    model.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
