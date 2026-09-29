import type { CreateAgentSessionOptions, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_THINKING_LEVELS, type AgentModelSelection } from "./agent-model.ts";
import { resolveModel } from "./model-config.ts";

type Model = NonNullable<CreateAgentSessionOptions["model"]>;

/** Resolve once before session creation. Platform callers supply the memory runtime and model;
 * only standalone callers without them consult their local SDK model source. */
export async function sessionModelOptions(engineDir: string, settings: SettingsManager, input: {
  modelSpec?: string; modelRuntime?: ModelRuntime; model?: Model; thinking?: string;
}): Promise<{ options: Pick<CreateAgentSessionOptions, "model" | "modelRuntime" | "thinkingLevel">; expected?: AgentModelSelection }> {
  let model = input.model;
  let runtime = input.modelRuntime;
  let requestedThinking = input.thinking;
  if (!model && input.modelSpec) {
    const resolved = await resolveModel(engineDir, input.modelSpec);
    model = resolved.model; runtime = resolved.runtime; requestedThinking = resolved.parsed.thinking;
  }
  const thinking = AGENT_THINKING_LEVELS.find((level) => level === requestedThinking);
  if (requestedThinking !== undefined && thinking === undefined) throw new Error(`不支持的 thinking level：${requestedThinking}`);
  const providerId = model?.provider ?? settings.getDefaultProvider();
  const modelId = model?.id ?? settings.getDefaultModel();
  return {
    options: { ...(model ? { model } : {}), ...(runtime ? { modelRuntime: runtime } : {}), ...(thinking ? { thinkingLevel: thinking } : {}) },
    ...(providerId && modelId ? { expected: { providerId, modelId, ...(thinking ? { thinking } : {}) } } : {}),
  };
}
