/**
 * SessionService：pi 会话树的程序化封装（灵活性框架核心）。
 *
 * 设计裁定（fish 09-05）：
 *   - mark 纯拓扑（打标记），compact 独立动词，消费方式由下游编排决定；
 *   - 编号体系即标记命名（init / hunt-r1 / HYP-... ），下游按标记找起点；
 *   - 分支往返 = goto(label, {summarize:true})：离开的分支留摘要在会话里；
 *   - fork = 提取当前路径成独立会话文件（并发链用）；
 *   - user prompt 承载任务目标（任务书+任务句由 lib 装配）。
 *
 * 血缘：每次 mark/goto/fork/compact 记一行到 <workdir>/sessions-lineage.jsonl。
 */

import {
  createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, parseFrontmatter,
  type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NODES, type NodeSpec } from "./nodes.ts";
import { type FnBinding, type WsContext } from "./workspace-tools.ts";
import { makeArtifactTool } from "./artifact.ts";
import { monitorState } from "./monitor-state.ts";
import { getCoveragePaths, loadCoverageMap, aggregateCoverageEvents, persistCoverageMap, recordReadCoverageEvent } from "./node-ext/code-coverage/coverage-core.ts";

/** 会话上下文（与 WorkflowContext 同形，避免循环依赖） */
export interface SessionCtx {
  cwd: string;
  engineDir: string;
  workdir: string;
  params: Record<string, string>;
}

export interface SessionHandle {
  readonly id: string;
  readonly agent: string;
  /** 发送任务并等待完成；pi 异常按 runtime 裁定重试/恢复（连续 3 次=API 不可用，aborted=true）。
   *  marks.start/done：发送后/完成后自动打标（fish 09-09 打标规则内化） */
  prompt(text: string, marks?: { start?: string; done?: string }): Promise<{ aborted: boolean }>;
  /** 纯打标记（当前叶子位置） */
  mark(label: string): void;
  /** 当前上下文占用百分比（pi getContextUsage；未知返回 null） */
  contextPercent(): number | null;
  /** 引导式树摘要：从当前叶摘要回 mark 节点（全程覆盖、无 keep-recent 窗口）。
   *  摘要结构遵循 fish 09-10 规则：xxx-start 任务定义 + 执行完成事实 + 核心论据与结论，丢弃中间细节。 */
  /** 压缩当前上下文（独立动词） */
  compact(instructions?: string): Promise<void>;
  /** 回到标记点；summarize=true 时离开的分支留摘要（分支往返） */
  goto(label: string, opts?: { summarize?: boolean; customInstructions?: string; summaryLabel?: string }): Promise<void>;
  summarizeTo(label: string, opts: { summaryLabel: string; guide?: string }): Promise<void>;
  /** 提取当前路径成独立会话，返回新 handle（并发链用）；agent/binding 可换（会话历史与工具集正交） */
  fork(id: string, agent?: string, binding?: FnBinding): Promise<SessionHandle>;
  /** hunt 覆盖率记录开关（init 宿主只在 hunt 轮次期间打开，口径=hunt 精读） */
  setCoverage(on: boolean): void;
  /** 会话内动态改 binding（如同一主干会话切 hunt 轮次时换编号 source） */
  setBinding(patch: Partial<FnBinding>): void;
  /** 当前会话文件路径 */
  sessionFile(): string | undefined;
  /** 释放资源 */
  close(): void;
}

/** 读 tasks/<name>.md 正文（兼容残留 frontmatter，剥掉） */
/** 节点资源根（自包含扩展目录：tasks/ skills/ AGENTS.md node-ext/ 都在这下面，fish 09-11 收纳） */
export function nodeRoot(engineDir: string): string { return join(engineDir, "extensions", "vulnhunter-runner"); }

export function loadTaskBook(engineDir: string, name: string): string {
  const raw = readFileSync(join(nodeRoot(engineDir), "tasks", `${name}.md`), "utf-8");
  return parseFrontmatter<Record<string, unknown>>(raw).body.trim();
}

/** 定稿 user prompt 组装：参数头部 + 任务书 + 任务说明句（fish 09-02 裁定） */
export function buildPrompt(ctx: SessionCtx, agentName: string, task: string, extra?: string): string {
  const head = [
    `工作区根目录：${ctx.workdir}（任务里的产物相对路径——leads/ todo/ findings/ 等——都以它为基准）`,
    `引擎扩展根目录：${nodeRoot(ctx.engineDir)}（任务书提到的 skills/ 等引擎侧相对路径以它为基准，不是目标项目目录）`,
    ctx.params.sandbox_cfg ? `沙箱连接配置：${ctx.params.sandbox_cfg}` : "",
    ctx.params.vuln_focus ? `漏洞关注方向：${ctx.params.vuln_focus}` : "",
    ctx.params.output_lang ? `输出语言：${ctx.params.output_lang}` : "输出语言：zh-CN",
  ].filter(Boolean);
  return [
    head.length ? "当前审计任务情况说明：\n" + head.join("\n") : "",
    loadTaskBook(ctx.engineDir, agentName),
    `接下来开始执行 ${task}${extra ? "\n" + extra : ""}`,
  ].filter(Boolean).join("\n\n");
}

function lineage(workdir: string, rec: Record<string, unknown>): void {
  try { appendFileSync(join(workdir, "sessions-lineage.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* 血缘记录失败无碍 */ }
}

async function createSession(ctx: SessionCtx, agentName: string, binding: FnBinding, sessionManager?: SessionManager): Promise<{ sess: AgentSession; spec: NodeSpec; customTools: ReturnType<typeof makeArtifactTool>[] }> {
  const spec: NodeSpec | undefined = NODES[agentName];
  if (!spec) throw new Error(`未知节点: ${agentName}（nodes.ts 未定义）`);

  const agentsBase = readFileSync(join(nodeRoot(ctx.engineDir), "AGENTS.md"), "utf-8");
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    settingsManager: SettingsManager.create(ctx.cwd, ctx.engineDir),
    appendSystemPrompt: [agentsBase],
    noExtensions: true,
    additionalExtensionPaths: (spec.extensions ?? []).map((n) => join(nodeRoot(ctx.engineDir), "src", "node-ext", n)),
    additionalSkillPaths: [join(nodeRoot(ctx.engineDir), "skills")],
    skillsOverride: spec.skills
      ? (base) => ({ skills: base.skills.filter((s) => spec.skills!.includes(s.name)), diagnostics: base.diagnostics })
      : (base) => ({ skills: [], diagnostics: base.diagnostics }),
  });
  await resourceLoader.reload();

  const ws: WsContext = { workdir: ctx.workdir, cwd: ctx.cwd };
  const customTools = [makeArtifactTool(ws, binding, agentName)];   // artifact 元工具恒定挂载（fns 白名单已废，fish 09-08）

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    resourceLoader,
    ...(sessionManager ? { sessionManager } : {}),
    ...(spec.tools ? { tools: [...spec.tools, ...customTools.map((t) => t.name)] } : {}),
    customTools,
  });
  return { sess: session, spec, customTools };
}

export { SUMMARY_SHAPE } from "./branch-summary.ts";

/** 开启（或复活）一个节点会话 */
export async function startSession(ctx: SessionCtx, opts: {
  agent: string;
  id?: string;
  binding?: FnBinding;
  /** 复活已有会话文件 */
  sessionFile?: string;
}): Promise<SessionHandle> {
  const id = opts.id ?? `${opts.agent}-${Date.now()}`;
  const sm = opts.sessionFile ? SessionManager.open(opts.sessionFile) : undefined;
  const bindingRef: FnBinding = opts.binding ?? {};
  const { sess, spec } = await createSession(ctx, opts.agent, bindingRef, sm);

  // 监控 + hunt 覆盖记录（hunt 精读=覆盖率唯一口径）
  monitorState.nodeStart(id, { id, agent: opts.agent, target: opts.binding?.advId ?? opts.binding?.hypId, startTs: Date.now() });
  try { const sf = (sess as any).sessionManager?.getSessionFile?.(); if (sf) monitorState.nodeSession(id, sf); } catch { /* 无碍 */ }
  const cov = getCoveragePaths(ctx.workdir);
  let covOn = opts.agent === "hunt";
  sess.subscribe((ev: AgentSessionEvent) => {
    if (covOn && ev.type === "tool_execution_end" && (ev as any).toolName === "read" && !(ev as any).isError) {
      recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: ctx.cwd, stage: "hunt", input: (ev as any).args });
    }
  });

  let closed = false;
  const flushCoverage = () => {
    if (!cov) return;
    const map = loadCoverageMap(cov.jsonPath, ctx.cwd, ctx.workdir);
    if (aggregateCoverageEvents(cov.jsonlPath, map)) persistCoverageMap(map, cov.jsonPath);
  };

  const handle: SessionHandle = {
    id,
    agent: opts.agent,

    async prompt(text: string, marks?: { start?: string; done?: string }) {
      let failures = 0;
      let pending = text;
      let firstTry = true;
      for (;;) {
        try {
          if (firstTry && marks?.start) handle.mark(marks.start);   // 任务发出前打 start（pi 的 prompt 会阻塞到完成，只能打在提交前——树序正确：start 标在用户消息前）
          firstTry = false;
          await sess.prompt(pending);
          await sess.waitForIdle();
          flushCoverage();
          if (marks?.done) handle.mark(marks.done);                 // 完成后打 done
          return { aborted: false };
        } catch (e) {
          failures++;
          if (failures >= 3) {
            lineage(ctx.workdir, { id, action: "abort", reason: String(e) });
            return { aborted: true };
          }
          pending = "上一次执行因平台错误中断。请核对工作区现状，从未完成处继续。";
        }
      }
    },

    contextPercent(): number | null {
      return (sess as any).getContextUsage?.()?.percent ?? null;
    },

    async summarizeTo(label: string, opts2: { summaryLabel: string; guide?: string }) {
      // 自研分支摘要（fish 09-11）：不经过 pi 摘要器（其 4096 硬编码/thinking 丢失缺陷与我们再无关系）
      const { branchSummarize } = await import("./branch-summary.ts");
      await branchSummarize(sess as unknown as Parameters<typeof branchSummarize>[0], ctx.engineDir, label, opts2);
      lineage(ctx.workdir, { id, action: "branch-summary", label, summaryLabel: opts2.summaryLabel });
    },

    mark(label: string) {
      const sm2 = (sess as any).sessionManager as SessionManager;
      const leaf = sm2.getLeafId();
      if (!leaf) throw new Error("mark 失败：会话无叶子节点");
      sm2.appendLabelChange(leaf, label);
      lineage(ctx.workdir, { id, action: "mark", label, entry: leaf });
    },

    async compact(instructions?: string) {
      await sess.compact(instructions);
      lineage(ctx.workdir, { id, action: "compact" });
    },

    async goto(label: string, opts?: { summarize?: boolean; customInstructions?: string; summaryLabel?: string }) {
      const sm2 = (sess as any).sessionManager as SessionManager;
      const entries = sm2.getEntries();
      let entry = entries.find((e) => sm2.getLabel(e.id) === label)
        ?? entries.find((e) => (sm2.getLabel(e.id) ?? "").startsWith(label));   // 前缀匹配（成分表标记按前缀定位）
      if (!entry) throw new Error(`goto 失败：会话树上没有标记 "${label}"`);
      const r = await sess.navigateTree(entry.id, {
        summarize: opts?.summarize ?? false,
        customInstructions: opts?.customInstructions,
        label: opts?.summaryLabel,
      });
      if (r.cancelled) throw new Error(`goto("${label}") 被取消`);
      lineage(ctx.workdir, { id, action: "goto", label, summarize: !!opts?.summarize, summaryLabel: opts?.summaryLabel });
    },

    async fork(newId: string, newAgent?: string, newBinding?: FnBinding) {
      // 注意：createBranchedSession 会把调用它的 SessionManager 就地变成新分支（pi 的 /branch 语义），
      // 所以必须用一次性实例操作，否则会话本身被劫持（fork 后原会话标记全丢）。
      const sm2 = (sess as any).sessionManager as SessionManager;
      const leaf = sm2.getLeafId();
      if (!leaf) throw new Error("fork 失败：会话无叶子节点");
      const srcFile = sm2.getSessionFile?.();
      if (!srcFile) throw new Error("fork 失败：会话未持久化");
      const tmp = SessionManager.open(srcFile);
      const path = tmp.createBranchedSession(leaf);
      if (!path) throw new Error("fork 失败：createBranchedSession 未返回路径");
      lineage(ctx.workdir, { id, action: "fork", child: newId, childAgent: newAgent ?? opts.agent, file: path });
      return startSession(ctx, { agent: newAgent ?? opts.agent, id: newId, binding: newBinding ?? opts.binding, sessionFile: path });
    },

    setCoverage(on: boolean) { covOn = on; },

    setBinding(patch: Partial<FnBinding>) { Object.assign(bindingRef, patch); },

    sessionFile() {
      try { return (sess as any).sessionManager?.getSessionFile?.(); } catch { return undefined; }
    },

    close() {
      if (closed) return;
      closed = true;
      flushCoverage();
      monitorState.nodeEnd(id);
      try { (sess as any).dispose?.(); } catch { /* 无碍 */ }
    },
  };

  lineage(ctx.workdir, { id, action: "start", agent: opts.agent, resumed: !!opts.sessionFile });
  return handle;
}
