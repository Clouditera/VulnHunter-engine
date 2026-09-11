/**
 * Code Coverage（tracker + viewer 合并版）
 *
 * 只留查询职能：coverage() 工具。记录由 workflow runner 在 hunt 会话的
 * read 事件里完成（extensions/runner/runtime.ts），目标根 = workflow 的 cwd。
 *
 * 路径一律按调用现场的会话目录（ExtensionContext.cwd）解析——禁用 process.cwd()：
 * 节点会话与 runner 同进程，process.cwd() 是 runner 启动目录，不一定是目标项目。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  perScopeStats,
  loadScope,
  persistCoverageMap,
  renderCoverage,
} from "./coverage-core.ts";

export default function (pi: ExtensionAPI) {
  // 路径一律按调用现场的会话目录（ExtensionContext.cwd）解析——禁用 process.cwd()：
  // 节点会话与 runner 同进程，process.cwd() 是 runner 启动目录，不一定是目标项目。
  const resolve = (cwd: string) => {
    const outputDir = path.resolve(cwd, ".vulnforge");
    const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
    return { outputDir, jsonPath, jsonlPath, targetRoot: path.resolve(cwd) };
  };

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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { outputDir, jsonPath, jsonlPath, targetRoot } = resolve(ctx.cwd);
      const map = loadCoverageMap(jsonPath, targetRoot, outputDir);
      aggregateCoverageEvents(jsonlPath, map);
      persistCoverageMap(map, jsonPath);

      if (params.scope === "marked") {
        const scope = loadScope(outputDir);
        if (!scope) {
          return { content: [{ type: "text" as const, text: "尚未标记范围（.vulnforge/scope.yaml 不存在）——主会话用 mark_scope 与用户确认审计范围。" }], details: {} };
        }
        const stats = perScopeStats(map, scope);
        const lines = stats.map((st) =>
          `${st.pass ? "✅" : "❌"} ${st.path}  ${st.pct}%（${st.read}/${st.total} 行，阈值 ${st.threshold}%）`);
        const failed = stats.filter((st) => !st.pass).length;
        return { content: [{ type: "text" as const, text:
          `标记范围覆盖（${stats.length - failed}/${stats.length} 达标）：\n` + lines.join("\n") }], details: {} };
      }

      return {
        content: [{ type: "text" as const, text: renderCoverage(map, params) }],
        details: {},
      };
    },
  }));
}
