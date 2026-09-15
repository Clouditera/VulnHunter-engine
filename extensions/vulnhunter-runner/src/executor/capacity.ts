/**
 * 容量（Capacity）= 命名许可池。外部供给，真闸门。
 *
 * 授让规则（Gate）：容量拥塞时按
 *   ① 下游优先：priority 越小越优先（同值比等待先后）
 *   ② 老化提升：等待超过 agingMs 视同最高优先级（防饿死）
 * 选出下一个被授让的等待者。
 *
 * 不变量：许可=在跑的凭证；释放保证（拿到就必须能还）；等待者可被 abort 摘除。
 */

import type { CapacityOptions, ExecEvent, Priority } from "./types.ts";

const DEFAULT_AGING_MS = 15 * 60_000;

export interface Permit {
  capacity: string;
  tag: string;
  grantedAt: number;
  release: () => void;
}

interface Waiter {
  tag: string;
  priority: Priority;
  enqueuedAt: number;
  resolve: (p: Permit) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const e = new Error("等待容量被中止");
  e.name = "AbortError";
  return e;
}

export class CapacityPool {
  readonly name: string;
  agingMs: number;
  private permits: number;
  private held = new Map<Permit, { tag: string; since: number }>();
  private waiters: Waiter[] = [];
  private emit: (e: ExecEvent) => void;

  constructor(name: string, opts: CapacityOptions, emit: (e: ExecEvent) => void) {
    this.name = name;
    this.permits = Math.max(0, Math.floor(opts.permits));
    this.agingMs = opts.agingMs ?? DEFAULT_AGING_MS;
    this.emit = emit;
  }

  get total(): number { return this.permits; }
  get heldCount(): number { return this.held.size; }
  get heldList(): Array<{ tag: string; since: number }> { return [...this.held.values()]; }
  get waitingList(): Array<{ tag: string; priority: Priority; waitedMs: number }> {
    const now = Date.now();
    return this.waiters.map((w) => ({ tag: w.tag, priority: w.priority, waitedMs: now - w.enqueuedAt }));
  }
  get waitingCount(): number { return this.waiters.length; }

  /** 扩容立即多授让；缩容等在跑的释放到新水位下 */
  setPermits(n: number): void {
    this.permits = Math.max(0, Math.floor(n));
    this.pump();
  }

  acquire(tag: string, priority: Priority, signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.held.size < this.permits) return Promise.resolve(this.grantTo(tag, 0));
    return new Promise<Permit>((resolve, reject) => {
      const w: Waiter = { tag, priority, enqueuedAt: Date.now(), resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) { this.waiters.splice(i, 1); reject(abortError()); }
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  private grantTo(tag: string, waitedMs: number): Permit {
    const permit: Permit = {
      capacity: this.name,
      tag,
      grantedAt: Date.now(),
      release: () => this.release(permit),
    };
    this.held.set(permit, { tag, since: permit.grantedAt });
    this.emit({ ts: Date.now(), type: "capacity.grant", capacity: this.name, tag, waitedMs });
    return permit;
  }

  private release(permit: Permit): void {
    if (!this.held.delete(permit)) return;
    this.pump();
  }

  /** 有富余许可则按 Gate 规则授让（老化在选取时实时计算） */
  private pump(): void {
    const now = Date.now();
    while (this.held.size < this.permits && this.waiters.length > 0) {
      let bestIdx = 0;
      let bestEff = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        const eff = now - w.enqueuedAt >= this.agingMs ? 0 : w.priority; // 老化=视同最高
        // eff 相同时，enqueuedAt 更早者优先（FIFO）
        if (eff < bestEff || (eff === bestEff && w.enqueuedAt < this.waiters[bestIdx].enqueuedAt)) {
          bestEff = eff;
          bestIdx = i;
        }
      }
      const w = this.waiters.splice(bestIdx, 1)[0];
      if (w.onAbort && w.signal) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve(this.grantTo(w.tag, Date.now() - w.enqueuedAt));
    }
  }
}
