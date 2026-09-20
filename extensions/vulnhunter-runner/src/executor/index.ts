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
 * 与业务/会话无耦合：本模块不认识"会话、提示词、漏洞"，只认识 容量/池/任务（队列子系统已随旧物料模型退役，fish 09-20）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { CapacityPool, type Permit } from "./capacity.ts";
import { Pool } from "./pool.ts";
import { Registry } from "./registry.ts";
import type {
  AcquireOptions,
  CapacityOptions,
  CapacityStats,
  ExecEvent,
  PoolOptions,
  PoolStats,
  Priority,
  Stats,
  SubmitOptions,
} from "./types.ts";

export type { SubmitOptions, AcquireOptions, CapacityOptions, PoolOptions, ExecEvent, Stats } from "./types.ts";
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

export interface Executor {
  /** 绑定/调整容量（外部供给；模型凭证能力、沙箱机位数……） */
  bindCapacity(name: string, opts: CapacityOptions): void;
  /** 声明池（需求组织；同名幂等返回已有句柄） */
  declarePool(name: string, opts: PoolOptions): PoolHandle;
  /** 嵌套加需：只取"当前任务未持有"的容量，跑完只放新增（已持继承不重入） */
  acquire<T>(reqs: Record<string, number>, fn: (signal: AbortSignal) => Promise<T>, opts?: AcquireOptions): Promise<T>;
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

  async acquire<T>(reqs: Record<string, number>, fn: (signal: AbortSignal) => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
    const tag = opts.tag ?? this.nextTag();
    const prep = await this.prepare(new Map(Object.entries(reqs)), tag, opts.priority ?? 50, opts.signal);
    try {
      return await this.holds.run(prep.held, () => runWithTimeout(fn, opts.timeoutMs, opts.signal));
    } finally {
      prep.release();
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
    return { capacities, pools };
  }

  events(): ExecEvent[] { return this.registry.list(); }
  on(fn: (e: ExecEvent) => void): () => void { return this.registry.on(fn); }
}

export function createExecutor(): Executor {
  return new ExecutorImpl();
}
