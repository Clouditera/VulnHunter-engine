/**
 * 监控台（TUI overlay）：单弹窗三 tab——运行 / 节点详情 / 覆盖率。
 * 快捷键呼出（默认 ctrl+o），Tab/←→ 或 1/2/3 切页，↑↓ 选择，Esc/q 关闭。
 * 数据源：monitorState（进程内注册表）+ 节点 session jsonl + code-coverage 数据。
 */

import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monitorState } from "./monitor-state.ts";
import { loadScope, loadCoverageMap, aggregateCoverageEvents, perScopeStats, getCoveragePaths } from "../node-ext/code-coverage/coverage-core.ts";

type Tab = "run" | "detail" | "coverage";

const TAB_NAMES: [Tab, string][] = [["run", "运行"], ["detail", "节点详情"], ["coverage", "覆盖率"]];

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/** 读 session jsonl 尾部，渲染最近若干条（思考/文本/工具调用） */
function renderSessionTail(file: string, maxLines: number): string[] {
  const out: string[] = [];
  let entries: any[] = [];
  try {
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    entries = lines.slice(-60).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return [`（无法读取 ${file}）`]; }
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    for (const c of m.content ?? []) {
      if (c.type === "thinking") out.push(`  💭 ${String(c.thinking).slice(0, 120).replace(/\n/g, " ")}`);
      else if (c.type === "text" && String(c.text).trim()) out.push(`  💬 ${String(c.text).slice(0, 160).replace(/\n/g, " ")}`);
      else if (c.type === "toolCall") out.push(`  🔧 ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 100)}`);
      else if (c.type === "toolResult") out.push(`  ↳ ${String(typeof c.content === "string" ? c.content : JSON.stringify(c.content)).slice(0, 100)}`);
    }
  }
  return out.slice(-maxLines);
}

export function createMonitorComponent(tui: TUI, theme: Theme, workdir: string, done: (r: void) => void): Component & { dispose(): void } {
  let tab: Tab = "run";
  let selected = 0;
  let disposed = false;
  const timer = setInterval(() => { if (!disposed) tui.requestRender(); }, 2000);

  function renderRun(width: number): string[] {
    const lines: string[] = [];
    const nodes = [...monitorState.running.values()];
    lines.push("── 在跑节点 ──");
    if (!nodes.length) lines.push("  （空闲）");
    nodes.forEach((n, i) => {
      const mark = i === selected ? "▶" : " ";
      lines.push(` ${mark} ${n.agent}${n.target ? ` · ${n.target}` : ""} · ${fmtDur(Date.now() - n.startTs)}`);
    });
    lines.push("", "── 队列 ──");
    for (const [label, d] of [["待消费 leads", "leads"], ["消费中 todo", "todo"], ["归档 done", "done"]] as const) {
      const p = join(workdir, d);
      const n = existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".md")).length : 0;
      lines.push(`  ${label}: ${n}`);
    }
    lines.push("", "── 最近事件 ──");
    for (const e of monitorState.events.slice(-8)) lines.push(`  [${fmtTime(e.ts)}] ${e.msg}`.slice(0, width - 4));
    return lines;
  }

  function renderDetail(width: number, height: number): string[] {
    const nodes = [...monitorState.running.values()];
    const n = nodes[Math.min(selected, nodes.length - 1)];
    if (!n) return ["（无在跑节点——运行页选择后回车查看）"];
    const lines = [
      `节点: ${n.agent}   目标: ${n.target ?? "-"}   已运行: ${fmtDur(Date.now() - n.startTs)}`,
      `session: ${n.sessionFile ?? "（未知）"}`,
      "─".repeat(Math.min(width - 4, 60)),
    ];
    if (n.sessionFile) lines.push(...renderSessionTail(n.sessionFile, Math.max(10, height - 8)));
    return lines;
  }

  function renderCoverage(width: number): string[] {
    const scope = loadScope(workdir);
    if (!scope) return ["（无 scope.yaml——mark_scope 未设置）"];
    const cov = getCoveragePaths(workdir);
    const map = loadCoverageMap(cov.jsonPath, join(workdir, ".."), workdir);
    aggregateCoverageEvents(cov.jsonlPath, map);
    const stats = perScopeStats(map, scope);
    const lines = ["── scope 覆盖率门禁 ──"];
    for (const s of stats) {
      const bar = "█".repeat(Math.round(s.pct / 10)) + "░".repeat(10 - Math.round(s.pct / 10));
      lines.push(`  ${s.pass ? "✓" : "✗"} ${s.path}  ${bar} ${s.pct.toFixed(1)}% (${s.read}/${s.total}) 阈值 ${s.threshold}%`);
    }
    return lines;
  }

  return {
    invalidate() { /* 无缓存渲染态 */ },
    render(width: number): string[] {
      const w = Math.min(width, 100);
      const inner = w - 4; // 左右边框+边距
      const row = (s: string) => `│ ${truncateToWidth(s, inner, "…", true)} │`;
      const tabs = TAB_NAMES.map(([k, label]) => (k === tab ? `[${label}]` : ` ${label} `)).join("  ");
      const height = process.stdout.rows ?? 30;
      const body = tab === "run" ? renderRun(inner) : tab === "detail" ? renderDetail(inner, height) : renderCoverage(inner);
      const title = " VulnHunter 监控台 ";
      const titleW = visibleWidth(title);
      return [
        `┌${title}${"─".repeat(Math.max(0, w - 2 - titleW))}┐`,
        row(`${tabs}    [Tab 切换] [Esc 关闭]`),
        `├${"─".repeat(w - 2)}┤`,
        ...body.map(row),
        `└${"─".repeat(w - 2)}┘`,
      ];
    },
    handleInput(data: string): void {
      if (data === "\u001b" || data === "q") { done(); return; }
      if (data === "\t" || data === "\u001b[C") tab = TAB_NAMES[(TAB_NAMES.findIndex(([k]) => k === tab) + 1) % 3][0];
      else if (data === "\u001b[D") tab = TAB_NAMES[(TAB_NAMES.findIndex(([k]) => k === tab) + 2) % 3][0];
      else if (data === "1" || data === "2" || data === "3") tab = TAB_NAMES[parseInt(data) - 1][0];
      else if (data === "\u001b[A") selected = Math.max(0, selected - 1);
      else if (data === "\u001b[B") selected = Math.min(monitorState.running.size - 1, selected + 1);
      else if (data === "\r" && tab === "run") tab = "detail";
      tui.requestRender();
    },
    dispose() { disposed = true; clearInterval(timer); },
  };
}
