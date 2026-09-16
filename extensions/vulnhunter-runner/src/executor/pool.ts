/**
 * 池（Pool）= 需求组织。workflow 声明，部分可调。
 *
 * 职责只有两件：
 *   ① 准入：池并发上限内放行，超限排队（防单池灌满容量门）；
 *   ② 记录：在跑/排队计数与标签（观测用）。
 * 池不供给资源、不做授让——那是容量门的事。
 */

import type { PoolOptions, Priority } from "./types.ts";

interface AdmitWaiter {
  resolve: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Pool {
  readonly name: string;
  private limit: number;
  readonly locked: boolean;
  readonly priority: Priority;
  readonly needs: string[];

  private active = 0;
  private activeTags = new Map<string, number>(); // tag → 开始时间
  private waiters: AdmitWaiter[] = [];
  completed = 0;
  failed = 0;

  constructor(name: string, opts: PoolOptions) {
    this.name = name;
    this.limit = Math.max(1, Math.floor(opts.concurrency));
    this.locked = !!opts.locked;
    this.priority = opts.priority ?? 50;
    this.needs = opts.needs ?? [];
  }

  get concurrency(): number { return this.limit; }
  get runningCount(): number { return this.active; }
  get waitingCount(): number { return this.waiters.length; }
  get runningList(): Array<{ tag: string; since: number }> {
    return [...this.activeTags.entries()].map(([tag, since]) => ({ tag, since }));
  }

  /** 并发上限调整；locked 池拒绝调整 */
  setConcurrency(n: number): void {
    if (this.locked) throw new Error(`池 ${this.name} 并发已锁死，不可调整`);
    this.limit = Math.max(1, Math.floor(n));
    this.pump();
  }

  /** 准入：拿到名额返回；超限排队等待（可 abort 摘除） */
  admit(tag: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("准入被中止"), { name: "AbortError" }));
    if (this.active < this.limit) {
      this.active++;
      this.activeTags.set(tag, Date.now());
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: AdmitWaiter = {
        resolve: () => {
          this.active++;
          this.activeTags.set(tag, Date.now());
          resolve();
        },
        signal,
      };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) { this.waiters.splice(i, 1); reject(Object.assign(new Error("准入被中止"), { name: "AbortError" })); }
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  /** 结束名额：释放并放行下一个等待者 */
  release(tag: string, failed: boolean): void {
    this.activeTags.delete(tag);
    this.active--;
    if (failed) this.failed++; else this.completed++;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.onAbort && w.signal) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve();
    }
  }
}
