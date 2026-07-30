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
  // 会话化：工作区根 = <cwd>/.vulnforge（存在即采用，否则 cwd）；目标根 = cwd
  const cwd = process.cwd();
  const outputDir = require("node:fs").existsSync(path.join(cwd, ".vulnforge"))
    ? path.join(cwd, ".vulnforge")
    : cwd;
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
