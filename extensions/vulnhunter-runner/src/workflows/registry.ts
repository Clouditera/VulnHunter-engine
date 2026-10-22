/** Only shipped workflows are executable. Library files are not discovered as workflows. */
import auditLite, { run } from "./audit-lite.ts";
import type { Workflow } from "../runtime.ts";

export const workflows: ReadonlyMap<string, Workflow> = new Map([
  [auditLite.name, { name: auditLite.name, description: auditLite.description, run }],
]);

export function getWorkflow(name: string): Workflow | undefined {
  return workflows.get(name);
}
