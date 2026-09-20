/**
 * Code Coverage —— 独立扩展：记录 + 查询一体（09-20 从 runner 解耦，记录侧迁入）。
 *
 * 记录：订阅本会话 tool_execution 事件，配对 read 调用落账；开关由 /coverage-record 命令控制
 * （hunt 轮起/止时 runner 发命令），存储由本扩展自管（system/coverage/）。
 * 查询：coverage() 工具（global / marked）。
 * 路径一律按调用现场的会话目录（ExtensionContext.cwd）解析——禁用 process.cwd()：
 * 节点会话与 runner 同进程，process.cwd() 是 runner 启动目录，不一定是目标项目。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageConfig,
  loadCoverageMap,
  perScopeStats,
  loadScope,
  persistCoverageMap,
  recordReadCoverageEvent,
  renderCoverage,
} from "./coverage-core.ts";

// 记录开关：模块级（同一模块在同一进程内只加载一次；防「命令实例 ≠ 事件实例」错配时静默失效）
let recording = false;

export default function (pi: ExtensionAPI) {
  // 路径一律按调用现场的会话目录（ExtensionContext.cwd）解析——禁用 process.cwd()
  const resolve = (cwd: string) => {
    const outputDir = path.resolve(cwd, ".vulnforge");
    const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
    return { outputDir, jsonPath, jsonlPath, targetRoot: path.resolve(cwd) };
  };
  type CovPaths = ReturnType<typeof resolve>;

  // ============================================================================
  // 记录侧：read 事件配对落账；/coverage-record on|off 控制开关（09-20 自 runner 迁入）
  // ============================================================================
  const pendingReads = new Map<string, unknown>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushNow = (r: CovPaths) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    try {
      const map = loadCoverageMap(r.jsonPath, r.targetRoot, r.outputDir);
      if (aggregateCoverageEvents(r.jsonlPath, map)) persistCoverageMap(map, r.jsonPath);
    } catch { /* 记录失败不阻塞会话 */ }
  };
  const scheduleFlush = (r: CovPaths) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = undefined; flushNow(r); }, 500);
  };

  pi.on("tool_execution_start", (ev) => {
    if (!recording || ev.toolName !== "read") return;
    pendingReads.set(ev.toolCallId, ev.args);
  });

  pi.on("tool_execution_end", (ev, ctx) => {
    if (ev.toolName !== "read") return;
    const a = pendingReads.get(ev.toolCallId);
    pendingReads.delete(ev.toolCallId);
    if (!recording || ev.isError || !a) return;
    const r = resolve(ctx.cwd);
    try {
      recordReadCoverageEvent({
        jsonlPath: r.jsonlPath, targetRoot: r.targetRoot, stage: "hunt",
        input: a as { path?: string; offset?: number; limit?: number },
        cfg: loadCoverageConfig(r.outputDir), outputDir: r.outputDir,
      });
      scheduleFlush(r);
    } catch { /* 记录失败不阻塞会话 */ }
  });

  // 会话启动：枚举靶文件并落初始快照（空目标护栏与监控立即可读；尚无记录也写）
  pi.on("session_start", (_ev, ctx) => {
    try { flushNow(resolve(ctx.cwd)); } catch { /* 无碍 */ }
  });

  // 控制命令：runner 在 hunt 起/止时调用；人也可手动用
  pi.registerCommand("coverage-record", {
    description: "覆盖率记录开关：on / off / status",
    handler: async (args, ctx) => {
      const a = String(args ?? "").trim();
      const r = resolve(ctx.cwd);
      const notify = (m: string) => { try { ctx.ui?.notify?.(m); } catch { /* headless 无 UI */ } };
      if (a === "on") { recording = true; notify("coverage 记录：已开启"); return; }
      if (a === "off") { recording = false; flushNow(r); notify("coverage 记录：已关闭并落盘"); return; }
      if (a === "status") {
        let pct = "无快照";
        try {
          const d = JSON.parse(readFileSync(r.jsonPath, "utf-8")) as { summary?: { coverage?: number; read_lines?: number; total_lines?: number } };
          const s = d.summary ?? {};
          pct = `${((s.coverage ?? 0) * 100).toFixed(2)}%（${s.read_lines ?? 0}/${s.total_lines ?? 0} 行）`;
        } catch { /* 无快照 */ }
        notify(`coverage 记录：${recording ? "开" : "关"}；当前覆盖 ${pct}`);
        return;
      }
      notify(`用法：/coverage-record on|off|status（收到 "${a}"）`);
    },
  });

  // ============================================================================
  // 查询侧：无条件注册（可见性由 tools 白名单决定）
  // ============================================================================
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
