/**
 * Pool：并发池抽象（fish 09-05 裁定）。
 *
 * 池只是调度器（资源配额分组），任务上下文在会话文件里：
 *   - verifyPool：无沙箱依赖，默认高并发；
 *   - sandboxPool：默认 1（串行），poc-verify/ev-assess/exp-build 用。
 *
 * 用法：const pool = new Pool("verify", 5); await pool.run(() => 任务(), "任务标签");
 * 标签进监控注册表（web/TUI 可见池中在跑什么），可省。
 */

import { monitorState } from "./monitor-state.ts";

export class Pool {
  private running = 0;
  private waiters: (() => void)[] = [];
  private seq = 0;

  constructor(
    public readonly name: string,
    public readonly maxConcurrent: number,
  ) {
    monitorState.poolRegister(name, maxConcurrent);
  }

  get active(): number { return this.running; }
  get queued(): number { return this.waiters.length; }

  async run<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const tag = label ?? `#${++this.seq}`;
    if (this.running >= this.maxConcurrent) {
      monitorState.poolQueue(this.name, this.waiters.length + 1);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      monitorState.poolQueue(this.name, this.waiters.length);
    }
    this.running++;
    monitorState.poolAcquire(this.name, tag);
    try {
      return await fn();
    } finally {
      this.running--;
      monitorState.poolRelease(this.name, tag);
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  /** 等待池内所有在途任务完成（不等待队列外未提交的） */
  async drain(tasks: Promise<unknown>[]): Promise<void> {
    await Promise.allSettled(tasks);
  }
}
