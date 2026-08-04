/**
 * Code Coverage（tracker + viewer 合并版）
 *
 * 一个扩展两个职能，由配置面区分角色：
 *   - 记录：仅当进程有 VULNFORGE_COVERAGE_TRACK 环境变量时钩 tool_result(read)
 *     追加事件流（hunt 经 frontmatter envs 独占该变量——"仅记录 hunt"由挂载
 *     配置表达，扩展内无阶段硬编码）。
 *   - 查询：coverage() 工具无条件注册；谁调得到由 tools 白名单自然决定
 *     （hunt 白名单不含 coverage，decide/report 无白名单限制）。
 *
 * 工作区根定死 <cwd>/.vulnforge；目标根 = cwd。
 */
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  persistCoverageMap,
  recordReadCoverageEvent,
  renderCoverage,
} from "./coverage-core.ts";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const outputDir = path.join(cwd, ".vulnforge");

  const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
  const targetRoot = path.resolve(cwd);
  const resolvedOutputDir = path.resolve(outputDir);

  const map = loadCoverageMap(jsonPath, targetRoot, resolvedOutputDir);
  aggregateCoverageEvents(jsonlPath, map);
  persistCoverageMap(map, jsonPath);

  // 记录侧：env 开关（frontmatter envs 注入，hunt 独占）
  if (process.env.VULNFORGE_COVERAGE_TRACK) {
    const stage = process.env.VULNFORGE_STAGE ?? "unknown";
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

  // 查询侧：无条件注册（可见性由 tools 白名单决定）
  pi.registerTool(defineTool({
    name: "coverage",
    label: "Coverage",
    description: "查看代码阅读覆盖率。像 tree 命令一样浏览项目的代码阅读覆盖情况。",
    promptSnippet: "coverage(path?, depth?) — 查看代码阅读覆盖率树。不传参数返回全局概览，传目录路径展开子项，传文件路径查看行级覆盖详情。depth 控制展开深度（默认 1）。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "目录或文件路径（相对于项目根目录）。省略则显示项目根级概览。" })),
      depth: Type.Optional(Type.Number({ description: "目录树展开深度，默认 1。类似 tree -L。", default: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (aggregateCoverageEvents(jsonlPath, map)) {
        persistCoverageMap(map, jsonPath);
      }

      return {
        content: [{ type: "text" as const, text: renderCoverage(map, params) }],
      };
    },
  }));
}
