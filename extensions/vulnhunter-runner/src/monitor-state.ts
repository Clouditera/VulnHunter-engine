/**
 * 监控台数据源：runner 运行态注册表（进程内单例）。
 * workflow/runtime 写入，TUI 监控台读取。同进程，零 IPC。
 */

export interface RunningNode {
  id: string;            // agent-startTs
  agent: string;
  target?: string;       // 队列文件名 / finding 编号
  startTs: number;
  sessionFile?: string;  // 节点 session jsonl 路径
}

export interface MonitorEvent { ts: number; msg: string }

const running = new Map<string, RunningNode>();
const events: MonitorEvent[] = [];
const MAX_EVENTS = 200;

export const monitorState = {
  running,
  events,
  nodeStart(id: string, n: RunningNode) { running.set(id, n); },
  nodeSession(id: string, sessionFile: string) { const n = running.get(id); if (n) n.sessionFile = sessionFile; },
  nodeEnd(id: string) { running.delete(id); },
  log(msg: string) {
    events.push({ ts: Date.now(), msg });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  },
};
