import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Workflow, WorkflowContext } from "./runtime.ts";
import type { RunEnv } from "./exec-env.ts";
import {
  AgentModelRegistry,
  ModelConfigVersionConflictError,
  modelControlRuns,
  redactAgentSnapshot,
  type AgentModelSnapshot,
} from "./agent-model.ts";

/** Unified engine input. `agents` is optional for the legacy local-file mode. */
export interface StartRunRequest {
  workflow: string;
  target: string;
  params?: Record<string, string>;
  agents?: Record<string, AgentModelSnapshot>;
  /** Where the engine keeps its workspace (knowledge/, findings/, system/); default `<target>/.vulnforge`. */
  workdir?: string;
  /** Execution environment for the agent's tools; default: this machine. */
  env?: RunEnv;
  /** Continue an earlier run of this workflow (its state is in `workdir/system/runs/`): same id, from this stage. */
  resume?: { runId: string; from: string };
}

export type RunnerRunStatus = "starting" | "running" | "done" | "error";

export interface RunnerRunView {
  runId: string;
  workflow: string;
  target: string;
  workdir: string;
  status: RunnerRunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
  agents?: Record<string, AgentModelSnapshot>;
  logs: string[];
}

export class ControlError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ControlError";
    this.status = status;
    this.code = code;
  }
}

interface RunRecord extends RunnerRunView {
  modelRegistry?: AgentModelRegistry;
  done: Promise<void>;
}

export interface WorkflowRunnerEngineOptions {
  engineDir: string;
  cwd?: string;
  loadWorkflow: (name: string) => Promise<Workflow | undefined>;
}

function asErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Do not allow an accidental credential echo to cross the control-plane boundary.
  return message.replace(/(apiKey|api_key|token|secret)\s*[=:]\s*[^,;\s}]+/gi, "$1=<redacted>").slice(0, 500);
}

function validateParams(params: unknown): Record<string, string> {
  if (params === undefined) return {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ControlError(422, "invalid_params", "params 必须是字符串键值对象");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!key || typeof value !== "string") throw new ControlError(422, "invalid_params", "params 的值必须是字符串");
    out[key] = value;
  }
  return out;
}

function validateStartRequest(request: StartRunRequest): void {
  if (!request || typeof request !== "object") throw new ControlError(400, "invalid_request", "请求体必须是对象");
  if (typeof request.workflow !== "string" || !request.workflow.trim()) {
    throw new ControlError(400, "invalid_request", "缺少 workflow");
  }
  if (typeof request.target !== "string" || !request.target.trim()) {
    throw new ControlError(400, "invalid_request", "缺少 target");
  }
  validateParams(request.params);
  if (request.workdir !== undefined && (typeof request.workdir !== "string" || !request.workdir.trim())) {
    throw new ControlError(422, "invalid_workdir", "workdir 必须是非空路径");
  }
  if (request.agents !== undefined && (!request.agents || typeof request.agents !== "object" || Array.isArray(request.agents))) {
    throw new ControlError(422, "invalid_model_config", "agents 必须是 agentKey 到完整模型快照的对象");
  }
}

function copyView(record: RunRecord): RunnerRunView {
  const view: RunnerRunView = {
    runId: record.runId,
    workflow: record.workflow,
    target: record.target,
    workdir: record.workdir,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    logs: [...record.logs].slice(-100),
  };
  if (record.modelRegistry) {
    view.agents = Object.fromEntries(
      Object.entries(record.modelRegistry.snapshots()).map(([key, snapshot]) => [key, redactAgentSnapshot(snapshot)]),
    );
  }
  return view;
}

function makeRunId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * The pure in-process engine API. HTTP is only an adapter over this object;
 * callers embedding the runner do not need to start a server.
 */
export class WorkflowRunnerEngine {
  private readonly options: WorkflowRunnerEngineOptions;
  private readonly runs = new Map<string, RunRecord>();

  constructor(options: WorkflowRunnerEngineOptions) {
    this.options = options;
  }

  async start(request: StartRunRequest): Promise<RunnerRunView> {
    validateStartRequest(request);
    const workflowName = request.workflow.trim();
    const target = resolve(this.options.cwd ?? process.cwd(), request.target);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new ControlError(422, "invalid_target", `target 不存在或不是目录：${target}`);
    }
    const workflow = await this.options.loadWorkflow(workflowName);
    if (!workflow) throw new ControlError(404, "workflow_not_found", `未知 workflow：${workflowName}`);

    let modelRegistry: AgentModelRegistry | undefined;
    if (request.agents && Object.keys(request.agents).length > 0) {
      try {
        modelRegistry = await AgentModelRegistry.create(request.agents, {
          engineDir: this.options.engineDir,
          agentKey: "",
        });
      } catch (error) {
        throw new ControlError(422, "invalid_model_config", asErrorMessage(error));
      }
    }

    const runId = request.resume?.runId ?? makeRunId();
    const workdir = request.workdir ? resolve(request.workdir) : join(target, ".vulnforge");
    const record: RunRecord = {
      runId,
      workflow: workflowName,
      target,
      workdir,
      status: "starting",
      startedAt: new Date().toISOString(),
      logs: [],
      ...(modelRegistry ? { modelRegistry } : {}),
      done: Promise.resolve(),
    };
    this.runs.set(runId, record);
    if (modelRegistry) modelControlRuns.register(runId, modelRegistry);

    const ctx: WorkflowContext = {
      cwd: target,
      engineDir: this.options.engineDir,
      workdir,
      params: validateParams(request.params),
      ...(modelRegistry ? { modelRegistry } : {}),
      ...(request.env ? { env: request.env } : {}),
      node: () => { throw new Error("旧接口 node() 已废弃"); },
      report: (message) => {
        // Workflow reports are operational text; model credentials never enter this path.
        record.logs.push(String(message).slice(0, 500));
        if (record.logs.length > 100) record.logs.splice(0, record.logs.length - 100);
      },
    };

    record.done = Promise.resolve()
      .then(async () => {
        record.status = "running";
        await workflow.run(ctx, request.resume ? { runId, from: request.resume.from } : { runId });
        record.status = "done";
      })
      .catch((error) => {
        record.status = "error";
        record.error = asErrorMessage(error);
        throw error;
      })
      .finally(() => {
        record.endedAt = new Date().toISOString();
        if (record.modelRegistry) modelControlRuns.unregister(runId);
      });
    // The runner is intentionally backgrounded; callers observe status via get/list.
    void record.done.catch(() => undefined);
    return copyView(record);
  }

  get(runId: string): RunnerRunView | undefined {
    const record = this.runs.get(runId);
    return record ? copyView(record) : undefined;
  }

  list(): RunnerRunView[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(copyView);
  }

  async wait(runId: string): Promise<RunnerRunView> {
    const record = this.runs.get(runId);
    if (!record) throw new ControlError(404, "run_not_found", `run 不存在：${runId}`);
    await record.done.catch(() => undefined);
    return copyView(record);
  }

  async replaceAgentModel(
    runId: string,
    agentKey: string,
    snapshot: AgentModelSnapshot,
    baseVersion?: number,
  ): Promise<RunnerRunView> {
    const record = this.runs.get(runId);
    if (!record) throw new ControlError(404, "run_not_found", `run 不存在：${runId}`);
    if (record.status !== "starting" && record.status !== "running") {
      throw new ControlError(409, "run_not_running", `run ${runId} 当前状态为 ${record.status}，不能切模型`);
    }
    if (!record.modelRegistry) {
      throw new ControlError(409, "model_registry_unavailable", "该 run 未以 agents 模式启动，不能通过 agent 接口切换模型");
    }
    if (!record.modelRegistry.has(agentKey)) {
      throw new ControlError(404, "agent_not_found", `run 未配置 agent：${agentKey}`);
    }
    const current = record.modelRegistry.snapshot(agentKey);
    if (baseVersion !== undefined && baseVersion !== current.version) {
      throw new ControlError(409, "version_conflict", `模型配置版本冲突：当前 ${current.version}，请求基于 ${baseVersion}`);
    }
    if (!Number.isInteger(snapshot?.version) || snapshot.version <= current.version) {
      throw new ControlError(409, "version_conflict", `模型配置 version 必须大于当前版本 ${current.version}`);
    }
    try {
      await record.modelRegistry.replaceAgentModel(agentKey, snapshot);
    } catch (error) {
      if (error instanceof ModelConfigVersionConflictError) {
        throw new ControlError(409, "version_conflict", error.message);
      }
      throw new ControlError(422, "invalid_model_config", asErrorMessage(error));
    }
    return copyView(record);
  }

  /** Test/host lifecycle hook; it does not kill an already running workflow. */
  async close(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.done.catch(() => undefined)));
  }
}

function jsonBody(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > maxBytes) throw new ControlError(413, "body_too_large", "请求体过大");
    chunks.push(b);
  }
  if (!chunks.length) throw new ControlError(400, "invalid_request", "请求体不能为空");
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ControlError(400, "invalid_json", "请求体不是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError(400, "invalid_request", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function safeEqualToken(actual: string | undefined, expected: string): boolean {
  // A constant-time comparison is unnecessary for the local-only default but
  // avoids making the configured bearer token an obvious timing oracle.
  if (!actual || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface ControlHttpOptions {
  engine: WorkflowRunnerEngine;
  token?: string;
}

export interface ControlHttpService {
  server: Server;
  listen(port?: number, host?: string): Promise<{ port: number; host: string; url: string }>;
  close(): Promise<void>;
}

/** HTTP adapter for the stable runner control contract. */
export function createControlHttpService(options: ControlHttpOptions): ControlHttpService {
  const server = createServer((req, res) => {
    handleControlRequest(req, res, options).catch((error) => {
      const e = error instanceof ControlError ? error : new ControlError(500, "internal_error", asErrorMessage(error));
      if (!res.headersSent) jsonBody(res, e.status, { error: { code: e.code, message: e.message } });
      else res.end();
    });
  });

  return {
    server,
    listen(port = 4200, host = "127.0.0.1") {
      return new Promise((resolveListen, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolveListen({ port: actualPort, host, url: `http://${host}:${actualPort}` });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return; }
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

async function handleControlRequest(req: IncomingMessage, res: ServerResponse, options: ControlHttpOptions): Promise<void> {
  if (options.token && !safeEqualToken(bearerToken(req), options.token)) {
    jsonBody(res, 401, { error: { code: "unauthorized", message: "需要 Bearer token" } });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== "v1") throw new ControlError(404, "not_found", "未知路径");

  if (req.method === "POST" && parts.length === 2 && parts[1] === "runs") {
    const body = await readJson(req);
    const view = await options.engine.start({
      workflow: String(body.workflow ?? ""),
      target: String(body.target ?? ""),
      params: body.params as Record<string, string> | undefined,
      agents: body.agents as Record<string, AgentModelSnapshot> | undefined,
    });
    jsonBody(res, 202, { runId: view.runId, status: view.status, workflow: view.workflow });
    return;
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "runs") {
    jsonBody(res, 200, { runs: options.engine.list() });
    return;
  }

  if (parts.length >= 3 && parts[1] === "runs") {
    const runId = parts[2];
    if (req.method === "GET" && parts.length === 3) {
      const view = options.engine.get(runId);
      if (!view) throw new ControlError(404, "run_not_found", `run 不存在：${runId}`);
      jsonBody(res, 200, view);
      return;
    }
    if ((req.method === "PUT" || req.method === "PATCH") && parts.length === 6 && parts[3] === "agents" && parts[5] === "model-config") {
      const body = await readJson(req);
      const baseVersion = body.baseVersion === undefined ? undefined : Number(body.baseVersion);
      if (baseVersion !== undefined && !Number.isInteger(baseVersion)) throw new ControlError(422, "invalid_request", "baseVersion 必须是整数");
      const nested = body.snapshot;
      const snapshot = (nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested
        : Object.fromEntries(Object.entries(body).filter(([key]) => key !== "baseVersion"))) as AgentModelSnapshot;
      const view = await options.engine.replaceAgentModel(runId, parts[4], snapshot, baseVersion);
      jsonBody(res, 200, view);
      return;
    }
  }

  throw new ControlError(404, "not_found", "未知路径");
}

let defaultService: ControlHttpService | undefined;

/** Start the optional SaaS control plane. It is off unless VULNHUNTER_CONTROL=1. */
export function ensureControlService(engine: WorkflowRunnerEngine): ControlHttpService | null {
  if (defaultService) return defaultService;
  if (!process.env.VULNHUNTER_CONTROL || process.env.VULNHUNTER_CONTROL === "0") return null;
  const host = process.env.VULNHUNTER_CONTROL_HOST || "127.0.0.1";
  const token = process.env.VULNHUNTER_CONTROL_TOKEN;
  if (!/^127\.0\.0\.1$|^localhost$|^::1$/.test(host) && !token) {
    throw new Error("VULNHUNTER_CONTROL_HOST 非本机地址时必须设置 VULNHUNTER_CONTROL_TOKEN");
  }
  const service = createControlHttpService({ engine, token });
  defaultService = service;
  const port = Number(process.env.VULNHUNTER_CONTROL_PORT || "4200");
  service.server.unref();
  void service.listen(port, host).then(({ url }) => console.error(`[vulnhunter-control] ${url}`)).catch((error) => {
    console.error(`[vulnhunter-control] 启动失败：${asErrorMessage(error)}`);
  });
  return service;
}
