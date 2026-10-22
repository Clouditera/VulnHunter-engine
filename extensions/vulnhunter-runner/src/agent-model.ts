import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { createModelRuntime, registerModelProvider, type ModelDefinition, type ProviderDefinition } from "./model-provider.ts";

export type AgentModelDefinition = ModelDefinition;
/** Platform record identity is distinct from the native Pi provider ID. */
export interface AgentProviderDefinition extends Omit<ProviderDefinition, "id"> {
  id: string;
  providerType: string;
}

export interface AgentCredentialDefinition {
  providerId: string;
  type: "api_key";
  apiKey: string;
}

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = typeof AGENT_THINKING_LEVELS[number];

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

/** SDK identity only; never compare a platform record UUID to Model.provider. */
export interface SdkModelSelection {
  provider: string;
  modelId: string;
  thinking?: AgentThinkingLevel;
}

export function assertModelSelection(
  session: { model?: { provider: string; id: string }; thinkingLevel: string },
  selection: SdkModelSelection,
): void {
  if (session.model?.provider !== selection.provider || session.model.id !== selection.modelId
    || (selection.thinking !== undefined && session.thinkingLevel !== selection.thinking)) {
    throw new Error("SDK 未采用所选模型和思考档");
  }
}

export interface AgentModelHost {
  id: string;
  setResolvedModel(model: ResolvedAgentModel["model"], thinking?: AgentThinkingLevel): Promise<void>;
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

function validateThinking(model: ResolvedAgentModel["model"], thinking: AgentThinkingLevel | undefined): void {
  if (thinking !== undefined && !getSupportedThinkingLevels(model).includes(thinking)) {
    throw new Error(`模型 ${model.provider}/${model.id} 不支持思考档 ${thinking}`);
  }
}

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
  if (s.thinking !== undefined && !AGENT_THINKING_LEVELS.includes(s.thinking)) {
    throw new Error(`不支持的 thinking level：${s.thinking}`);
  }
  if (snapshot.source === "inline") {
    if (!Array.isArray(snapshot.providers) || snapshot.providers.length === 0) throw new Error("inline 模型配置必须提供 providers");
    if (!Array.isArray(snapshot.credentials)) throw new Error("inline 模型配置必须提供 credentials（可为空数组）");
    const providerIds = new Set<string>();
    for (const p of snapshot.providers) {
      if (!p || typeof p.id !== "string" || !p.id || providerIds.has(p.id)) throw new Error("providers 含空 id 或重复 provider id");
      providerIds.add(p.id);
      if (typeof p.providerType !== "string" || !p.providerType) throw new Error(`provider ${p.id} 缺少 providerType`);
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

function selectedProvider(snapshot: AgentModelSnapshot): AgentProviderDefinition {
  const provider = snapshot.providers?.find((entry) => entry.id === snapshot.selection.providerId);
  if (!provider) throw new Error(`provider 记录不存在：${snapshot.selection.providerId}`);
  return provider;
}

function resolveSnapshot(runtime: ModelRuntime, snapshot: AgentModelSnapshot): ResolvedAgentModel {
  const selection = snapshot.selection;
  const provider = snapshot.source === "inline" ? selectedProvider(snapshot).providerType : selection.providerId;
  const model = runtime.getModel(provider, selection.modelId);
  if (!model) throw new Error(`模型不存在：${selection.providerId}/${selection.modelId}`);
  validateThinking(model, selection.thinking);
  return { runtime, model, selection: { ...selection } };
}

/** Materialize only the selected record. Other same-type records stay in the platform snapshot;
 * each agent has its own native registry/store, so they never overwrite another agent's key. */
async function configureInline(runtime: ModelRuntime, snapshot: AgentModelSnapshot): Promise<void> {
  const { id, providerType, ...definition } = selectedProvider(snapshot);
  const credential = snapshot.credentials?.find((entry) => entry.providerId === id);
  if (!credential) throw new Error(`provider 未配置凭证：${id}`);
  registerModelProvider(runtime, { ...definition, id: providerType });
  await runtime.setRuntimeApiKey(providerType, credential.apiKey);
}

/** One runtime scope. The object identity is intentionally stable for sessions. */
export class AgentModelRuntime {
  readonly agentKey: string;
  readonly runtime: ModelRuntime;
  private snapshotValue: AgentModelSnapshot;
  private inlineProviderId?: string;
  private hosts = new Map<AgentModelHost, true>();
  private updateTail: Promise<unknown> = Promise.resolve();

  private constructor(agentKey: string, runtime: ModelRuntime, snapshot: AgentModelSnapshot) {
    this.agentKey = agentKey;
    this.runtime = runtime;
    this.snapshotValue = cloneSnapshot(snapshot);
  }

  static async create(snapshot: AgentModelSnapshot, options: AgentModelRuntimeOptions): Promise<AgentModelRuntime> {
    assertSnapshotShape(snapshot);
    const runtime = snapshot.source === "local"
      ? await ModelRuntime.create({ authPath: join(options.engineDir, "auth.json"), modelsPath: join(options.engineDir, "models.json") })
      : await createModelRuntime();
    const slot = new AgentModelRuntime(options.agentKey, runtime, snapshot);
    await slot.install(snapshot);
    const { model } = slot.current();
    if (!(await runtime.getAuth(model))) throw new Error(`provider 未配置凭证：${model.provider}`);
    return slot;
  }

  snapshot(): AgentModelSnapshot {
    return cloneSnapshot(this.snapshotValue);
  }

  current(): ResolvedAgentModel {
    return resolveSnapshot(this.runtime, this.snapshotValue);
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
      const resolved = resolveSnapshot(this.runtime, snapshot);
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
    const candidate = snapshot.source === "local" ? this.runtime : await createModelRuntime();
    if (snapshot.source === "inline") await configureInline(candidate, snapshot);
    const { model } = resolveSnapshot(candidate, snapshot);
    if (!(await candidate.getAuth(model))) throw new Error(`provider 未配置凭证：${snapshot.selection.providerId}`);
    return candidate;
  }

  /** Apply snapshot contents to the stable runtime object. */
  private async install(snapshot: AgentModelSnapshot): Promise<void> {
    if (snapshot.source === "local") return;
    if (this.inlineProviderId) {
      this.runtime.unregisterProvider(this.inlineProviderId);
      await this.runtime.removeRuntimeApiKey(this.inlineProviderId);
    }
    this.inlineProviderId = selectedProvider(snapshot).providerType;
    await configureInline(this.runtime, snapshot);
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
  if (out.providers) out.providers = out.providers.map((p) => ({
    ...p, headers: undefined, models: p.models.map((model) => ({ ...model, headers: undefined })),
  }));
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
