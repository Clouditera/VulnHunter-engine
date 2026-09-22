/**
 * Agent-scoped model control regression.
 * Build .dist first, then: node tests/agent-model-control.spec.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AgentModelRegistry, AgentModelRuntime } from "../.dist/src/agent-model.js";
import { startSession } from "../.dist/src/session.js";
import { ControlError, WorkflowRunnerEngine, createControlHttpService } from "../.dist/src/control.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const temp = () => mkdtempSync(join(tmpdir(), "vh-agent-model-"));
const engineDir = fileURLToPath(new URL("../../../", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = (providerId, modelId, apiKey, version, thinking = "high") => ({
  version,
  source: "inline",
  selection: { providerId, modelId, thinking },
  providers: [{
    id: providerId,
    name: providerId,
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    headers: { Authorization: "Bearer header-secret" },
    models: [{
      id: modelId,
      name: modelId,
      reasoning: true,
      input: ["text"],
      contextWindow: 4096,
      maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  }],
  credentials: [{ providerId, type: "api_key", apiKey }],
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (error) { console.log("FAIL", name, "-", error?.stack ?? error); fail++; }
}

await t("agent runtime：同一 runtime 热切、未预置模型可用、失败不污染旧配置", async () => {
  const engineDir = temp();
  try {
    const first = model("provider-a", "model-a", "secret-a", 1);
    const slot = await AgentModelRuntime.create(first, { engineDir, agentKey: "hunt" });
    const stableRuntime = slot.runtime;
    const applied = [];
    const unregister = slot.register({ id: "session-hunt", setResolvedModel: async (m, thinking) => {
      applied.push({ model: `${m.provider}/${m.id}`, thinking });
    } });

    const second = model("provider-b", "model-b", "secret-b", 2, "medium");
    await slot.replace(second);
    assert.equal(slot.runtime, stableRuntime, "session 捕获的 runtime identity 必须稳定");
    assert.equal(slot.current().model.provider, "provider-b");
    assert.equal(slot.current().model.id, "model-b");
    assert.deepEqual(applied, [{ model: "provider-b/model-b", thinking: "medium" }]);
    assert.equal((await slot.runtime.getAuth(slot.current().model)).auth.apiKey, "secret-b");

    await assert.rejects(() => slot.replace({ ...second, version: 3, selection: { ...second.selection, modelId: "missing" } }), /模型不存在/);
    assert.equal(slot.current().model.id, "model-b", "候选配置失败不能污染 live runtime");
    assert.equal(slot.snapshot().version, 2);
    unregister();
  } finally { rmSync(engineDir, { recursive: true, force: true }); }
});

await t("session 接线：同一 agent runtime 注入会话并能热切当前模型", async () => {
  const target = temp();
  const workdir = join(target, ".vulnforge");
  mkdirSync(workdir, { recursive: true });
  const registry = await AgentModelRegistry.create({ init: model("provider-a", "model-a", "secret-a", 1) }, { engineDir, agentKey: "" });
  let handle;
  try {
    handle = await startSession(
      { cwd: target, engineDir, workdir, params: {}, modelRegistry: registry },
      { agent: "build", id: "runtime-session", modelAgentKey: "init", sessionManager: SessionManager.inMemory(target) },
    );
    assert.equal(handle.currentModel(), "provider-a/model-a");
    await registry.replaceAgentModel("init", model("provider-b", "model-b", "secret-b", 2, "medium"));
    assert.equal(handle.currentModel(), "provider-b/model-b");
  } finally {
    handle?.close();
    rmSync(target, { recursive: true, force: true });
  }
});

await t("local source：模型与凭证来自 engineDir 文件，不依赖 inline 快照", async () => {
  const engineDir = temp();
  try {
    writeFileSync(join(engineDir, "models.json"), JSON.stringify({ providers: {
      local: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "local-secret",
        models: [{ id: "local-model", name: "Local", reasoning: false, input: ["text"], contextWindow: 100, maxTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    }}));
    writeFileSync(join(engineDir, "auth.json"), "{}");
    const slot = await AgentModelRuntime.create({
      version: 1,
      source: "local",
      selection: { providerId: "local", modelId: "local-model" },
    }, { engineDir, agentKey: "init" });
    assert.equal(slot.current().model.id, "local-model");
    assert.equal((await slot.runtime.getAuth(slot.current().model)).auth.apiKey, "local-secret");
  } finally { rmSync(engineDir, { recursive: true, force: true }); }
});

await t("engine：agent 隔离、版本冲突、切到启动时未提供的 provider/model", async () => {
  const target = temp();
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const engine = new WorkflowRunnerEngine({
    engineDir: target,
    cwd: target,
    loadWorkflow: async () => ({
      name: "stub",
      run: async () => { await done; },
    }),
  });
  try {
    const started = await engine.start({
      workflow: "stub",
      target,
      params: { rounds: "1" },
      agents: {
        init: model("provider-init", "init-a", "init-secret", 1),
        hunt: model("provider-hunt", "hunt-a", "hunt-secret", 1),
      },
    });
    await sleep(0);
    assert.equal(engine.get(started.runId).status, "running");
    assert.equal(engine.get(started.runId).agents.init.credentials[0].apiKey, "<redacted>");

    const switched = await engine.replaceAgentModel(started.runId, "init", model("provider-new", "new-at-runtime", "new-secret", 2), 1);
    assert.equal(switched.agents.init.selection.modelId, "new-at-runtime");
    assert.equal(switched.agents.hunt.selection.modelId, "hunt-a", "更新 init 不得影响 hunt");

    await assert.rejects(
      () => engine.replaceAgentModel(started.runId, "init", model("provider-new", "new-at-runtime", "new-secret", 2), 1),
      (e) => e instanceof ControlError && e.status === 409 && e.code === "version_conflict",
    );
    const invalid = model("provider-new", "new-at-runtime", "new-secret", 3);
    invalid.selection.modelId = "missing";
    await assert.rejects(
      () => engine.replaceAgentModel(started.runId, "init", invalid, 2),
      (e) => e instanceof ControlError && e.status === 422,
    );
    assert.equal(engine.get(started.runId).agents.init.selection.modelId, "new-at-runtime");
    release();
    const finished = await engine.wait(started.runId);
    assert.equal(finished.status, "done");
    await assert.rejects(() => engine.replaceAgentModel(started.runId, "init", model("provider-z", "z", "z", 4)), /不能切模型/);
  } finally {
    release?.();
    await engine.close();
    rmSync(target, { recursive: true, force: true });
  }
});

await t("HTTP adapter：POST 启动、GET 脱敏、PATCH 全量替换与 token 校验", async () => {
  const target = temp();
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const engine = new WorkflowRunnerEngine({
    engineDir: target,
    cwd: target,
    loadWorkflow: async () => ({ name: "stub", run: async () => { await done; } }),
  });
  const service = createControlHttpService({ engine, token: "control-secret" });
  try {
    const address = await service.listen(0, "127.0.0.1");
    const endpoint = `${address.url}/v1/runs`;
    const noAuth = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);

    const start = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
      body: JSON.stringify({ workflow: "stub", target, agents: { verify: model("provider-a", "model-a", "must-not-return", 1) } }),
    });
    assert.equal(start.status, 202);
    const started = await start.json();

    const get = await fetch(`${endpoint}/${started.runId}`, { headers: { authorization: "Bearer control-secret" } });
    assert.equal(get.status, 200);
    const view = await get.json();
    assert.equal(view.agents.verify.credentials[0].apiKey, "<redacted>");
    assert.equal(view.agents.verify.providers[0].headers, undefined);
    assert.equal(JSON.stringify(view).includes("must-not-return"), false);
    assert.equal(JSON.stringify(view).includes("header-secret"), false);

    const patch = await fetch(`${endpoint}/${started.runId}/agents/verify/model-config`, {
      method: "PATCH",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 1, ...model("provider-b", "model-b", "secret-b", 2, "low") }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).agents.verify.selection.modelId, "model-b");

    const stale = await fetch(`${endpoint}/${started.runId}/agents/verify/model-config`, {
      method: "PUT",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 1, ...model("provider-c", "model-c", "secret-c", 3) }),
    });
    assert.equal(stale.status, 409);
    release();
    await engine.wait(started.runId);
  } finally {
    release?.();
    await service.close();
    await engine.close();
    rmSync(target, { recursive: true, force: true });
  }
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
