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
  perScopeStats,
  loadScope,
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
    description: "查看代码阅读覆盖率。scope=global 看全项目，scope=marked 看 mark_scope 标记范围（逐范围对照阈值）。",
    promptSnippet: "coverage(scope, path?, depth?) — scope 必填：\"global\" 全项目覆盖 / \"marked\" 标记范围对照阈值。path/depth 仅 global 视图使用。",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("global"), Type.Literal("marked")], { description: "必填。global=全项目；marked=mark_scope 标记范围（逐范围覆盖率 vs 阈值）。" }),
      path: Type.Optional(Type.String({ description: "目录或文件路径（相对于项目根目录，仅 global）。省略则显示项目根级概览。" })),
      depth: Type.Optional(Type.Number({ description: "目录树展开深度，默认 1（仅 global）。", default: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (aggregateCoverageEvents(jsonlPath, map)) {
        persistCoverageMap(map, jsonPath);
      }

      if (params.scope === "marked") {
        const scope = loadScope(resolvedOutputDir);
        if (!scope) {
          return { content: [{ type: "text" as const, text: "尚未标记范围（.vulnforge/scope.yaml 不存在）——decide 先用 mark_scope 与用户确认审计范围。" }] };
        }
        const stats = perScopeStats(map, scope);
        const lines = stats.map((st) =>
          `${st.pass ? "✅" : "❌"} ${st.path}  ${st.pct}%（${st.read}/${st.total} 行，阈值 ${st.threshold}%）`);
        const failed = stats.filter((st) => !st.pass).length;
        return { content: [{ type: "text" as const, text:
          `标记范围覆盖（${stats.length - failed}/${stats.length} 达标）：\n` + lines.join("\n") }] };
      }

      return {
        content: [{ type: "text" as const, text: renderCoverage(map, params) }],
      };
    },
  }));
}
