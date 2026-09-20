/**
 * profiler 工具 —— 项目画像（语言/框架/入口/模块/构建）：update（分节深合并）/ get。
 * 存储：system/profiler.json（工具独占）。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { atomicWriteJSON, err, ok, paths, readJSON, rejectUnknown, type WsContext } from "./common.ts";
import { lineage } from "../ledger.ts";

export interface ProfilerModule { name: string; path: string; role: string }

export interface ProfilerRecord {
  language?: string[];
  frameworks?: string[];
  entrypoints?: string[];
  modules?: ProfilerModule[];
  build?: { system?: string; commands?: string };
  updatedAt?: string;
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    return out;
  }
  return b;
}

export function readProfiler(workdir: string): ProfilerRecord | null {
  return readJSON<ProfilerRecord>(paths.profiler(workdir));
}

export function updateProfiler(workdir: string, patch: ProfilerRecord): ProfilerRecord {
  const cur = readProfiler(workdir) ?? {};
  const out = deepMerge(cur, patch) as ProfilerRecord;
  out.updatedAt = new Date().toISOString();
  atomicWriteJSON(paths.profiler(workdir), out);
  return out;
}

const SECTIONS = ["language", "frameworks", "entrypoints", "modules", "build"] as const;

export function makeProfilerTool(ws: WsContext): ToolDefinition {
  return defineTool({
    name: "profiler",
    label: "Profiler",
    description:
      "项目画像（语言/框架/入口点/模块清单/构建方式）。op：update（每节一个参数，给值的节深合并更新，缺省不变，可分多次补齐）/ get。" +
      "存储 system/profiler.json（工具独占），勿手改。",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "update / get" })),
      language: Type.Optional(Type.Array(Type.String(), { description: "语言栈" })),
      frameworks: Type.Optional(Type.Array(Type.String(), { description: "框架/依赖" })),
      entrypoints: Type.Optional(Type.Array(Type.String(), { description: "入口点（文件/函数）" })),
      modules: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String(), role: Type.String() }), { description: "模块清单（名称/路径/职责）" })),
      build: Type.Optional(Type.Object({ system: Type.Optional(Type.String()), commands: Type.Optional(Type.String()) }, { description: "构建方式（系统/命令）" })),
    }),
    async execute(_id, params) {
      const bad = rejectUnknown(params as Record<string, unknown>, ["op", ...SECTIONS]);
      if (bad) return err(bad);
      const op = String(params.op ?? "");

      if (op === "get") {
        const rec = readProfiler(ws.workdir);
        if (!rec) return ok("profiler 尚未建立（onboard 会分节填充；存储 system/profiler.json）。");
        return ok(`--- system/profiler.json ---\n${JSON.stringify(rec, null, 2)}`);
      }

      if (op === "update") {
        const patch: Record<string, unknown> = {};
        for (const s of SECTIONS) if ((params as Record<string, unknown>)[s] !== undefined) patch[s] = (params as Record<string, unknown>)[s];
        if (!Object.keys(patch).length) {
          return err(`update 至少给一节：${SECTIONS.join(" / ")}。示例：profiler({op:"update", language:["C"], entrypoints:["src/main.c"]})`);
        }
        const out = updateProfiler(ws.workdir, patch as ProfilerRecord);
        lineage(ws.workdir, { action: "profiler.update", sections: Object.keys(patch) });
        return ok(`已更新 profiler：${Object.keys(patch).join(", ")}（system/profiler.json）。`);
      }

      return err(`profiler 支持 op：update / get。收到 op=${op || "（空）"}。`);
    },
  });
}
