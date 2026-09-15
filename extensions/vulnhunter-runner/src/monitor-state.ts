/**
 * 监控台数据源：runner 运行态注册表（进程内单例）。
 * workflow/runtime 写入，TUI 监控台 / web 服务读取。同进程，零 IPC。
 *
 * Run 注册表落盘（09-14 fish：观察台随 pi 会话常驻，新会话要能看到历史 run）：
 * runStart/runEnd/runStage 时全量写 ~/.vulnforge/web-runs.json；web 启动时 loadRuns 合并，
 * 上次进程留下 status=running 但 pid 已死的条目判为 error（宿主进程已退出）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Executor } from "./executor/index.ts";

export interface RunningNode {
  id: string;            // agent-startTs
  agent: string;
  target?: string;       // 队列文件名 / finding 编号
  startTs: number;
  sessionFile?: string;  // 节点 session jsonl 路径
  workdir?: string;      // .vulnforge 目录（所属 run）
  cwd?: string;          // 目标项目根
}

export interface MonitorEvent { ts: number; msg: string }

/** 当前进程接入的执行器（fish 09-15 接生产）：观察台/监控读 executor.stats()，删除旧 Pool 埋点 */
let activeExecutor: Executor | null = null;

export interface RunInfo {
  runId: string;
  workflow: string;
  workdir: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error";
  note?: string;
  sandbox?: boolean;   // 本 run 是否启用沙箱（sandbox_cfg 有无）——主页区分 sandbox 池“未启用/空闲”（09-14 designer）
  currentStage?: string;          // 阶段开始时写实（09-14 designer：--from/--only 下从 pending 猜不准）
  config?: Record<string, unknown>; // workflow 自报的解析后有效配置（默认值已落，前端不猜）
  pid?: number;         // 宿主进程 pid——注册表回放时判活
}

const running = new Map<string, RunningNode>();
const events: MonitorEvent[] = [];
const runs = new Map<string, RunInfo>();
const MAX_EVENTS = 200;
const MAX_RUNS = 100;

// ---- Run 注册表落盘 ----
const registryPath = () => process.env.VULNHUNTER_WEB_REGISTRY || join(homedir(), ".vulnforge", "web-runs.json");

function persistRuns(): void {
  try {
    const p = registryPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify([...runs.values()]));
  } catch { /* 尽力而为，不影响 workflow */ }
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** web 启动时回放历史 run；本进程已有条目优先。死进程的 running 条目判 error。 */
export function loadRuns(): void {
  try {
    const p = registryPath();
    if (!existsSync(p)) return;
    const list = JSON.parse(readFileSync(p, "utf-8")) as RunInfo[];
    for (const r of Array.isArray(list) ? list : []) {
      const key = `${r.workdir}::${r.runId}`;
      if (runs.has(key)) continue;
      if (r.status === "running" && !pidAlive(r.pid)) {
        r.status = "error";
        r.note = r.note || "宿主进程已退出（run 未完成）";
        r.endedAt = r.endedAt ?? r.startedAt;
      }
      runs.set(key, r);
    }
  } catch { /* 注册表损坏不致命 */ }
}

export const monitorState = {
  running,
  events,
  runs,
  nodeStart(id: string, n: RunningNode) { running.set(id, n); },
  nodeSession(id: string, sessionFile: string) { const n = running.get(id); if (n) n.sessionFile = sessionFile; },
  nodeEnd(id: string) { running.delete(id); },
  log(msg: string) {
    events.push({ ts: Date.now(), msg });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  },

  /** workflow 启动时接入执行器（容量/池/队列统计的唯一数据源） */
  attachExecutor(ex: Executor | null) { activeExecutor = ex; },
  getExecutor(): Executor | null { return activeExecutor; },

  runStart(info: RunInfo) {
    info.pid = process.pid;
    const key = `${info.workdir}::${info.runId}`;
    runs.set(key, info);
    // 超限修剪：先删已结束的最老 run
    if (runs.size > MAX_RUNS) {
      const done = [...runs.entries()].filter(([, r]) => r.status !== "running").sort((a, b) => a[1].startedAt - b[1].startedAt);
      for (const [k] of done.slice(0, runs.size - MAX_RUNS)) runs.delete(k);
    }
    persistRuns();
  },
  runEnd(workdir: string, runId: string, status: "done" | "error", note?: string) {
    const r = runs.get(`${workdir}::${runId}`);
    if (r) { r.status = status; r.endedAt = Date.now(); if (note) r.note = note; persistRuns(); }
  },
  runStage(workdir: string, runId: string, stage: string) {
    const r = runs.get(`${workdir}::${runId}`);
    if (r) { r.currentStage = stage; persistRuns(); }
  },
};
