/**
 * 观测注册表：事件流 + 监听器（执行器内的唯一观测出口）。
 * 后续可桥接到 monitor-state / web 观察台；本模块保持零依赖。
 */

import type { ExecEvent } from "./types.ts";

const MAX_EVENTS = 500;

export class Registry {
  private events: ExecEvent[] = [];
  private listeners = new Set<(e: ExecEvent) => void>();

  emit(e: ExecEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const l of this.listeners) {
      try { l(e); } catch { /* 观测失败不影响执行 */ }
    }
  }

  list(): ExecEvent[] { return [...this.events]; }

  on(fn: (e: ExecEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
