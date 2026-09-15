/**
 * session-state：会话状态视图（fish 09-15 会话管理③）。
 *
 * 数据源：会话 jsonl（条目树）+ workdir 台账（task/fold 记录）。
 * 输出三块：①任务定位（起止/状态/时长/覆盖）②摘要映射（覆盖集/嵌套关系/成员）③活态（叶/在途任务/距上次摘要）。
 *
 * 消费端：观察台 GET /api/session-state、进程内 SessionHandle.state()。
 * 边界纪律：缺数据留空（在途任务无 startEntry、旧会话无账本），不从相邻标签猜。
 */

import { readFileSync } from "node:fs";
import { loadLedgerRows } from "./ledger.ts";

export interface SessEntryLike { id: string; parentId: string | null; type?: string; [k: string]: unknown }

export interface TaskView {
  task: string;
  label?: string;
  agent?: string;
  target?: string;
  prompt?: string;
  startEntry?: string;
  endEntry?: string;
  status: string;            // running | done | aborted
  attempts?: number;
  startedAt?: string;
  durationMs?: number;
  ops?: unknown;
  coveredBy: string[];       // 直接覆盖本任务的 fold（summaryEntry 列表）
}

export interface FoldView {
  id: string;                // summaryEntry 条目 id
  label: string;             // summaryLabel（Σ…）
  attach?: string;
  from?: string;
  covered: number;
  coveredIds: string[];      // 覆盖集（含嵌套摘要条目）
  members: string[];         // 覆盖集内 start/end 双双被覆盖的 task
  childFolds: string[];      // 本 fold 覆盖的嵌套摘要（间接覆盖的入口）
  ts: string;
}

export interface SessionState {
  file: string;
  leafId: string | null;
  entryCount: number;
  tasks: TaskView[];
  folds: FoldView[];
  active: {
    leafId: string | null;
    task?: string;           // 在途任务（task-start 无 task-end）
    startedAt?: string;
    msSinceStart?: number;
    nodesSinceFold: number | null;   // 自上次摘要以来新增节点数（无 fold 时 null）
  };
}

function readEntriesFromFile(file: string): SessEntryLike[] {
  try {
    return readFileSync(file, "utf-8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as SessEntryLike; } catch { return null; } })
      .filter((x): x is SessEntryLike => !!x && typeof x.id === "string");
  } catch { return []; }
}

/** 构建会话状态视图；entries/leafId 可由活动会话注入（进程内），缺省从 file 读 */
export function buildSessionState(opts: {
  file: string;
  workdir: string;
  entries?: SessEntryLike[];
  leafId?: string | null;
  sessionId?: string;
}): SessionState {
  const entries = opts.entries ?? readEntriesFromFile(opts.file);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const leafId = opts.leafId !== undefined ? opts.leafId : (entries.length ? entries[entries.length - 1].id : null);

  // 台账行：优先按会话文件键控；无 file 的记录按会话 id 兜底
  const rows = loadLedgerRows(opts.workdir).filter((r) => {
    if (r.file) return r.file === opts.file;
    return !!opts.sessionId && r.id === opts.sessionId;
  });

  // ① 任务：task-start / task-end 按 task id 合并（行序=时序）
  const tasksMap = new Map<string, TaskView>();
  for (const r of rows) {
    if (r.action !== "task-start" && r.action !== "task-end") continue;
    const task = String(r.task ?? "");
    if (!task) continue;
    const t: TaskView = tasksMap.get(task) ?? { task, status: "running", coveredBy: [] };
    t.label = (r.label as string) ?? t.label;
    t.agent = (r.agent as string) ?? t.agent;
    t.target = (r.target as string) ?? t.target;
    t.startedAt = (r.startedAt as string) ?? t.startedAt ?? (r.ts as string);
    if (r.action === "task-start") {
      t.prompt = r.prompt as string | undefined;
      t.status = t.endEntry ? t.status : "running";
    } else {
      t.startEntry = r.startEntry as string | undefined;
      t.endEntry = r.endEntry as string | undefined;
      t.status = String(r.status ?? "done");
      t.attempts = r.attempts as number | undefined;
      t.durationMs = r.durationMs as number | undefined;
      t.ops = r.ops;
    }
    tasksMap.set(task, t);
  }

  // ② 折叠：覆盖集/嵌套关系/成员；coveredBy 由 members 反推
  const folds: FoldView[] = rows.filter((r) => r.action === "fold").map((r) => ({
    id: String(r.summaryEntry ?? ""),
    label: String(r.summaryLabel ?? ""),
    attach: r.attach as string | undefined,
    from: r.from as string | undefined,
    covered: Number(r.covered ?? 0),
    coveredIds: Array.isArray(r.coveredIds) ? (r.coveredIds as unknown[]).map(String) : [],
    members: Array.isArray(r.members) ? (r.members as unknown[]).map(String) : [],
    childFolds: [],
    ts: String(r.ts ?? ""),
  })).filter((f) => !!f.id);
  const bySummary = new Map(folds.map((f) => [f.id, f]));
  for (const f of folds) {
    for (const id of f.coveredIds) {
      if (id !== f.id && bySummary.has(id)) f.childFolds.push(id);
    }
  }
  const tasks = [...tasksMap.values()];
  for (const t of tasks) t.coveredBy = folds.filter((f) => f.members.includes(t.task)).map((f) => f.id);

  // ③ 活态：叶位置 / 在途任务 / 距上次摘要的新增节点数（从叶上溯，遇覆盖集或摘要条目即停）
  const coveredAll = new Set<string>();
  for (const f of folds) for (const id of f.coveredIds) coveredAll.add(id);
  const summaryIds = new Set(folds.map((f) => f.id));
  let nodesSinceFold: number | null = null;
  if (folds.length) {
    nodesSinceFold = 0;
    let cur: string | null = leafId;
    let guard = 0;
    while (cur && guard++ < 200000) {
      if (coveredAll.has(cur) || summaryIds.has(cur)) break;
      nodesSinceFold++;
      const e = byId.get(cur);
      if (!e) break;
      cur = (e.parentId as string | null) ?? null;
    }
  }
  const running = tasks.filter((t) => t.status === "running").slice(-1)[0];
  const active: SessionState["active"] = {
    leafId,
    task: running?.task,
    startedAt: running?.startedAt,
    msSinceStart: running?.startedAt ? Date.now() - Date.parse(running.startedAt) : undefined,
    nodesSinceFold,
  };

  return { file: opts.file, leafId, entryCount: entries.length, tasks, folds, active };
}
