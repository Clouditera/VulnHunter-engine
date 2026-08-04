/**
 * Audit Lifecycle（执行彻底保障）
 *
 * 三个工具 + 一个结束钩子，仅挂主会话（decide）：
 *   mark_scope  —— 与用户确认审计范围后落标记：.vulnforge/scope.yaml（逐范围 threshold，默认 90）
 *   start_scan  —— 任务正式开始：写 scan-state.json（scope_hash 锚定范围版本）+ wsdiff-git 基线 commit
 *   report      —— 收尾验收：① 机械预检（逐 scope 覆盖率达标？无 poc/exp pending？）
 *                  不过直接返回差距；② 过 → delegation 事件桥派 report 子会话做语义验收，
 *                  读 report/completion.yaml 返回结论。
 *   结束钩子    —— turn_end 且 pi-subagents 无在跑子会话时：若 scan 已开始而 report
 *                  未验收（或验收后工作区有新进展），steer 补发提示（maxRetries 防死循环）。
 *                  用户打断无 turn_end 不触发；worklog 最近决策为 exit 时静默。
 */
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  loadScope,
  perScopeStats,
  type ScopeDef,
} from "../code-coverage/coverage-core.ts";

const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
const DEFAULT_THRESHOLD = 90;
const MAX_GATE_REMINDERS = 2;

interface ScanState {
  started_at: string;
  scope_hash: string;
  last_report: { at: string; verdict: string; commit: string | null } | null;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const outputDir = path.join(cwd, ".vulnforge");
  const scopePath = path.join(outputDir, "scope.yaml");
  const statePath = path.join(outputDir, "scan-state.json");
  const gitDir = path.join(outputDir, ".wsdiff-git");

  // ------------------------------------------------------------------ helpers

  const readState = (): ScanState | null => {
    try { return JSON.parse(readFileSync(statePath, "utf-8")); } catch { return null; }
  };
  const writeState = (s: ScanState) => writeFileSync(statePath, JSON.stringify(s, null, 2));

  const scopeHash = (): string =>
    existsSync(scopePath) ? createHash("sha256").update(readFileSync(scopePath)).digest("hex").slice(0, 16) : "";

  const git = async (args: string[]) =>
    pi.exec("git", ["--git-dir", gitDir, "--work-tree", outputDir, ...args], { cwd: outputDir });

  const ensureRepo = async () => {
    if (existsSync(path.join(gitDir, "HEAD"))) return;
    mkdirSync(gitDir, { recursive: true });
    await pi.exec("git", ["--git-dir", gitDir, "init", "-q"], { cwd: outputDir });
    await git(["config", "user.email", "wsdiff@vulnforge.local"]);
    await git(["config", "user.name", "workspace-diff"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "baseline", "--allow-empty"]);
  };

  const snapshotCommit = async (message: string): Promise<string | null> => {
    await ensureRepo();
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", message, "--allow-empty"]);
    const head = await git(["rev-parse", "HEAD"]);
    return head.code === 0 ? head.stdout.trim() : null;
  };

  /** 自上次验收 commit 后工作区是否有新进展（有新增 commit 即视为有）。 */
  const progressSince = async (commit: string | null): Promise<boolean> => {
    if (!commit) return true;
    const r = await git(["rev-list", "--count", `${commit}..HEAD`]);
    return r.code === 0 && parseInt(r.stdout.trim(), 10) > 0;
  };

  const hasActiveSubagents = (): boolean => {
    try {
      const reg = (globalThis as any)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)];
      if (!reg || !(reg.providers instanceof Map)) return false;
      for (const p of reg.providers.values()) {
        if ((p as any).listActiveWork?.().length > 0) return true;
      }
    } catch { /* 注册表缺失=无在跑 */ }
    return false;
  };

  const freshCoverageMap = () => {
    const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
    const map = loadCoverageMap(jsonPath, cwd, outputDir);
    aggregateCoverageEvents(jsonlPath, map);
    return map;
  };

  /** 机械预检：返回差距清单（空数组 = 全过）。 */
  const mechanicalGaps = (scope: ScopeDef | null): string[] => {
    const gaps: string[] = [];
    if (scope) {
      const map = freshCoverageMap();
      for (const st of perScopeStats(map, scope)) {
        if (!st.pass) gaps.push(`覆盖率未达标：${st.path} ${st.pct}%（${st.read}/${st.total} 行，阈值 ${st.threshold}%）`);
      }
    }
    const findingsDir = path.join(outputDir, "findings");
    if (existsSync(findingsDir)) {
      for (const d of readdirSync(findingsDir)) {
        const rp = path.join(findingsDir, d, "report.yaml");
        if (!existsSync(rp)) continue;
        const text = readFileSync(rp, "utf-8");
        const cls = text.match(/^finding_class:\s*(\S+)/m)?.[1];
        if (cls !== "vulnerability") continue;
        const poc = text.match(/^poc_status:\s*(\S+)/m)?.[1];
        const exp = text.match(/^exp_status:\s*(\S+)/m)?.[1];
        if (poc === "pending") gaps.push(`POC 未复现：${d}（poc_status: pending）`);
        if (exp === "pending") gaps.push(`EXP 未评估：${d}（exp_status: pending）`);
      }
    }
    return gaps;
  };

  /** 经 delegation 事件桥派 report 子会话，等 response。 */
  const dispatchReport = (task: string, timeoutMs: number): Promise<{ ok: boolean; info: string }> =>
    new Promise((resolve) => {
      const requestId = `audit-lifecycle-${Date.now()}`;
      const timer = setTimeout(() => { unsub(); resolve({ ok: false, info: `report 子会话超时（${timeoutMs}ms）` }); }, timeoutMs);
      const unsub = (pi.events as any).on(DELEGATION_RESPONSE_EVENT, (resp: any) => {
        if (resp?.requestId !== requestId) return;
        clearTimeout(timer); unsub?.();
        resolve({ ok: resp.status === "completed", info: resp.error ?? resp.output ?? `status=${resp.status}` });
      });
      (pi.events as any).emit(DELEGATION_REQUEST_EVENT, {
        version: 1, requestId, agent: "report", task, context: "fresh", cwd, timeoutMs,
      });
    });

  // ------------------------------------------------------------------ tools

  pi.registerTool(defineTool({
    name: "mark_scope",
    label: "Mark Scope",
    description: "标记审计范围：与用户确认后，将要审计的代码范围（文件/目录/glob，逐范围覆盖率阈值默认 90）写入 .vulnforge/scope.yaml。",
    promptSnippet: 'mark_scope(entries, excludes?) — 标记审计范围。entries: [{path, threshold?}]，threshold 默认 90。范围调整时重调覆盖。',
    parameters: Type.Object({
      entries: Type.Array(Type.Object({
        path: Type.String({ description: "相对项目根的文件/目录/glob 路径" }),
        threshold: Type.Optional(Type.Number({ description: `该范围覆盖率阈值（%），默认 ${DEFAULT_THRESHOLD}` })),
      })),
      excludes: Type.Optional(Type.Array(Type.String(), { description: "排除路径（同规则）" })),
    }),
    async execute(_id, params) {
      const bad = params.entries.filter((e) => {
        const p = e.path.replace(/\*+$/, "");
        return p && !existsSync(path.resolve(cwd, p));
      });
      if (bad.length) {
        return { content: [{ type: "text" as const, text: `以下路径在项目中不存在：${bad.map((b) => b.path).join("、")}——确认后再标。` }], isError: true };
      }
      const lines = ["entries:"];
      for (const e of params.entries) {
        lines.push(`  - path: ${e.path}`);
        lines.push(`    threshold: ${e.threshold ?? DEFAULT_THRESHOLD}`);
      }
      lines.push("excludes:");
      for (const x of params.excludes ?? []) lines.push(`  - ${x}`);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(scopePath, lines.join("\n") + "\n");
      return { content: [{ type: "text" as const, text: `范围已标记：${params.entries.length} 个条目（默认阈值 ${DEFAULT_THRESHOLD}%）。${readState() ? "" : "下一步：start_scan 正式开始。"}` }] };
    },
  }));

  pi.registerTool(defineTool({
    name: "start_scan",
    label: "Start Scan",
    description: "正式开始审计任务：记录扫描起点（scope 版本锚定 + workspace 基线 commit）。须先 mark_scope。",
    promptSnippet: "start_scan() — 正式开始任务：锚定范围版本并固化工作区基线。前置：mark_scope。",
    parameters: Type.Object({}),
    async execute() {
      if (!existsSync(scopePath)) {
        return { content: [{ type: "text" as const, text: "尚未标记审计范围——先与用户确认范围并调用 mark_scope。" }], isError: true };
      }
      const commit = await snapshotCommit("scan-start");
      writeState({ started_at: new Date().toISOString(), scope_hash: scopeHash(), last_report: null });
      return { content: [{ type: "text" as const, text: `扫描开始。范围版本 ${scopeHash()}，基线 commit ${commit?.slice(0, 8) ?? "?"}。收尾时调用 report 验收。` }] };
    },
  }));

  pi.registerTool(defineTool({
    name: "report",
    label: "Report",
    description: "收尾验收：机械预检（覆盖率/未决动态状态）→ 派 report 子会话隔离复核 → 返回任务是否执行彻底。",
    promptSnippet: "report() — 收尾验收：机械预检不过返回差距清单；过了派 report 子会话复核并返回完成结论。",
    parameters: Type.Object({}),
    async execute() {
      const state = readState();
      if (!state) return { content: [{ type: "text" as const, text: "尚未 start_scan——没有进行中的扫描任务。" }], isError: true };
      if (state.scope_hash !== scopeHash()) {
        return { content: [{ type: "text" as const, text: "范围自 start_scan 后已变更——如需按新范围验收，请重新 start_scan。" }], isError: true };
      }
      const gaps = mechanicalGaps(loadScope(outputDir));
      if (gaps.length) {
        return { content: [{ type: "text" as const, text: `pass: false——机械预检未过：\n${gaps.map((g) => `- ${g}`).join("\n")}\n继续推进后再验收。` }] };
      }
      const r = await dispatchReport("执行收尾复核：按任务书对账 scope.yaml 标记范围、coverage、findings 与任务池，产出 report/completion.yaml、audit-report.yaml、summary.md。", 1800000);
      const cp = path.join(outputDir, "report", "completion.yaml");
      let verdict = "unknown", reason = "";
      if (existsSync(cp)) {
        const text = readFileSync(cp, "utf-8");
        verdict = text.match(/^status:\s*(\S+)/m)?.[1] ?? "unknown";
        reason = text.match(/^reason:\s*(.+)$/m)?.[1] ?? "";
      }
      const commit = await snapshotCommit("post-report");
      writeState({ ...state, last_report: { at: new Date().toISOString(), verdict, commit } });
      return { content: [{ type: "text" as const, text: `report 子会话：${r.ok ? "完成" : `异常（${r.info}）`}；completion: ${verdict}${reason ? `——${reason}` : ""}` }] };
    },
  }));

  // ------------------------------------------------------------------ 结束钩子

  let reminders = 0;
  pi.on("turn_end", async (event) => {
    const hasToolCalls = event.message?.content?.some((c: { type: string }) => c.type === "toolCall");
    if (hasToolCalls) return;                     // 仍在工作
    if (hasActiveSubagents()) return;             // 后台有活，不算停止
    const state = readState();
    if (!state) return;                           // 未 start_scan
    if (state.scope_hash !== scopeHash()) return; // 范围已变，等重新 start_scan
    // worklog 最近决策为 exit → 异常退出路径，静默
    try {
      const wl = readFileSync(path.join(outputDir, "knowledge", "worklog.md"), "utf-8").trim().split("\n").filter(Boolean).pop() ?? "";
      if (/\bexit\b/i.test(wl)) return;
    } catch { /* 无 worklog 继续判 */ }
    if (state.last_report && !(await progressSince(state.last_report.commit))) return; // 已验收且无新进展
    if (reminders >= MAX_GATE_REMINDERS) return;
    reminders++;
    pi.sendUserMessage(
      "扫描仍在进行但未验收：请调用 report 工具做收尾验收（覆盖率/未决状态预检 + report 子会话隔离复核）。若确认任务应异常退出，请在 worklog 记录 exit 决策。",
      { deliverAs: "steer" },
    );
  });
}
