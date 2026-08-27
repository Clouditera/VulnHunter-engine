/**
 * Runner 扩展入口：注册 scan / scan_status 工具，加载 workflows/ 目录。
 *
 * 主会话职责收敛为：对话确定方向 → mark_scope → scan 启动 workflow。
 * scan 后台执行，进度经 report() 以 steer 消息回主会话。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runNode, type Workflow, type WorkflowContext } from "./runtime.ts";

const ENGINE_DIR = process.env.PI_CODING_AGENT_DIR ?? resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = join(ENGINE_DIR, "workflows");

interface ScanState {
  status: "idle" | "running" | "done" | "error";
  workflow?: string;
  log: string[];
  error?: string;
}

export default function (pi: ExtensionAPI) {
  const state: ScanState = { status: "idle", log: [] };
  const workflows = new Map<string, Workflow>();

  async function loadWorkflows() {
    workflows.clear();
    for (const f of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".ts"))) {
      const mod = await import(pathToFileURL(join(WORKFLOWS_DIR, f)).href);
      const w: Workflow = mod.default;
      if (w?.name && typeof w.run === "function") workflows.set(w.name, w);
    }
  }

  pi.registerTool(defineTool({
    name: "scan",
    label: "Scan",
    description: "启动审计 workflow（后台执行）。参数为启动消息确定的任务参数。",
    parameters: Type.Object({
      workflow: Type.String({ description: `workflow 名称，可选值见 workflows/ 目录` }),
      params: Type.Record(Type.String(), Type.String(), { description: "audit_scope / vuln_focus / sandbox_cfg 等启动参数" }),
    }),
    async execute(_id, args, _signal) {
      await loadWorkflows();
      const w = workflows.get(args.workflow);
      if (!w) {
        return { content: [{ type: "text", text: `未知 workflow: ${args.workflow}；可用: ${[...workflows.keys()].join(", ")}` }], details: {}, isError: true };
      }
      if (state.status === "running") {
        return { content: [{ type: "text", text: `已有 workflow 在跑: ${state.workflow}（一会话一任务）` }], details: {}, isError: true };
      }
      state.status = "running"; state.workflow = w.name; state.log = []; state.error = undefined;

      const ctx: WorkflowContext = {
        cwd: process.cwd(),
        engineDir: ENGINE_DIR,
        workdir: join(process.cwd(), ".vulnforge"),
        params: args.params,
        node: (name, opts) => runNode(ctx, name, opts),
        report: (msg) => { state.log.push(msg); }, // TODO M2: steer 回主会话
      };

      // 后台执行，不阻塞工具返回
      w.run(ctx)
        .then(() => { state.status = "done"; state.log.push("workflow 完成"); })
        .catch((e) => { state.status = "error"; state.error = String(e); });

      return { content: [{ type: "text", text: `workflow ${w.name} 已启动（后台）。用 scan_status 查询进度。` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "scan_status",
    label: "Scan Status",
    description: "查询当前 workflow 执行状态与进度日志。",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], details: {} };
    },
  }));
}
