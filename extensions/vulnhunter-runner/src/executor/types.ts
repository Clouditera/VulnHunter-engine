/**
 * 执行器公共类型（fish 09-15 定稿架构）。
 *
 * 三层模型：
 *   容量（Capacity）= 命名许可池——外部供给，真闸门（"model" 即发动机角色，N=系统并行度）；
 *   池（Pool）      = 需求组织——workflow 声明，部分可调，只限流不供给；
 *   调度门（Gate）  = 容量拥塞时的授让：下游优先（priority 越小越优先）+ 同级 FIFO + 老化。
 *
 * 与业务无耦合；会话管理是另一套基础设施，不在这里。
 */

/** 数字越小=越下游=越优先；缺省 50 */
export type Priority = number;

export interface CapacityOptions {
  /** 许可数（模型凭证能力 / 沙箱机位数……由外部供给决定） */
  permits: number;
  /** 老化阈值：等待超过此毫秒数视同最高优先级（默认 15 分钟） */
  agingMs?: number;
}

export interface PoolOptions {
  /** 池并发上限（需求组织，部分可调） */
  concurrency: number;
  /** 锁死：并发不可调整（如 hunt 锁 1） */
  locked?: boolean;
  /** 本池任务的默认优先级（越小越下游越优先） */
  priority?: Priority;
  /** 本池任务的默认容量需求（每项 1 个许可），如 ["model"] */
  needs?: string[];
}

export interface SubmitOptions {
  tag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 覆盖池默认容量需求 */
  needs?: string[];
}

export interface AcquireOptions {
  tag?: string;
  priority?: Priority;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface QueueItem<T = unknown> {
  /** 件身份（文件后端=文件名） */
  id: string;
  payload: T;
  /** 已尝试次数（≥1；重派后递增） */
  attempts: number;
}

export interface QueueBackend<T = unknown> {
  /** 取一件（同步）；空返回 null */
  claim(): QueueItem<T> | null;
  /** 成功归档 */
  ack(item: QueueItem<T>, result?: unknown): void;
  /** 失败退回（可重派） */
  requeue(item: QueueItem<T>): void;
  /** 待处理件数 */
  size(): number;
  /** 在途件数 */
  inflight(): number;
  /** 崩溃恢复（可选）：在途退回待处理 */
  recover?(): void;
}

export interface ServeOptions<T = unknown> {
  queue: string;
  pool: string;
  consumer: (item: QueueItem<T>, signal: AbortSignal) => Promise<unknown>;
  /** 失败回调；返回 "drop" 则归档为失败不再重派（缺省：退回队列） */
  onError?: (item: QueueItem<T>, error: unknown) => "drop" | void | Promise<"drop" | void>;
  /** 泵数（缺省=池并发上限） */
  pumps?: number;
}

export interface ExecEvent {
  ts: number;
  type: string;
  [k: string]: unknown;
}

export interface CapacityStats {
  name: string;
  permits: number;
  held: Array<{ tag: string; since: number }>;
  waiting: Array<{ tag: string; priority: Priority; waitedMs: number }>;
}

export interface PoolStats {
  name: string;
  concurrency: number;
  locked: boolean;
  priority: Priority;
  running: Array<{ tag: string; since: number }>;
  waiting: number;
  completed: number;
  failed: number;
}

export interface QueueStats {
  name: string;
  size: number;
  inflight: number;
}

export interface Stats {
  capacities: CapacityStats[];
  pools: PoolStats[];
  queues: QueueStats[];
}
