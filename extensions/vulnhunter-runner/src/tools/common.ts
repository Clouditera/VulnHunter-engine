/**
 * 工具层公共设施（工具重构 2026-09-20，fish 定稿 v4）。
 *
 * 原则：
 *   - 结构化对象（sandbox/hyp/finding/profiler）由工具独占读写；agent 不经手存储。
 *   - 存储：JSON 单文件（原子写 tmp+rename）；事件留痕走 sessions-lineage.jsonl。
 *   - 阶段限制只到工具级：STAGE_TOOLS 是「阶段→可用工具」的唯一事实源；工具内 op 不设限。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WsContext {
  /** 工作区根 <cwd>/.vulnforge */
  workdir: string;
  /** 目标项目根 */
  cwd: string;
}

/** 节点绑定的上下文（runner 拉起节点时注入） */
export interface ToolBinding {
  /** 本会话产物编号的 tag（如 hunt1 / research1）→ HYP-<tag>-H<n> */
  tag?: string;
  /** 链会话正在研判的 HYP id（finding 编号继承：BUG-<链>） */
  hypId?: string;
  /** 阶段名（装配期过滤工具面；运行时留痕） */
  stage?: string;
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
export function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export function ensureDir(p: string) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

export function listDir(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p);
}

export function readJSON<T = any>(p: string): T | null {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; }
}

/** 原子写 JSON（tmp + rename） */
export function atomicWriteJSON(p: string, obj: unknown): void {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
}

/** 序列名取号：扫名字列表，取匹配正则组 1 的最大序号 +1 */
export function nextSerial(names: string[], re: RegExp): number {
  let max = 0;
  for (const n of names) {
    const m = n.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** schema 外字段一律拒绝（教学化报错） */
export function rejectUnknown(params: Record<string, unknown>, known: string[]): string | null {
  const ks = new Set(known);
  const bad = Object.keys(params).filter((k) => !ks.has(k));
  if (!bad.length) return null;
  return `schema 外字段：${bad.join(", ")}。本工具可写字段固定，收到 = [${known.join(", ")}]`;
}

/** 阶段 → 可用工具（工具级限制的唯一事实源；引擎/调度侧不受限） */
export const STAGE_TOOLS: Record<string, string[]> = {
  onboard: ["profiler"],
  "init-host": ["profiler", "hyp"],
  build: ["sandbox"],
  research: ["hyp"],
  compress: [],
  hunt: ["hyp"],
  "hunt-intuition": ["hyp"],
  "static-verify": ["hyp", "finding"],
  "dynamic-verify": ["hyp", "finding", "sandbox"],
  "hyp-chain": ["hyp", "finding", "sandbox"],
  "ev-assess": ["finding", "sandbox"],
};

export function stageTools(stage: string): string[] {
  return STAGE_TOOLS[stage] ?? [];
}

/** 存储路径约定（单一事实源） */
export const paths = {
  sandbox: (workdir: string) => join(workdir, "system", "sandbox.json"),
  profiler: (workdir: string) => join(workdir, "system", "profiler.json"),
  hypDir: (workdir: string) => join(workdir, "system", "hyp"),
  hyp: (workdir: string, id: string) => join(workdir, "system", "hyp", `${id}.json`),
  findingDir: (workdir: string, id: string) => join(workdir, "findings", id),
  finding: (workdir: string, id: string) => join(workdir, "findings", id, "record.json"),
  findingAttach: (workdir: string, id: string) => join(workdir, "findings", id, "attachments"),
};
