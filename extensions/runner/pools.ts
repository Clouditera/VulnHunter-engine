/**
 * Pool：并发池抽象（fish 09-05 裁定）。
 *
 * 池只是调度器（资源配额分组），任务上下文在会话文件里：
 *   - verifyPool：无沙箱依赖，默认高并发；
 *   - sandboxPool：默认 1（串行），poc-verify/ev-assess/exp-build 用。
 *
 * 用法：const pool = new Pool("verify", 5); await pool.run(() => 任务());
 */

export class Pool {
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(
    public readonly name: string,
    public readonly maxConcurrent: number,
  ) {}

  get active(): number { return this.running; }
  get queued(): number { return this.waiters.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  /** 等待池内所有在途任务完成（不等待队列外未提交的） */
  async drain(tasks: Promise<unknown>[]): Promise<void> {
    await Promise.allSettled(tasks);
  }
}
