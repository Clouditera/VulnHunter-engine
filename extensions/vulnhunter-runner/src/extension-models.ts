import type { AgentModelSnapshot } from "./agent-model.ts";
import { effectiveModelSpec, parseModelSpec, type ModelConfig } from "./model-config.ts";

export const AUDIT_MODEL_POOLS = ["init", "hunt", "verify"] as const;
export type AuditModelPool = typeof AUDIT_MODEL_POOLS[number];

/** Capture a complete committed parent snapshot, never separately read model definitions and keys.
 * Task model.json remains selection metadata only; it is not a provider/auth configuration source. */
export function auditModelSnapshots(parent: AgentModelSnapshot, choices: ModelConfig, pools: readonly AuditModelPool[] = AUDIT_MODEL_POOLS): Record<string, AgentModelSnapshot> {
  return Object.fromEntries(pools.map((pool) => {
    const snapshot = structuredClone(parent);
    snapshot.version = 1;
    const spec = effectiveModelSpec(choices, pool);
    if (spec) {
      const selected = parseModelSpec(spec);
      snapshot.selection = { providerId: selected.provider, modelId: selected.id, thinking: selected.thinking ?? parent.selection.thinking };
    }
    return [pool, snapshot];
  }));
}
