/**
 * 文件系统工作队列（leads → todo → done 流转的通用化）。
 *
 *   claim   = pending 目录取一件（按名排序），rename 到 inflight
 *   ack     = inflight → archive
 *   requeue = inflight → pending（attempts 递增，进程内计数）
 *   recover = inflight 全部退回 pending（崩溃恢复；workflow 启动时调用）
 *
 * 件身份=文件名（天然唯一、天然幂等）；payload=文件名。
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { QueueBackend, QueueItem } from "./types.ts";

export interface FileQueueOptions {
  /** 待处理目录 */
  pending: string;
  /** 在途目录 */
  inflight: string;
  /** 归档目录 */
  archive: string;
  /** 件过滤（如只收 HYP-*.md） */
  filter?: (name: string) => boolean;
}

export class FileQueue implements QueueBackend<string> {
  private attempts = new Map<string, number>();
  private opts: FileQueueOptions;
  constructor(opts: FileQueueOptions) {
    this.opts = opts;
    for (const d of [opts.pending, opts.inflight, opts.archive]) mkdirSync(d, { recursive: true });
  }

  claim(): QueueItem<string> | null {
    const names = readdirSync(this.opts.pending).filter((f) => !this.opts.filter || this.opts.filter(f)).sort();
    if (names.length === 0) return null;
    const name = names[0];
    renameSync(join(this.opts.pending, name), join(this.opts.inflight, name));
    return { id: name, payload: name, attempts: this.attempts.get(name) ?? 1 };
  }

  ack(item: QueueItem<string>, _result?: unknown): void {
    const src = join(this.opts.inflight, item.id);
    if (existsSync(src)) renameSync(src, join(this.opts.archive, item.id));
    this.attempts.delete(item.id);
  }

  requeue(item: QueueItem<string>): void {
    const src = join(this.opts.inflight, item.id);
    if (existsSync(src)) renameSync(src, join(this.opts.pending, item.id));
    this.attempts.set(item.id, item.attempts + 1);
  }

  size(): number {
    return readdirSync(this.opts.pending).filter((f) => !this.opts.filter || this.opts.filter(f)).length;
  }

  inflight(): number { return readdirSync(this.opts.inflight).length; }

  recover(): void {
    for (const name of readdirSync(this.opts.inflight)) {
      renameSync(join(this.opts.inflight, name), join(this.opts.pending, name));
    }
  }
}
