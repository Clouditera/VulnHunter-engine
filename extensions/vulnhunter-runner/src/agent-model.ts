import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** Models exposed by a provider in the engine-level, JSON-safe protocol. */
export interface AgentModelDefinition {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  promptCache?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

/** Provider definition accepted by the engine control plane. */
export interface AgentProviderDefinition {
  id: string;
  name?: string;
  api: string;
  baseUrl: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: AgentModelDefinition[];
}

export interface AgentCredentialDefinition {
  providerId: string;
  type: "api_key";
  apiKey: string;
}

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentModelSelection {
  providerId: string;
  modelId: string;
  thinking?: AgentThinkingLevel;
}

/**
 * Full per-agent model snapshot. `local` deliberately carries only the
 * selection: the local source owns provider catalog and credentials.
 * `inline` is self-contained and is the SaaS/control-plane form.
 */
export interface AgentModelSnapshot {
  version: number;
  source: "local" | "inline";
  selection: AgentModelSelection;
  providers?: AgentProviderDefinition[];
  credentials?: AgentCredentialDefinition[];
}

export interface AgentModelHost {
  id: string;
  setResolvedModel(model: unknown, thinking?: string): Promise<void>;
}

export interface AgentModelRuntimeOptions {
  engineDir: string;
  agentKey: string;
}

export class ModelConfigVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(`模型配置 version 必须大于当前版本 ${currentVersion}`);
    this.name = "ModelConfigVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export interface ResolvedAgentModel {
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  selection: AgentModelSelection;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function cloneSnapshot(snapshot: AgentModelSnapshot): AgentModelSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as AgentModelSnapshot;
}

function assertSnapshotShape(snapshot: AgentModelSnapshot): void {
  if (!snapshot || typeof snapshot !== "object") throw new Error("模型配置必须是对象");
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) throw new Error("模型配置 version 必须是正整数");
  if (snapshot.source !== "local" && snapshot.source !== "inline") throw new Error("模型配置 source 只能是 local 或 inline");
  const s = snapshot.selection;
  if (!s || typeof s.providerId !== "string" || !s.providerId || typeof s.modelId !== "string" || !s.modelId) {
    throw new Error("模型配置缺少 selection.providerId/modelId");
  }
  if (s.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(s.thinking)) {
    throw new Error(`不支持的 thinking level：${s.thinking}`);
  }
  if (snapshot.source === "inline") {
    if (!Array.isArray(snapshot.providers) || snapshot.providers.length === 0) throw new Error("inline 模型配置必须提供 providers");
    if (!Array.isArray(snapshot.credentials)) throw new Error("inline 模型配置必须提供 credentials（可为空数组）");
    const providerIds = new Set<string>();
    for (const p of snapshot.providers) {
      if (!p || typeof p.id !== "string" || !p.id || providerIds.has(p.id)) throw new Error("providers 含空 id 或重复 provider id");
      providerIds.add(p.id);
      if (!Array.isArray(p.models) || p.models.length === 0) throw new Error(`provider ${p.id} 缺少 models`);
      const modelIds = new Set<string>();
      for (const model of p.models) {
        if (!model || typeof model.id !== "string" || !model.id || modelIds.has(model.id)) {
          throw new Error(`provider ${p.id} 含空 id 或重复 model id`);
        }
        modelIds.add(model.id);
      }
    }
    const credentialIds = new Set<string>();
    for (const c of snapshot.credentials) {
      if (!c || c.type !== "api_key" || typeof c.providerId !== "string" || !c.providerId || !c.apiKey || credentialIds.has(c.providerId)) {
        throw new Error("credentials 含无效、重复或空 apiKey 项");
      }
      if (!providerIds.has(c.providerId)) throw new Error(`credential 指向未知 provider：${c.providerId}`);
      credentialIds.add(c.providerId);
    }
  }
}

function toPiProviderDefinition(p: AgentProviderDefinition): Record<string, unknown> {
  if (!p.id || !p.api || !p.baseUrl || !Array.isArray(p.models) || p.models.length === 0) {
    throw new Error(`provider ${p.id || "(empty)"} 缺少 api/baseUrl/models`);
  }
  return {
    name: p.name,
    api: p.api,
    baseUrl: p.baseUrl,
    headers: p.headers,
    authHeader: p.authHeader,
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: m.api,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      thinkingLevelMap: m.thinkingLevelMap,
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 16384,
      cost: { ...ZERO_COST, ...(m.cost ?? {}) },
      promptCache: m.promptCache,
      samplingParams: m.samplingParams,
      compat: m.compat,
    })),
  };
}

/** One runtime scope. The object identity is intentionally stable for sessions. */
export class AgentModelRuntime {
  readonly agentKey: string;
  readonly runtime: ModelRuntime;
  private snapshotValue: AgentModelSnapshot;
  private registeredProviders = new Set<string>();
  private runtimeCredentials = new Set<string>();
  private hosts = new Map<AgentModelHost, true>();
  private updateTail: Promise<unknown> = Promise.resolve();

  private constructor(agentKey: string, runtime: ModelRuntime, snapshot: AgentModelSnapshot) {
    this.agentKey = agentKey;
    this.runtime = runtime;
    this.snapshotValue = cloneSnapshot(snapshot);
  }

  static async create(snapshot: AgentModelSnapshot, options: AgentModelRuntimeOptions): Promise<AgentModelRuntime> {
    assertSnapshotShape(snapshot);
    const credentials = snapshot.source === "inline" ? new InMemoryCredentialStore() : undefined;
    const runtime = await ModelRuntime.create({
      ...(snapshot.source === "local"
        ? { authPath: join(options.engineDir, "auth.json"), modelsPath: join(options.engineDir, "models.json") }
        : { modelsPath: null, refreshOnCreate: false }),
      ...(credentials ? { credentials } : {}),
    });
    const slot = new AgentModelRuntime(options.agentKey, runtime, snapshot);
    await slot.install(snapshot);
    return slot;
  }

  snapshot(): AgentModelSnapshot {
    return cloneSnapshot(this.snapshotValue);
  }

  current(): ResolvedAgentModel {
    const selection = this.snapshotValue.selection;
    const model = this.runtime.getModel(selection.providerId, selection.modelId);
    if (!model) throw new Error(`模型不存在：${selection.providerId}/${selection.modelId}`);
    return { runtime: this.runtime, model, selection: { ...selection } };
  }

  register(host: AgentModelHost): () => void {
    this.hosts.set(host, true);
    return () => this.hosts.delete(host);
  }

  /** Full replacement. Updates for one agent are serialized. */
  replace(snapshot: AgentModelSnapshot): Promise<ResolvedAgentModel> {
    const previous = this.updateTail;
    const next = previous.then(async () => this.replaceNow(snapshot));
    this.updateTail = next.catch(() => undefined);
    return next;
  }

  private async replaceNow(snapshot: AgentModelSnapshot): Promise<ResolvedAgentModel> {
    assertSnapshotShape(snapshot);
    if (snapshot.version <= this.snapshotValue.version) throw new ModelConfigVersionConflictError(this.snapshotValue.version);
    if (snapshot.source !== this.snapshotValue.source) {
      throw new Error(`agent ${this.agentKey} 不允许在运行中切换 source（${this.snapshotValue.source} → ${snapshot.source}）`);
    }

    // Validate the complete candidate before mutating the live runtime. This is
    // the failure boundary for unknown providers/models and missing credentials.
    await this.buildCandidate(snapshot);
    const old = this.snapshotValue;
    const oldResolved = this.current();
    try {
      await this.install(snapshot);
      const model = this.runtime.getModel(snapshot.selection.providerId, snapshot.selection.modelId);
      if (!model) throw new Error(`模型不存在：${snapshot.selection.providerId}/${snapshot.selection.modelId}`);
      const resolved: ResolvedAgentModel = {
        runtime: this.runtime,
        model,
        selection: { ...snapshot.selection },
      };
      for (const host of this.hosts.keys()) await host.setResolvedModel(resolved.model, resolved.selection.thinking);
      this.snapshotValue = cloneSnapshot(snapshot);
      return resolved;
    } catch (error) {
      // Best-effort rollback: the candidate was already validated, so this path
      // is normally limited to a live-session failure.
      try {
        await this.install(old);
        for (const host of this.hosts.keys()) await host.setResolvedModel(oldResolved.model, oldResolved.selection.thinking);
        this.snapshotValue = old;
      } catch (rollbackError) {
        throw new Error(`模型更新失败且回滚失败：${String(error)}；${String(rollbackError)}`);
      }
      throw error;
    }
  }

  private async buildCandidate(snapshot: AgentModelSnapshot): Promise<ModelRuntime> {
    if (snapshot.source === "local") {
      const model = this.runtime.getModel(snapshot.selection.providerId, snapshot.selection.modelId);
      if (!model) throw new Error(`模型不存在：${snapshot.selection.providerId}/${snapshot.selection.modelId}`);
      const auth = await this.runtime.getAuth(model);
      if (!auth) throw new Error(`provider 未配置凭证：${snapshot.selection.providerId}`);
      return this.runtime;
    }
    const credentials = new InMemoryCredentialStore();
    const candidate = await ModelRuntime.create({ modelsPath: null, credentials, refreshOnCreate: false });
    for (const p of snapshot.providers ?? []) candidate.registerProvider(p.id, toPiProviderDefinition(p) as never);
    for (const c of snapshot.credentials ?? []) {
      if (c.type !== "api_key" || !c.apiKey) throw new Error(`credential ${c.providerId} 无有效 apiKey`);
      await candidate.setRuntimeApiKey(c.providerId, c.apiKey);
    }
    const model = candidate.getModel(snapshot.selection.providerId, snapshot.selection.modelId);
    if (!model) throw new Error(`模型不存在：${snapshot.selection.providerId}/${snapshot.selection.modelId}`);
    if (!(await candidate.getAuth(model))) throw new Error(`provider 未配置凭证：${snapshot.selection.providerId}`);
    return candidate;
  }

  /** Apply snapshot contents to the stable runtime object. */
  private async install(snapshot: AgentModelSnapshot): Promise<void> {
    if (snapshot.source === "local") return;
    for (const providerId of this.registeredProviders) this.runtime.unregisterProvider(providerId);
    this.registeredProviders.clear();
    for (const providerId of this.runtimeCredentials) await this.runtime.removeRuntimeApiKey(providerId);
    this.runtimeCredentials.clear();
    for (const p of snapshot.providers ?? []) {
      this.runtime.registerProvider(p.id, toPiProviderDefinition(p) as never);
      this.registeredProviders.add(p.id);
    }
    for (const c of snapshot.credentials ?? []) {
      await this.runtime.setRuntimeApiKey(c.providerId, c.apiKey);
      this.runtimeCredentials.add(c.providerId);
    }
  }
}

export class AgentModelRegistry {
  private readonly slots = new Map<string, AgentModelRuntime>();

  static async create(snapshots: Record<string, AgentModelSnapshot>, options: AgentModelRuntimeOptions): Promise<AgentModelRegistry> {
    const registry = new AgentModelRegistry();
    for (const [agentKey, snapshot] of Object.entries(snapshots)) {
      registry.slots.set(agentKey, await AgentModelRuntime.create(snapshot, { ...options, agentKey }));
    }
    return registry;
  }

  has(agentKey: string): boolean { return this.slots.has(agentKey); }

  get(agentKey: string): AgentModelRuntime {
    const slot = this.slots.get(agentKey);
    if (!slot) throw new Error(`未配置 agent 模型：${agentKey}`);
    return slot;
  }

  current(agentKey: string): ResolvedAgentModel { return this.get(agentKey).current(); }

  register(agentKey: string, host: AgentModelHost): () => void { return this.get(agentKey).register(host); }

  replaceAgentModel(agentKey: string, snapshot: AgentModelSnapshot): Promise<ResolvedAgentModel> {
    return this.get(agentKey).replace(snapshot);
  }

  snapshot(agentKey: string): AgentModelSnapshot { return this.get(agentKey).snapshot(); }

  snapshots(): Record<string, AgentModelSnapshot> {
    return Object.fromEntries([...this.slots].map(([key, slot]) => [key, slot.snapshot()]));
  }
}

export function redactAgentSnapshot(snapshot: AgentModelSnapshot): AgentModelSnapshot {
  const out = cloneSnapshot(snapshot);
  if (out.credentials) out.credentials = out.credentials.map((c) => ({ ...c, apiKey: "<redacted>" }));
  // Provider headers may contain Authorization/API keys even when credentials
  // are represented separately; never expose them through the status API.
  if (out.providers) out.providers = out.providers.map((p) => ({ ...p, headers: undefined }));
  return out;
}

export interface ModelControlRunRegistry {
  register(runId: string, registry: AgentModelRegistry): void;
  unregister(runId: string): void;
  get(runId: string): AgentModelRegistry | undefined;
}

export function createModelControlRunRegistry(): ModelControlRunRegistry {
  const runs = new Map<string, AgentModelRegistry>();
  return {
    register: (runId, registry) => { runs.set(runId, registry); },
    unregister: (runId) => { runs.delete(runId); },
    get: (runId) => runs.get(runId),
  };
}

export const modelControlRuns = createModelControlRunRegistry();
