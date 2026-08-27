/**
 * Runner 运行时：节点会话与 workflow 原语。
 *
 * 节点 = 进程内 SDK 会话（pi-subagents 的替代）：
 *   createAgentSession + DefaultResourceLoader(systemPrompt=AGENTS.md+agents/<name>.md)
 *   tools 白名单来自节点 frontmatter；VULNFORGE_STAGE 经 env 注入进程环境
 *   （进程内会话共享 process.env——并发节点时 stage 变量会串，M2 前需要解决：
 *    方案 A 节点串行执行；方案 B output-contract 改从会话上下文读 stage）。
 */

import { createAgentSession, DefaultResourceLoader, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface NodeOptions {
  /** 任务正文（user message） */
  task: string;
  /** 覆盖工具白名单；缺省读 agents/<name>.md frontmatter 的 tools */
  tools?: string[];
  /** 超时（ms），默认 30 分钟 */
  timeoutMs?: number;
}

export interface NodeResult {
  agent: string;
  /** 节点最后一条 assistant 文本输出 */
  output: string;
  /** 是否因超时/取消结束 */
  aborted: boolean;
}

export interface WorkflowContext {
  /** 目标项目根（= pi 启动目录） */
  cwd: string;
  /** 引擎仓根（agentDir） */
  engineDir: string;
  /** 工作区根 <cwd>/.vulnforge */
  workdir: string;
  /** scan 启动参数（audit_scope / vuln_focus / sandbox_cfg / ...） */
  params: Record<string, string>;
  /** 起一个节点会话并等待完成 */
  node(agentName: string, opts: NodeOptions): Promise<NodeResult>;
  /** 向主会话报告进度（steer 消息） */
  report(message: string): void;
}

export interface Workflow {
  name: string;
  description: string;
  run(ctx: WorkflowContext): Promise<void>;
}

export function defineWorkflow(w: Workflow): Workflow {
  return w;
}

/** 读 agents/<name>.md：正文（去 frontmatter）+ frontmatter tools 白名单 */
function loadAgentSpec(engineDir: string, name: string): { body: string; tools?: string[] } {
  const raw = readFileSync(join(engineDir, "agents", `${name}.md`), "utf-8");
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const tools = typeof frontmatter.tools === "string"
    ? frontmatter.tools.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  return { body, tools };
}

export async function runNode(ctx: WorkflowContext, agentName: string, opts: NodeOptions): Promise<NodeResult> {
  const spec = loadAgentSpec(ctx.engineDir, agentName);
  const agentsBase = readFileSync(join(ctx.engineDir, "AGENTS.md"), "utf-8");
  // systemPromptMode: append 等价——节点任务书在前，AGENTS.md 作 project_context 基底拼接
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    settingsManager: SettingsManager.create(ctx.cwd, ctx.engineDir),
    systemPrompt: spec.body,                 // 节点任务书（systemPromptMode: append 的"任务"部分）
    appendSystemPrompt: [agentsBase],        // AGENTS.md 基底
  });
  await resourceLoader.reload();

  const prevStage = process.env.VULNFORGE_STAGE;
  process.env.VULNFORGE_STAGE = agentName;
  let session: AgentSession | undefined;
  try {
    ({ session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir: ctx.engineDir,
      resourceLoader,
      ...(spec.tools || opts.tools ? { tools: opts.tools ?? spec.tools } : {}),
    }));

    let output = "";
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30 * 60_000);
    session.subscribe((ev: AgentSessionEvent) => {
      // 收集 assistant 文本输出（终稿 = 最后一条完整文本）
      if (ev.type === "message_end" && (ev as any).message?.role === "assistant") {
        const text = (ev as any).message.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text) output = text;
      }
    });

    await session.prompt(opts.task);
    await session.waitForIdle();
    clearTimeout(timer);
    return { agent: agentName, output, aborted: abort.signal.aborted };
  } finally {
    if (prevStage === undefined) delete process.env.VULNFORGE_STAGE;
    else process.env.VULNFORGE_STAGE = prevStage;
    // TODO M2: session 资源释放（shutdown/dispose API 确认后补上）
  }
}
