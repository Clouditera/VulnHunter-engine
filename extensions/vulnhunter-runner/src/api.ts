/** Embedding entry: no pi tool registration and no HTTP listener side effects. */
import { WorkflowRunnerEngine, type WorkflowRunnerEngineOptions } from "./control.ts";
import { getWorkflow } from "./workflows/registry.ts";

export function createRunner(options: Omit<WorkflowRunnerEngineOptions, "loadWorkflow">): WorkflowRunnerEngine {
  return new WorkflowRunnerEngine({ ...options, loadWorkflow: async (name) => getWorkflow(name) });
}

export { WorkflowRunnerEngine, ControlError } from "./control.ts";
export type { StartRunRequest, RunnerRunView, RunnerRunStatus } from "./control.ts";
export type { AgentModelSnapshot, AgentModelSelection } from "./agent-model.ts";

export { AgentModelRuntime } from "./agent-model.ts";
export { sessionSettings } from "./session-settings.ts";
