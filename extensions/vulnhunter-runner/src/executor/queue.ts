/**
 * 工作队列（Queue）= 生产者-消费者内容的载体。
 *
 * 语义四件：
 *   claim   原子取件（取走即标在途，防多消费者重复取）
 *   ack     成功归档
 *   requeue 失败退回（可重派；attempts 递增）
 *   recover 崩溃恢复（在途退回，可选）
 *
 * 本文件提供接口与内存实现；文件系统后端见 file-queue.ts。
 */

import type { QueueBackend, QueueItem } from "./types.ts";

/** 内存队列：测试与进程内瞬态流使用 */
export class MemoryQueue<T = unknown> implements QueueBackend<T> {
  private pending: Array<{ id: string; payload: T; attempts: number }> = [];
  private inFlight = new Set<string>();
  private seq = 0;

  constructor(initial: T[] = []) {
    for (const item of initial) this.enqueue(item);
  }

  enqueue(payload: T, id?: string): string {
    const itemId = id ?? `q${++this.seq}`;
    this.pending.push({ id: itemId, payload, attempts: 1 });
    return itemId;
  }

  claim(): QueueItem<T> | null {
    const entry = this.pending.shift();
    if (!entry) return null;
    this.inFlight.add(entry.id);
    return { id: entry.id, payload: entry.payload, attempts: entry.attempts };
  }

  ack(item: QueueItem<T>, _result?: unknown): void {
    this.inFlight.delete(item.id);
  }

  requeue(item: QueueItem<T>): void {
    this.inFlight.delete(item.id);
    this.pending.push({ id: item.id, payload: item.payload, attempts: item.attempts + 1 });
  }

  size(): number { return this.pending.length; }
  inflight(): number { return this.inFlight.size; }

  recover(): void {
    // 内存队列在途件没有可恢复的来源（进程内瞬态）；此处仅清空在途表
    this.inFlight.clear();
  }
}
