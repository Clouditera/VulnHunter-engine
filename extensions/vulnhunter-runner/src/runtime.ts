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
  description?: string;
  run(ctx: WorkflowContext, opts?: { runId?: string; from?: string; only?: string }): Promise<void>;
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

// ---------------------------------------------------------------------------
// 阶段化 workflow（fish 09-09：会话+标记=可寻址断点，自由选择节点开启任务，内化进架构）
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StageDef {
  name: string;
  run(sctx: StageCtx): Promise<void>;
}

export interface StagedWorkflow {
  name: string;
  description: string;
  stages(wfCtx: WorkflowContext): StageDef[];   // 阶段表可按参数生成（如轮数）
}

export function defineStagedWorkflow(w: StagedWorkflow): StagedWorkflow { return w; }

export interface RunState {
  workflow: string;
  runId: string;
  stages: Record<string, "pending" | "done" | "failed" | "skipped">;
  /** 角色 → 会话文件路径（阶段间复活用） */
  sessions: Record<string, string>;
  /** workflow 自定义进度数据 */
  data: Record<string, unknown>;
}

export interface StageCtx extends WorkflowContext {
  state: RunState;
  save(): void;
  /** 按角色开/复活会话（有文件则复活，否则新建并登记） */
  openSession(role: string, agent: string, opts?: { binding?: FnBinding; fresh?: boolean }): Promise<import("./session.ts").SessionHandle>;
}

/** 跑阶段化 workflow；from=断点续跑，only=单步重试 */
export async function runStages(wf: StagedWorkflow, ctx: WorkflowContext, opts: { runId?: string; from?: string; only?: string } = {}): Promise<void> {
  const runId = opts.runId ?? `${Date.now()}`;
  const runsDir = join(ctx.workdir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const statePath = join(runsDir, `${wf.name}-${runId}.json`);

  let state: RunState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf-8"));
  } else {
    state = { workflow: wf.name, runId, stages: {}, sessions: {}, data: {} };
  }
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  const sctx: StageCtx = {
    ...ctx, state, save,
    async openSession(role, agent, o = {}) {
      const file = state.sessions[role];
      const h = await startSession(ctx, !o.fresh && file && existsSync(file)
        ? { agent, id: role, sessionFile: file, binding: o.binding }
        : { agent, id: role, binding: o.binding });
      const f = h.sessionFile?.();
      if (f) { state.sessions[role] = f; save(); }
      return h;
    },
  };

  const stages = wf.stages(ctx);
  for (const st of stages) if (!(st.name in state.stages)) state.stages[st.name] = "pending";
  save();

  let active = !opts.from && !opts.only;
  for (const st of stages) {
    if (opts.only && st.name !== opts.only) continue;
    if (!active && st.name === opts.from) active = true;
    if (!active) continue;
    if (!opts.only && state.stages[st.name] === "done") continue;   // 断点续跑跳过已完成
    ctx.report(`—— 阶段 ${st.name} ——`);
    try {
      await st.run(sctx);
      state.stages[st.name] = "done"; save();
    } catch (e) {
      state.stages[st.name] = "failed"; save();
      ctx.report(`阶段 ${st.name} 失败：${String(e).slice(0, 200)}（修复后可 --from ${st.name} 续跑）`);
      throw e;
    }
  }
  ctx.report(`workflow ${wf.name}（runId=${runId}）执行完毕`);
}
