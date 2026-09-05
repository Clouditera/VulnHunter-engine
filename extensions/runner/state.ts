/**
 * run-state：workflow 的持久账本（<workdir>/run-state.json）。
 * 中断重跑 = 读账本续跑。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RunState {
  onboard_done: boolean;
  research_done: boolean;
  counters: {
    cognize_run: number;   // 池 A 已起过的 cognize 运行数（C 线取号基数）
    research_run: number;  // S 线取号基数
  };
  /** 池 A 停工信号：连续零 ADV 产出的 cognize 轮数 */
  cognize_idle_rounds: number;
  /** 已失败过一次的文件（再失败即 stalled 归档） */
  stalled: string[];
  /** init-session 的会话文件路径（runInit 完成后记录，幂等复活用） */
  init_session_file?: string;
}

export function loadState(workdir: string): RunState {
  const p = join(workdir, "run-state.json");
  if (existsSync(p)) return { ...defaultState(), ...JSON.parse(readFileSync(p, "utf-8")) };
  return defaultState();
}

export function saveState(workdir: string, st: RunState): void {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "run-state.json"), JSON.stringify(st, null, 2));
}

function defaultState(): RunState {
  return {
    onboard_done: false,
    research_done: false,
    counters: { cognize_run: 0, research_run: 0 },
    cognize_idle_rounds: 0,
    stalled: [],
  };
}

/** 读 build.md 的 sandbox 状态（动态门禁依据） */
export function readSandboxState(workdir: string): "available" | "unavailable" | "unknown" {
  const p = join(workdir, "knowledge", "build", "build.md");
  if (!existsSync(p)) return "unknown";
  const m = readFileSync(p, "utf-8").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "unknown";
  const s = m[1].match(/sandbox:\s*(\S+)/);
  return s?.[1] === "available" ? "available" : s?.[1] === "unavailable" ? "unavailable" : "unknown";
}
