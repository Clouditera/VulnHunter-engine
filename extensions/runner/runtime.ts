/**
 * Runner 运行时：workflow 原语（v2——薄壳）。
 * 节点会话实现已迁 session.ts（SessionService：mark/compact/goto/fork 六动词）；
 * 这里保留 runNode 一次性会话薄壳与 WorkflowContext/defineWorkflow，兼容 audit.ts。
 */

import type { FnBinding } from "./workspace-tools.ts";
import { buildPrompt, startSession } from "./session.ts";

export interface NodeOptions {
  /** 任务说明句（"hunt 任务，沿审计链路精读并提出风险假设。"）——runNode 组装为「接下来开始执行 …」 */
  task: string;
  /** 附加行（如 todo 路径："审计链路：todo/ADV-C1-A2.md"） */
  extra?: string;
  /** 编号绑定上下文（hunt→advId / verify→hypId / cognize·research→runNo） */
  binding?: FnBinding;
  /** 覆盖默认超时 */
  timeoutMs?: number;
}

export interface NodeResult {
  agent: string;
  /** 节点最后一条 assistant 文本输出（仅作日志/进度，产物判定一律读文件） */
  output: string;
  aborted: boolean;
}

export interface WorkflowContext {
  cwd: string;
  engineDir: string;
  workdir: string;
  /** scan 启动参数（vuln_focus / sandbox_cfg / user_instr / output_lang / ...） */
  params: Record<string, string>;
  node(agentName: string, opts: NodeOptions): Promise<NodeResult>;
  report(message: string): void;
}

export interface Workflow {
  name: string;
  description: string;
  run(ctx: WorkflowContext): Promise<void>;
}

export function defineWorkflow(w: Workflow): Workflow { return w; }

export async function runNode(ctx: WorkflowContext, agentName: string, opts: NodeOptions): Promise<NodeResult> {
  // 一次性会话薄壳：start → prompt → close（多轮/分支/续跑场景请直接用 session.ts）
  const handle = await startSession(ctx, { agent: agentName, binding: opts.binding });
  let output = "";
  const r = await handle.prompt(buildPrompt(ctx, agentName, opts.task, opts.extra));
  handle.close();
  return { agent: agentName, output, aborted: r.aborted };
}
