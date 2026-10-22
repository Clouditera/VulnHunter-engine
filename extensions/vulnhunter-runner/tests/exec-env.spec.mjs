/**
 * Execution environment seam: the agent's read/write/edit/bash act on an ExecutionEnv, except under the local roots.
 * Build .dist first, then: node --test tests/exec-env.spec.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { envToolDefinitions } from "../.dist/src/exec-env.js";

/** A real environment (this machine stands in for the remote one) that records what the tools asked of it. */
function recording(cwd) {
  const inner = new NodeExecutionEnv({ cwd });
  const calls = [];
  const env = new Proxy(inner, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push({ method: String(prop), args });
        return value.apply(target, args);
      };
    },
  });
  return { env, calls };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vh-exec-env-"));
  const project = join(root, "project");
  const workspace = join(root, "workspace");
  const lookalike = join(root, "workspace-other");
  for (const dir of [project, workspace, lookalike]) mkdirSync(dir);
  const { env, calls } = recording(project);
  const tools = Object.fromEntries(envToolDefinitions(project, { env, localRoots: [workspace] }).map((tool) => [tool.name, tool]));
  const extensionContext = { sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined } };
  const run = (name, params, signal) => tools[name].execute("call", params, signal, undefined, extensionContext);
  const text = (result) => result.content.map((part) => part.text ?? "").join("");
  return { root, project, workspace, lookalike, calls, run, text, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("replaces exactly the default tools", () => {
  const { project, cleanup } = setup();
  try {
    const names = envToolDefinitions(project, { env: new NodeExecutionEnv({ cwd: project }), localRoots: [] }).map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["bash", "edit", "read", "write"]);
  } finally { cleanup(); }
});

test("files outside the local roots go to the environment", async () => {
  const { project, calls, run, text, cleanup } = setup();
  try {
    await run("write", { path: join(project, "src/app.txt"), content: "hello env\n" });
    assert.equal(readFileSync(join(project, "src/app.txt"), "utf8"), "hello env\n");
    assert.ok(calls.some((c) => c.method === "writeFile" && c.args[0] === join(project, "src/app.txt")));
    calls.length = 0;
    assert.match(text(await run("read", { path: join(project, "src/app.txt") })), /hello env/);
    assert.ok(calls.some((c) => c.method === "readBinaryFile"));
    await run("edit", { path: join(project, "src/app.txt"), edits: [{ oldText: "hello", newText: "bye" }] });
    assert.equal(readFileSync(join(project, "src/app.txt"), "utf8"), "bye env\n");
  } finally { cleanup(); }
});

test("the workspace directory is served locally and never touches the environment", async () => {
  const { workspace, calls, run, text, cleanup } = setup();
  try {
    const file = join(workspace, "knowledge/wiki/index.md");
    await run("write", { path: file, content: "# wiki\n" });
    assert.equal(readFileSync(file, "utf8"), "# wiki\n");
    assert.match(text(await run("read", { path: file })), /# wiki/);
    await run("edit", { path: file, edits: [{ oldText: "wiki", newText: "notes" }] });
    assert.equal(readFileSync(file, "utf8"), "# notes\n");
    assert.deepEqual(calls, []);
  } finally { cleanup(); }
});

test("a directory that only shares the prefix of a local root is not local", async () => {
  const { lookalike, calls, run, cleanup } = setup();
  try {
    await run("write", { path: join(lookalike, "x.txt"), content: "x" });
    assert.ok(calls.some((c) => c.method === "writeFile"));
  } finally { cleanup(); }
});

test("bash runs in the environment, in the project directory, without the engine's process environment", async () => {
  const { project, calls, run, text, cleanup } = setup();
  process.env.VH_ENGINE_SECRET_FOR_TEST = "must-not-travel";
  try {
    const out = text(await run("bash", { command: "pwd" }));
    assert.equal(out.trim(), project);
    const exec = calls.find((c) => c.method === "exec");
    assert.equal(exec.args[1].cwd, project);
    assert.equal(exec.args[1].env, undefined);
  } finally { delete process.env.VH_ENGINE_SECRET_FOR_TEST; cleanup(); }
});

test("bash keeps Pi's handling of exit codes, timeouts and aborts", async () => {
  const { run, text, cleanup } = setup();
  try {
    const failed = await run("bash", { command: "echo partial; exit 3" });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /partial[\s\S]*exited with code 3/);
    await assert.rejects(run("bash", { command: "sleep 5", timeout: 1 }), /timed out after 1 seconds/);
    const controller = new AbortController();
    const pending = run("bash", { command: "sleep 5" }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, /aborted/);
  } finally { cleanup(); }
});

test("a missing file reads as the usual error", async () => {
  const { project, run, cleanup } = setup();
  try {
    await assert.rejects(run("read", { path: join(project, "nope.txt") }), /ENOENT|not found|no such file/i);
    assert.equal(existsSync(join(project, "nope.txt")), false);
  } finally { cleanup(); }
});
