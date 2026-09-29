import {
  createProvider, envApiKeyAuth, InMemoryCredentialStore, type Api, type Model, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";

/** JSON model definitions. No runtime provider identity or authentication belongs inside a model. */
export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<Model<Api>["cost"]>;
  inputLimits?: Model<Api>["inputLimits"];
  promptCache?: Model<Api>["promptCache"];
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
}

export interface ProviderDefinition {
  id: string;
  name?: string;
  api: string;
  baseUrl: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinition[];
}

// These are SDK implementations, not a second protocol/client implementation.
const apis: Record<string, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "google-vertex": googleVertexApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "mistral-conversations": mistralConversationsApi,
  "pi-messages": piMessagesApi,
};
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function registerModelProvider(runtime: ModelRuntime, definition: ProviderDefinition): void {
  const p = structuredClone(definition);
  if (!p.id || !p.api || !p.baseUrl || !Array.isArray(p.models) || p.models.length === 0) {
    throw new Error(`provider ${p.id || "(empty)"} 缺少 api/baseUrl/models`);
  }
  const models: Model<Api>[] = p.models.map((model) => ({
    ...model,
    id: model.id, name: model.name ?? model.id, provider: p.id,
    api: model.api ?? p.api, baseUrl: model.baseUrl ?? p.baseUrl,
    reasoning: model.reasoning ?? false, input: model.input ?? ["text"],
    contextWindow: model.contextWindow ?? 128000, maxTokens: model.maxTokens ?? 16384,
    cost: { ...ZERO_COST, ...model.cost },
  }));
  const implementations: Record<string, ProviderStreams> = {};
  for (const model of models) {
    const factory = apis[model.api];
    if (!factory) throw new Error(`不支持的模型协议：${model.api}`);
    implementations[model.api] ??= factory();
  }
  const auth = envApiKeyAuth(p.name ?? p.id, []);
  const apiKeyAuth = p.authHeader || p.headers ? {
    ...auth,
    async resolve(input: Parameters<typeof auth.resolve>[0]) {
      const result = await auth.resolve(input);
      if (!result) return undefined;
      return { ...result, auth: { ...result.auth, headers: {
        ...p.headers,
        ...(p.authHeader ? { Authorization: `Bearer ${result.auth.apiKey}` } : {}),
      } } };
    },
  } : auth;
  runtime.registerNativeProvider(createProvider({
    id: p.id, name: p.name, baseUrl: p.baseUrl, headers: p.headers,
    // Native SDK auth consumes stored keys literally; [] disables ambient-env credential fallback.
    // Unlike models.json/registerProvider config expressions, native headers are ordinary values too.
    auth: { apiKey: apiKeyAuth },
    models,
    api: implementations,
  }));
}

export function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
}
