/**
 * sandbox 工具 —— 动态执行环境（沙箱）状态：build 实测后 / 动态链探到不可达时上报；get 查询。
 * 存储：system/sandbox.json（工具独占）。读侧 fail-closed：缺失/损坏 → unknown（调度侧据此阻断动态链）。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { atomicWriteJSON, err, ok, paths, readJSON, rejectUnknown, type WsContext } from "./common.ts";
import { lineage } from "../ledger.ts";

export interface SandboxState {
  status: "available" | "unavailable";
  note: string;
  updatedAt: string;
  reporter: string;
}

export type SandboxRead = SandboxState | { status: "unknown"; note: string; updatedAt: ""; reporter: "" };

/** 读侧单一入口（引擎/调度与工具共用） */
export function readSandboxState(workdir: string): SandboxRead {
  const rec = readJSON<SandboxState>(paths.sandbox(workdir));
  if (rec && (rec.status === "available" || rec.status === "unavailable")) return rec;
  return { status: "unknown", note: "沙箱状态未记录（build 尚未实测上报）", updatedAt: "", reporter: "" };
}

export function makeSandboxTool(ws: WsContext, agentName?: string): ToolDefinition {
  return defineTool({
    name: "sandbox",
    label: "Sandbox",
    description:
      "动态执行环境（沙箱）状态。op：report（如实上报实测结论：build 验证后、动态链/ev 探到不可达时）/ get（查询当前状态）。" +
      "状态由工具落盘（system/sandbox.json），勿手改存储文件。",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "report / get" })),
      status: Type.Optional(Type.Union([Type.Literal("available"), Type.Literal("unavailable")], { description: "report 用：沙箱可用性" })),
      note: Type.Optional(Type.String({ description: "备注：探测方式 / 失败原因" })),
    }),
    async execute(_id, params) {
      const bad = rejectUnknown(params as Record<string, unknown>, ["op", "status", "note"]);
      if (bad) return err(bad);
      const op = String(params.op ?? "");

      if (op === "get") {
        const st = readSandboxState(ws.workdir);
        if (st.status === "unknown") return ok(`sandbox 状态：unknown（${st.note}）`);
        return ok(`sandbox 状态：${st.status}（${st.note || "无备注"}）updated=${st.updatedAt} reporter=${st.reporter || "-"}`);
      }

      if (op === "report") {
        if (params.status !== "available" && params.status !== "unavailable") {
          return err(`report 需要 status=available|unavailable。示例：sandbox({op:"report", status:"available", note:"ssh 连通，gcc 12.2 可用"})`);
        }
        const rec: SandboxState = {
          status: params.status,
          note: String(params.note ?? ""),
          updatedAt: new Date().toISOString(),
          reporter: agentName ?? "",
        };
        atomicWriteJSON(paths.sandbox(ws.workdir), rec);
        lineage(ws.workdir, { action: "sandbox.report", status: rec.status, note: rec.note, reporter: rec.reporter });
        return ok(`已记录沙箱状态：${rec.status}（system/sandbox.json）。`);
      }

      return err(`sandbox 支持 op：report / get。收到 op=${op || "（空）"}。示例：sandbox({op:"get"})`);
    },
  });
}
