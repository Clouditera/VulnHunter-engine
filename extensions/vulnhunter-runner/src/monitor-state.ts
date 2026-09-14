/**
 * 监控台数据源：runner 运行态注册表（进程内单例）。
 * workflow/runtime 写入，TUI 监控台 / web 服务读取。同进程，零 IPC。
 */

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

export interface PoolInfo {
  name: string;
  max: number;
  active: Map<string, number>;  // label → 开始时间戳
  queued: number;
}

export interface RunInfo {
  runId: string;
  workflow: string;
  workdir: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error";
  note?: string;
}

const running = new Map<string, RunningNode>();
const events: MonitorEvent[] = [];
const pools = new Map<string, PoolInfo>();
const runs = new Map<string, RunInfo>();
const MAX_EVENTS = 200;
const MAX_RUNS = 100;

export const monitorState = {
  running,
  events,
  pools,
  runs,
  nodeStart(id: string, n: RunningNode) { running.set(id, n); },
  nodeSession(id: string, sessionFile: string) { const n = running.get(id); if (n) n.sessionFile = sessionFile; },
  nodeEnd(id: string) { running.delete(id); },
  log(msg: string) {
    events.push({ ts: Date.now(), msg });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  },

  poolRegister(name: string, max: number) { if (!pools.has(name)) pools.set(name, { name, max, active: new Map(), queued: 0 }); },
  poolAcquire(name: string, label: string) {
    const p = pools.get(name);
    if (p) p.active.set(label, Date.now());
  },
  poolRelease(name: string, label: string) {
    const p = pools.get(name);
    if (p) p.active.delete(label);
  },
  poolQueue(name: string, n: number) { const p = pools.get(name); if (p) p.queued = n; },

  runStart(info: RunInfo) {
    const key = `${info.workdir}::${info.runId}`;
    runs.set(key, info);
    // 超限修剪：先删已结束的最老 run
    if (runs.size > MAX_RUNS) {
      const done = [...runs.entries()].filter(([, r]) => r.status !== "running").sort((a, b) => a[1].startedAt - b[1].startedAt);
      for (const [k] of done.slice(0, runs.size - MAX_RUNS)) runs.delete(k);
    }
  },
  runEnd(workdir: string, runId: string, status: "done" | "error", note?: string) {
    const r = runs.get(`${workdir}::${runId}`);
    if (r) { r.status = status; r.endedAt = Date.now(); if (note) r.note = note; }
  },
};
