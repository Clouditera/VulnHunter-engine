/**
 * Runner 运行时：节点会话与 workflow 原语（M2 版）。
 *
 * 节点 = 进程内 SDK 会话（createAgentSession）：
 *   systemPrompt  = pi 内置默认（保留）
 *   appendSystemPrompt = AGENTS.md（第一层）+ tasks/<name>.md（第二层）
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
import { getCoveragePaths, loadCoverageMap, aggregateCoverageEvents, persistCoverageMap, recordReadCoverageEvent } from "../code-coverage/coverage-core.ts";

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

/** 读 tasks/<name>.md 正文（兼容残留 frontmatter，剥掉） */
function loadTaskBook(engineDir: string, name: string): string {
  const raw = readFileSync(join(engineDir, "tasks", `${name}.md`), "utf-8");
  return parseFrontmatter<Record<string, unknown>>(raw).body.trim();
}

export async function runNode(ctx: WorkflowContext, agentName: string, opts: NodeOptions): Promise<NodeResult> {
  const spec: NodeSpec | undefined = NODES[agentName];
  if (!spec) throw new Error(`未知节点: ${agentName}（nodes.ts 未定义）`);

  const taskBook = loadTaskBook(ctx.engineDir, agentName);
  const agentsBase = readFileSync(join(ctx.engineDir, "AGENTS.md"), "utf-8");

  // system prompt 组装（fish 09-01 裁定）：保留 pi 内置默认，
  // append 第一层 AGENTS.md（系统通用规矩），第二层 tasks/<name>.md（节点任务书）
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    settingsManager: SettingsManager.create(ctx.cwd, ctx.engineDir),
    appendSystemPrompt: [agentsBase, taskBook],
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
    // tools 白名单对 customTools 同样生效（SDK isAllowedTool 不区分来源）：
    // 节点声明白名单时函数名必须并入；缺省时用 SDK 默认集（read/bash/edit/write+自定义/扩展工具）
    ...(spec.tools ? { tools: [...spec.tools, ...customTools.map((t) => t.name)] } : {}),
    customTools,
  });

  let output = "";
  const sess: AgentSession = session;
  // hunt 精读 = 审计覆盖率唯一统计口径（fish 08-31 裁定）：runner 直记，不经 env
  const cov = agentName === "hunt" ? getCoveragePaths(ctx.workdir) : undefined;
  sess.subscribe((ev: AgentSessionEvent) => {
    if (ev.type === "message_end" && (ev as any).message?.role === "assistant") {
      const text = (ev as any).message.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) output = text;
    }
    if (cov && ev.type === "tool_execution_end" && (ev as any).toolName === "read" && !(ev as any).isError) {
      recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: ctx.cwd, stage: "hunt", input: (ev as any).args });
    }
  });
  // fish 09-02 裁定：不设节点超时；pi 内部自带 API 重试（有上限），
  // 上限后注入恢复 prompt 继续——连续 3 次 pi 异常且恢复无效 = API 不可用，中止整个 workflow
  let aborted = false;
  let failures = 0;
  let pending = opts.task;
  for (;;) {
    try {
      await sess.prompt(pending);
      await sess.waitForIdle();
      break;
    } catch (e) {
      failures++;
      if (failures >= 3) {
        aborted = true;
        output += `\n[runner] 连续 ${failures} 次 pi 异常且恢复失败，判定 API 不可用: ${String(e)}`;
        break;
      }
      pending = "上一次执行因平台错误中断。请核对工作区现状，从未完成处继续。";
    }
  }
  // TODO M3: session shutdown/资源释放 API 确认后补上
  if (cov) {
    const map = loadCoverageMap(cov.jsonPath, ctx.cwd, ctx.workdir);
    if (aggregateCoverageEvents(cov.jsonlPath, map)) persistCoverageMap(map, cov.jsonPath);
  }
  return { agent: agentName, output, aborted };
}
