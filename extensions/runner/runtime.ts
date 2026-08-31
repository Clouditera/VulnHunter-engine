/**
 * Runner 运行时：节点会话与 workflow 原语（M2 版）。
 *
 * 节点 = 进程内 SDK 会话（createAgentSession）：
 *   systemPrompt  = agents/<name>.md（任务书，纯散文）
 *   appendSystemPrompt = AGENTS.md（共享基底）
 *   tools         = NodeSpec.tools 白名单
 *   customTools   = NodeSpec.fns 经 makeNodeTools 注入（线别/继承链由 binding 绑死）
 *   extensions    = NodeSpec.extensions（其余一律不挂）
 *   skills        = NodeSpec.skills 过滤
 */

import {
  createAgentSession, DefaultResourceLoader, SettingsManager, parseFrontmatter,
  type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODES, type NodeSpec } from "./nodes.ts";
import { makeNodeTools, type FnBinding, type WsContext } from "./workspace-tools.ts";

export interface NodeOptions {
  /** 任务正文（user message） */
  task: string;
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

/** 读 agents/<name>.md 正文（兼容残留 frontmatter，剥掉） */
function loadTaskBook(engineDir: string, name: string): string {
  const raw = readFileSync(join(engineDir, "agents", `${name}.md`), "utf-8");
  return parseFrontmatter<Record<string, unknown>>(raw).body.trim();
}

export async function runNode(ctx: WorkflowContext, agentName: string, opts: NodeOptions): Promise<NodeResult> {
  const spec: NodeSpec | undefined = NODES[agentName];
  if (!spec) throw new Error(`未知节点: ${agentName}（nodes.ts 未定义）`);

  const taskBook = loadTaskBook(ctx.engineDir, agentName);
  const agentsBase = readFileSync(join(ctx.engineDir, "AGENTS.md"), "utf-8");

  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    settingsManager: SettingsManager.create(ctx.cwd, ctx.engineDir),
    systemPrompt: taskBook,
    appendSystemPrompt: [agentsBase],
    noExtensions: true,   // 白名单制：只挂 NodeSpec 声明的扩展
    additionalExtensionPaths: (spec.extensions ?? []).map((n) => join(ctx.engineDir, "extensions", n)),
    skillsOverride: spec.skills
      ? (base) => ({ skills: base.skills.filter((s) => spec.skills!.includes(s.name)), diagnostics: base.diagnostics })
      : (base) => ({ skills: [], diagnostics: base.diagnostics }),
  });
  await resourceLoader.reload();

  const ws: WsContext = { workdir: ctx.workdir, cwd: ctx.cwd };
  const customTools = makeNodeTools(ws, spec.fns, opts.binding ?? {});

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    resourceLoader,
    tools: spec.tools,
    customTools,
  });

  let output = "";
  const sess: AgentSession = session;
  sess.subscribe((ev: AgentSessionEvent) => {
    if (ev.type === "message_end" && (ev as any).message?.role === "assistant") {
      const text = (ev as any).message.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) output = text;
    }
  });

  const timeout = opts.timeoutMs ?? spec.timeoutMs;
  const timer = setTimeout(() => { void sess.abort?.(); }, timeout);
  let aborted = false;
  try {
    await sess.prompt(opts.task);
    await sess.waitForIdle();
  } catch (e) {
    aborted = true;
    output += `\n[runner] 节点异常中止: ${String(e)}`;
  } finally {
    clearTimeout(timer);
  }
  // TODO M3: session shutdown/资源释放 API 确认后补上
  return { agent: agentName, output, aborted };
}
