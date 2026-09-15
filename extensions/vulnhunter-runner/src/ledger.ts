/**
 * 会话台账（fish 09-15 定稿）：任务层 + 折叠层记录，并入 lineage 旁路。
 *
 * - 与 mark/goto/fork 等血缘同写 `<workdir>/sessions-lineage.jsonl`（一条时间线、按会话 id + 文件键控）；
 * - task = 一次 prompt 的完整生命周期（start/end 条目、时长、状态、attempt、操作计数）；
 * - fold = task summary（唯一折叠操作）——摘要条目、覆盖区间 [起,止]、成员任务；
 * - 追加制；coveredBy 是派生字段（消费端从 fold.members 反推），本模块不改写历史记录。
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 血缘/台账单行追加（失败无碍） */
export function lineage(workdir: string, rec: Record<string, unknown>): void {
  try { appendFileSync(join(workdir, "sessions-lineage.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* 记录失败无碍主流程 */ }
}

// ---------------------------------------------------------------------------
// 操作计数（task 区间内的工具活动聚合：计数 + 要点）
// ---------------------------------------------------------------------------

export interface OpsSummary {
  total: number;
  byTool: Record<string, number>;
  reads: number;
  /** create 产出的产物编号（拿不到编号时记类型） */
  artifacts: string[];
  errors: number;
}

export class OpsCounter {
  private total = 0;
  private byTool: Record<string, number> = {};
  private reads = 0;
  private errors = 0;
  private artifacts: string[] = [];
  private pending = new Map<string, { name: string; args?: Record<string, unknown> }>();

  /** tool_execution_start：暂存参数（pi 的 end 事件不带 args） */
  onStart(toolCallId: string, toolName: string, args?: unknown): void {
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
    this.pending.set(toolCallId, { name: toolName, args: a });
  }

  /** tool_execution_end：计数 + 要点（artifact create 的产物编号） */
  onEnd(toolCallId: string, toolName: string, isError: boolean, resultText?: string): void {
    const st = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    this.total++;
    this.byTool[toolName] = (this.byTool[toolName] ?? 0) + 1;
    if (toolName === "read") this.reads++;
    if (isError) this.errors++;
    if (toolName === "artifact" && !isError && st?.args?.op === "create") {
      const m = /编号\s+([A-Za-z0-9_·:.\-]+)/.exec(resultText ?? "");
      this.artifacts.push(m?.[1] ?? String(st.args.type ?? "artifact"));
    }
  }

  snapshot(): OpsSummary {
    return { total: this.total, byTool: { ...this.byTool }, reads: this.reads, artifacts: [...this.artifacts], errors: this.errors };
  }

  reset(): void {
    this.total = 0;
    this.byTool = {};
    this.reads = 0;
    this.errors = 0;
    this.artifacts = [];
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// 台账读取（折叠成员计算等；数据量小，按需全读过滤）
// ---------------------------------------------------------------------------

interface LedgerRow { action?: string; id?: string; file?: string; [k: string]: unknown }

export function loadLedgerRows(workdir: string): LedgerRow[] {
  try {
    return readFileSync(join(workdir, "sessions-lineage.jsonl"), "utf-8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LedgerRow; } catch { return null; } })
      .filter((x): x is LedgerRow => !!x);
  } catch { return []; }
}

/** task-end 记录（用于折叠成员计算；可按会话文件过滤） */
export function loadTaskEnds(workdir: string, file?: string): Array<Record<string, unknown>> {
  return loadLedgerRows(workdir).filter((r) => r.action === "task-end" && (!file || r.file === file || r.id === file));
}

/** 折叠覆盖集 → 成员任务 id 清单（start 与 end 均落在覆盖集内才算被覆盖） */
export function tasksCovering(workdir: string, file: string | undefined, coveredIds: Set<string>): string[] {
  const out: string[] = [];
  for (const t of loadTaskEnds(workdir, file)) {
    const s = t.startEntry as string | undefined;
    const e = t.endEntry as string | undefined;
    if (s && e && coveredIds.has(s) && coveredIds.has(e)) out.push(String(t.task ?? ""));
  }
  return out.filter(Boolean);
}
