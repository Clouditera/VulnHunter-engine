import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  persistCoverageMap,
  recordReadCoverageEvent,
} from "./coverage-core.ts";

export default function (pi: ExtensionAPI) {
  // 工作区根定死 <cwd>/.vulnforge；目标根 = cwd
  const cwd = process.cwd();
  const outputDir = path.join(cwd, ".vulnforge");
  const workDir = cwd;
  const stage = process.env.VULNFORGE_STAGE ?? "unknown";

  const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
  const targetRoot = path.resolve(workDir);
  const resolvedOutputDir = path.resolve(outputDir);

  const map = loadCoverageMap(jsonPath, targetRoot, resolvedOutputDir);
  aggregateCoverageEvents(jsonlPath, map);
  persistCoverageMap(map, jsonPath);

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;
    recordReadCoverageEvent({
      jsonlPath,
      targetRoot,
      stage,
      input: event.input as { path?: string; offset?: number; limit?: number } | undefined,
    });
  });
}
