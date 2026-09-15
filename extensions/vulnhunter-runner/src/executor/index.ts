/**
 * 执行器（Executor）——生产者-消费者并发的底层基础设施（fish 09-15 定稿）。
 *
 * 三层模型：
 *   容量（Capacity）：命名许可池 × k。外部供给、真闸门；"model" 是发动机角色（N=系统并行度）。
 *   池（Pool）      ：需求组织。workflow 声明（部分可调），限流防灌满。
 *   调度门（Gate）  ：容量拥塞时授让——下游优先（priority 小者先）+ 同级 FIFO + 老化提升。
 *
 * 三条不变量：
 *   ① 没有任何模型消费绕过容量门（业务提交/嵌套加需都走这里；串行控制流也应包一层）；
 *   ② 释放保证：成功/失败/中止一律释放（finally 语义）；
 *   ③ 等待关系严格单向嵌套（资源 ⊂ 池任务 ⊂ 容量），无环 → 任意 N≥1 都不卡死。
 *
 * 与业务/会话无耦合：本模块不认识"会话、提示词、漏洞"，只认识 容量/池/任务/队列。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CapacityPool, type Permit } from "./capacity.ts";
import { Pool } from "./pool.ts";
import { MemoryQueue } from "./queue.ts";
import { Registry } from "./registry.ts";
import type {
  AcquireOptions,
  CapacityOptions,
  CapacityStats,
  ExecEvent,
  PoolOptions,
  PoolStats,
  Priority,
  QueueBackend,
  QueueStats,
  ServeOptions,
  Stats,
  SubmitOptions,
} from "./types.ts";

export type { QueueItem, QueueBackend, ServeOptions, SubmitOptions, AcquireOptions, CapacityOptions, PoolOptions, ExecEvent, Stats } from "./types.ts";
export { MemoryQueue } from "./queue.ts";
export { FileQueue, type FileQueueOptions } from "./file-queue.ts";
export { CapacityPool } from "./capacity.ts";
export { Pool } from "./pool.ts";

export class TaskTimeoutError extends Error {
  constructor(ms: number) {
    super(`任务超时（${ms}ms）`);
    this.name = "TaskTimeoutError";
  }
}

export interface PoolHandle {
  readonly name: string;
  /** 提交一个任务：走 准入 → 容量门 → 执行 → 释放。fn 收到合并后的 AbortSignal */
  submit<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: SubmitOptions): Promise<T>;
  setConcurrency(n: number): void;
}

export interface QueueHandle<T = unknown> {
  readonly name: string;
  readonly backend: QueueBackend<T>;
}

export interface Executor {
  /** 绑定/调整容量（外部供给；模型凭证能力、沙箱机位数……） */
  bindCapacity(name: string, opts: CapacityOptions): void;
  /** 声明池（需求组织；同名幂等返回已有句柄） */
  declarePool(name: string, opts: PoolOptions): PoolHandle;
  /** 声明队列（缺省内存后端） */
  declareQueue<T = unknown>(name: string, opts?: { backend?: QueueBackend<T> }): QueueHandle<T>;
  /** 嵌套加需：只取"当前任务未持有"的容量，跑完只放新增（已持继承不重入） */
  acquire<T>(reqs: Record<string, number>, fn: (signal: AbortSignal) => Promise<T>, opts?: AcquireOptions): Promise<T>;
  /** 队列驱动：泵自动 claim → submit → ack/requeue，抽干为止 */
  serve<T = unknown>(opts: ServeOptions<T>): Promise<void>;
  stats(): Stats;
  events(): ExecEvent[];
  on(fn: (e: ExecEvent) => void): () => void;
}

function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  outerSignal: AbortSignal | undefined,
): Promise<T> {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(new TaskTimeoutError(timeoutMs)), timeoutMs);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () =>
      finish(() => reject(ctrl.signal.reason ?? Object.assign(new Error("任务被中止"), { name: "AbortError" })));
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
      ctrl.signal.removeEventListener("abort", onAbort);
      act();
    };
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      fn(ctrl.signal).then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    } catch (e) {
      finish(() => reject(e));
    }
  });
}

class ExecutorImpl implements Executor {
  private capacities = new Map<string, CapacityPool>();
  private pools = new Map<string, Pool>();
  private queues = new Map<string, QueueBackend<unknown>>();
  private registry = new Registry();
  private holds = new AsyncLocalStorage<Map<string, number>>();
  private seq = 0;

  private nextTag(): string { return `#${++this.seq}`; }

  bindCapacity(name: string, opts: CapacityOptions): void {
    const existing = this.capacities.get(name);
    if (existing) {
      existing.setPermits(opts.permits);
      if (opts.agingMs !== undefined) existing.agingMs = opts.agingMs;
      return;
    }
    this.capacities.set(name, new CapacityPool(name, opts, (e) => this.registry.emit(e)));
  }

  declarePool(name: string, opts: PoolOptions): PoolHandle {
    let pool = this.pools.get(name);
    if (!pool) {
      pool = new Pool(name, opts);
      this.pools.set(name, pool);
    }
    const self = this;
    return {
      name,
      submit: (fn, submitOpts) => self.submitVia(pool!, fn, submitOpts),
      setConcurrency: (n) => pool!.setConcurrency(n),
    };
  }

  declareQueue<T>(name: string, opts?: { backend?: QueueBackend<T> }): QueueHandle<T> {
    let backend = this.queues.get(name) as QueueBackend<T> | undefined;
    if (!backend) {
      backend = opts?.backend ?? (new MemoryQueue<T>() as QueueBackend<T>);
      this.queues.set(name, backend as QueueBackend<unknown>);
    }
    return { name, backend };
  }

  async acquire<T>(reqs: Record<string, number>, fn: (signal: AbortSignal) => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
    const tag = opts.tag ?? this.nextTag();
    const prep = await this.prepare(new Map(Object.entries(reqs)), tag, opts.priority ?? 50, opts.signal);
    try {
      return await this.holds.run(prep.held, () => runWithTimeout(fn, opts.timeoutMs, opts.signal));
    } finally {
      prep.release();
    }
  }

  async serve<T>(opts: ServeOptions<T>): Promise<void> {
    const queue = this.queues.get(opts.queue);
    if (!queue) throw new Error(`未声明队列：${opts.queue}`);
    const pool = this.pools.get(opts.pool);
    if (!pool) throw new Error(`未声明池：${opts.pool}`);
    const pumps = Math.max(1, opts.pumps ?? pool.concurrency);
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < pumps; i++) workers.push(this.pumpLoop(queue as QueueBackend<T>, opts));
    await Promise.all(workers);
  }

  private async pumpLoop<T>(queue: QueueBackend<T>, opts: ServeOptions<T>): Promise<void> {
    for (;;) {
      const item = queue.claim();
      if (!item) return;
      this.registry.emit({ ts: Date.now(), type: "queue.claim", queue: opts.queue, id: item.id, attempts: item.attempts });
      try {
        const result = await this.submitVia(this.pools.get(opts.pool)!, (signal) => opts.consumer(item, signal), { tag: item.id });
        queue.ack(item, result);
        this.registry.emit({ ts: Date.now(), type: "queue.ack", queue: opts.queue, id: item.id });
      } catch (e) {
        let drop = false;
        try { drop = (await opts.onError?.(item, e)) === "drop"; } catch { /* 回调失败不改变处置 */ }
        if (drop) {
          queue.ack(item, { failed: true });
          this.registry.emit({ ts: Date.now(), type: "queue.drop", queue: opts.queue, id: item.id });
        } else {
          queue.requeue(item);
          this.registry.emit({ ts: Date.now(), type: "queue.requeue", queue: opts.queue, id: item.id, attempts: item.attempts });
        }
      }
    }
  }

  private async submitVia<T>(pool: Pool, fn: (signal: AbortSignal) => Promise<T>, opts: SubmitOptions = {}): Promise<T> {
    const tag = opts.tag ?? this.nextTag();
    await pool.admit(tag, opts.signal);
    this.registry.emit({ ts: Date.now(), type: "task.start", pool: pool.name, tag });
    const t0 = Date.now();
    let failed = false;
    try {
      const needs = opts.needs ?? pool.needs;
      const reqs = new Map<string, number>();
      for (const name of needs) reqs.set(name, (reqs.get(name) ?? 0) + 1);
      const prep = await this.prepare(reqs, tag, pool.priority, opts.signal);
      try {
        return await this.holds.run(prep.held, () => runWithTimeout(fn, opts.timeoutMs, opts.signal));
      } finally {
        prep.release();
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      pool.release(tag, failed);
      this.registry.emit({ ts: Date.now(), type: "task.end", pool: pool.name, tag, status: failed ? "failed" : "done", ms: Date.now() - t0 });
    }
  }

  /** 取"当前上下文未持有"的容量；返回新的持有集合与释放函数 */
  private async prepare(
    reqs: Map<string, number>,
    tag: string,
    priority: Priority,
    signal?: AbortSignal,
  ): Promise<{ held: Map<string, number>; release: () => void }> {
    const prev = this.holds.getStore() ?? new Map<string, number>();
    const held = new Map(prev);
    const acquired: Permit[] = [];
    try {
      // 全局固定获取顺序 = 容量声明顺序（防死锁的一致性保证）
      for (const [name, cap] of this.capacities) {
        const want = reqs.get(name) ?? 0;
        const have = held.get(name) ?? 0;
        if (want > have) {
          for (let i = have; i < want; i++) acquired.push(await cap.acquire(tag, priority, signal));
          held.set(name, want);
        }
      }
    } catch (e) {
      for (const p of acquired) p.release();
      throw e;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const p of acquired) p.release();
    };
    return { held, release };
  }

  stats(): Stats {
    const capacities: CapacityStats[] = [...this.capacities.values()].map((c) => ({
      name: c.name, permits: c.total, held: c.heldList, waiting: c.waitingList,
    }));
    const pools: PoolStats[] = [...this.pools.values()].map((p) => ({
      name: p.name, concurrency: p.concurrency, locked: p.locked, priority: p.priority,
      running: p.runningList, waiting: p.waitingCount, completed: p.completed, failed: p.failed,
    }));
    const queues: QueueStats[] = [...this.queues.entries()].map(([name, q]) => ({
      name, size: q.size(), inflight: q.inflight(),
    }));
    return { capacities, pools, queues };
  }

  events(): ExecEvent[] { return this.registry.list(); }
  on(fn: (e: ExecEvent) => void): () => void { return this.registry.on(fn); }
}

export function createExecutor(): Executor {
  return new ExecutorImpl();
}
