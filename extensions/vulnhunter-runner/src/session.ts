import { nodeRoot, findTaskStart } from "./session-helpers.ts";
export { nodeRoot, loadTaskBook, buildPrompt } from "./session-helpers.ts";
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
 * 血缘：每次 mark/goto/fork/compact 记一行到 <workdir>/system/sessions-lineage.jsonl。
 */

import {
  createAgentSession, DefaultResourceLoader, SessionManager,
  type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions, type ModelRuntime, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NODES, type NodeSpec } from "./nodes.ts";
import { lineage, OpsCounter, tasksCovering, loadLedgerRows } from "./ledger.ts";
import { buildSessionState, type SessionState } from "./session-state.ts";
import { stageTools, type ToolBinding, type WsContext } from "./tools/common.ts";
import { makeProfilerTool } from "./tools/profiler.ts";
import { makeSandboxTool } from "./tools/sandbox.ts";
import { makeHypTool } from "./tools/hyp.ts";
import { makeFindingTool } from "./tools/finding.ts";
import { monitorState } from "./monitor-state.ts";
import { parseModelSpec, resolveModel } from "./model-config.ts";
import { assertModelSelection, type AgentModelRegistry } from "./agent-model.ts";
import { sessionSettings } from "./session-settings.ts";
import { sessionModelOptions } from "./session-model.ts";

/** 会话上下文（与 WorkflowContext 同形，避免循环依赖） */
export interface SessionCtx {
  cwd: string;
  engineDir: string;
  workdir: string;
  params: Record<string, string>;
  /** 当前 run（runtime 注入；进台账记录，跨 run 续跑/观察台拼接更精准） */
  runId?: string;
  /** 可选：按 agentKey 管理的内存模型 runtime（SaaS/纯引擎控制面） */
  modelRegistry?: AgentModelRegistry;
}

export interface SessionHandle {
  readonly id: string;
  readonly agent: string;
  /** 发送任务并等待完成；pi 异常按 runtime 裁定重试/恢复（连续 3 次=API 不可用，aborted=true）。
   *  marks.start/done：发送后/完成后自动打标（fish 09-09 打标规则内化）；
   *  marks.label：任务标签（台账用，缺省不记）；任务起止/时长/attempt/操作计数自动记入台账（fish 09-15） */
  prompt(text: string, marks?: { start?: string; done?: string; label?: string }): Promise<{ aborted: boolean }>;
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
  fork(id: string, agent?: string, binding?: ToolBinding): Promise<SessionHandle>;
  /** hunt 覆盖率记录开关（init 宿主只在 hunt 轮次期间打开，口径=hunt 精读） */
  /** 向会话执行扩展命令（如 /coverage-record on）。命令未注册时跳过并记台账——绝不把 "/xxx" 漏给模型。 */
  execCommand(text: string): Promise<void>;
  /** 会话内动态改 binding（如同一主干会话切 hunt 轮次时换编号 source） */
  setBinding(patch: Partial<ToolBinding>): void;
  /** 运行中切模型（"provider/model[:thinking]"）——下一次模型请求生效；未知名/缺 key 抛错 */
  setModel(spec: string): Promise<void>;
  /** 由 agent runtime 直接提供 Model；供 inline 配置控制面使用。 */
  setResolvedModel(model: unknown, thinking?: string): Promise<void>;
  /** 会话是否空闲（无进行中的模型请求；未知形态返回 true） */
  isIdle(): boolean;
  /** 当前模型 "provider/id"（未知返回 null） */
  currentModel(): string | null;
  /** 当前会话文件路径 */
  sessionFile(): string | undefined;
  /** 会话状态视图（任务定位/摘要映射/活态，fish 09-15） */
  state(): SessionState;
  /** 释放资源 */
  close(): void;
}

async function createSession(
  ctx: SessionCtx,
  agentName: string,
  binding: ToolBinding,
  sessionManager?: SessionManager,
  modelSpec?: string,
  modelRuntime?: ModelRuntime,
  resolvedModel?: CreateAgentSessionOptions["model"],
  modelThinking?: string,
): Promise<{ sess: AgentSession; spec: NodeSpec; customTools: ToolDefinition[] }> {
  const spec: NodeSpec | undefined = NODES[agentName];
  if (!spec) throw new Error(`未知节点: ${agentName}（nodes.ts 未定义）`);

  const agentsBase = readFileSync(join(nodeRoot(ctx.engineDir), "AGENTS.md"), "utf-8");
  const settingsManager = sessionSettings(ctx.cwd, ctx.engineDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    settingsManager,
    appendSystemPrompt: [agentsBase],
    noExtensions: true,
    additionalExtensionPaths: (spec.extensions ?? []).map((n) => join(nodeRoot(ctx.engineDir), "node-ext", n)),
    additionalSkillPaths: [join(nodeRoot(ctx.engineDir), "skills")],
    skillsOverride: spec.skills
      ? (base) => ({ skills: base.skills.filter((s) => spec.skills!.includes(s.name)), diagnostics: base.diagnostics })
      : (base) => ({ skills: [], diagnostics: base.diagnostics }),
  });
  await resourceLoader.reload();

  const ws: WsContext = { workdir: ctx.workdir, cwd: ctx.cwd };
  // 工具面按阶段注入（矩阵单源：src/tools/common.ts STAGE_TOOLS；工具内 op 不限制，fish 09-20）
  const factories: Record<string, () => ToolDefinition> = {
    profiler: () => makeProfilerTool(ws),
    sandbox: () => makeSandboxTool(ws, agentName),
    hyp: () => makeHypTool(ws, binding),
    finding: () => makeFindingTool(ws, binding),
  };
  const customTools = stageTools(agentName)
    .map((name) => factories[name]?.())
    .filter((t): t is ToolDefinition => !!t);

  const model = await sessionModelOptions(ctx.engineDir, settingsManager, { modelSpec, modelRuntime, model: resolvedModel, thinking: modelThinking });
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: ctx.engineDir,
    resourceLoader,
    settingsManager,
    ...model.options,
    ...(sessionManager ? { sessionManager } : {}),
    ...(spec.tools ? { tools: [...spec.tools, ...customTools.map((t) => t.name)] } : {}),
    customTools,
  });
  if (model.expected) {
    try { assertModelSelection(session, model.expected); }
    catch (error) { session.dispose(); throw error; }
  }
  return { sess: session, spec, customTools };
}

export { SUMMARY_SHAPE } from "./branch-summary.ts";

/** 开启（或复活）一个节点会话 */
export async function startSession(ctx: SessionCtx, opts: {
  agent: string;
  id?: string;
  binding?: ToolBinding;
  /** 复活已有会话文件 */
  sessionFile?: string;
  /** 可选的 SDK 会话管理器；测试/嵌入式调用可用 in-memory，未给则按 sessionFile/默认创建。 */
  sessionManager?: SessionManager;
  /** 指定模型（"provider/model[:thinking]"，按池分配注入）；缺省=settings.json 默认 */
  modelSpec?: string;
  /** inline agent model runtime；与 modelAgentKey 二选一。 */
  modelRuntime?: ModelRuntime;
  resolvedModel?: CreateAgentSessionOptions["model"];
  modelThinking?: string;
  /** 从 ctx.modelRegistry 取该 agent 的稳定 runtime + 当前 Model。 */
  modelAgentKey?: string;
}): Promise<SessionHandle> {
  const id = opts.id ?? `${opts.agent}-${Date.now()}`;
  const sm = opts.sessionManager ?? (opts.sessionFile ? SessionManager.open(opts.sessionFile) : undefined);
  const bindingRef: ToolBinding = opts.binding ?? {};
  let modelRuntime = opts.modelRuntime;
  let resolvedModel = opts.resolvedModel;
  let modelThinking = opts.modelThinking;
  if (opts.modelAgentKey) {
    if (!ctx.modelRegistry) throw new Error(`未提供 modelRegistry，无法打开 agent ${opts.modelAgentKey}`);
    const current = ctx.modelRegistry.current(opts.modelAgentKey);
    modelRuntime = current.runtime;
    resolvedModel = current.model;
    modelThinking = current.selection.thinking;
  }
  const { sess, spec } = await createSession(ctx, opts.agent, bindingRef, sm, opts.modelSpec, modelRuntime, resolvedModel, modelThinking);

  // 监控 + hunt 覆盖记录（hunt 精读=覆盖率唯一口径）
  monitorState.nodeStart(id, { id, agent: opts.agent, target: opts.binding?.hypId ?? (opts.binding?.tag || undefined), startTs: Date.now(), workdir: ctx.workdir, cwd: ctx.cwd });
  let sessFile: string | undefined;
  try { sessFile = (sess as any).sessionManager?.getSessionFile?.(); if (sessFile) monitorState.nodeSession(id, sessFile); } catch { /* 无碍 */ }

  // 台账/血缘统一带 run 标识（fish 09-15）
  const ln = (rec: Record<string, unknown>) => lineage(ctx.workdir, ctx.runId ? { run: ctx.runId, ...rec } : rec);

  // 操作计数（task 区间聚合：全节点通用，fish 09-15）——pi 的 end 事件不带 args，start 暂存参数
  const ops = new OpsCounter();
  sess.subscribe((ev: AgentSessionEvent) => {
    const e = ev as unknown as { type?: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean };
    if (e.type === "tool_execution_start") ops.onStart(String(e.toolCallId ?? ""), String(e.toolName ?? ""), e.args);
    else if (e.type === "tool_execution_end") {
      let r = "";
      try { r = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? ""); } catch { r = ""; }
      ops.onEnd(String(e.toolCallId ?? ""), String(e.toolName ?? ""), !!e.isError, r);
    }
  });

  let closed = false;
  let unregisterAgentModel: (() => void) | undefined;
  // 任务序号按会话文件接续：同一会话文件跨句柄复活（stage 边界）时序号不重叠（09-15 回归实踩 init#t1×3）
  let taskSeq = 0;
  try { taskSeq = loadLedgerRows(ctx.workdir).filter((r) => r.action === "task-start" && (sessFile ? r.file === sessFile : r.id === id)).length; } catch { /* 无碍 */ }

  const handle: SessionHandle = {
    id,
    agent: opts.agent,

    async prompt(text: string, marks?: { start?: string; done?: string; label?: string }) {
      // 任务台账（fish 09-15）：task = 一次 prompt 完整生命周期；start/end 条目、时长、attempt、操作计数
      const taskId = `${id}#t${++taskSeq}`;
      const startedAt = Date.now();
      const smP = (sess as any).sessionManager as SessionManager;
      const preLeaf = smP.getLeafId();
      const target = bindingRef.hypId ?? (bindingRef.tag || undefined);
      const preview = text.replace(/\s+/g, " ").slice(0, 160);
      ops.reset();   // 计数窗口 = 本任务
      let failures = 0;
      let pending = text;
      let firstTry = true;
      for (;;) {
        try {
          if (firstTry) {
            if (marks?.start) handle.mark(marks.start);   // 任务发出前打 start（pi 的 prompt 会阻塞到完成，只能打在提交前——树序正确：start 标在用户消息前）
            ln({
              id, action: "task-start", task: taskId, file: sessFile, agent: opts.agent, target,
              label: marks?.label, marks: marks ? { start: marks.start, done: marks.done } : undefined, prompt: preview,
            });
          }
          firstTry = false;
          await sess.prompt(pending);
          await sess.waitForIdle();
          // 任务终点 = 收尾条目（done 标之前那一叶）；起点 = 本任务链上最早的用户消息条目（fish 09-15）
          const endEntry = smP.getLeafId() ?? undefined;
          const startEntry = findTaskStart(smP, preLeaf, endEntry);
          if (marks?.done) handle.mark(marks.done);                 // 完成后打 done
          ln({
            id, action: "task-end", task: taskId, file: sessFile, agent: opts.agent, target,
            label: marks?.label, startEntry, endEntry, status: "done",
            attempts: failures + 1, startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt, ops: ops.snapshot(),
          });
          return { aborted: false };
        } catch (e) {
          failures++;
          if (failures >= 3) {
            ln({ id, action: "abort", reason: String(e) });
            const endEntry = smP.getLeafId() ?? undefined;
            ln({
              id, action: "task-end", task: taskId, file: sessFile, agent: opts.agent, target,
              label: marks?.label, startEntry: findTaskStart(smP, preLeaf, endEntry), endEntry, status: "aborted",
              attempts: failures, startedAt: new Date(startedAt).toISOString(),
              durationMs: Date.now() - startedAt, ops: ops.snapshot(),
            });
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
      // 自研分支摘要（fish 09-11）；task summary 语义（fish 09-15）：闭区间含两端、挂到起处的前驱
      const { branchSummarize } = await import("./branch-summary.ts");
      const r = await branchSummarize(sess as unknown as Parameters<typeof branchSummarize>[0], label, opts2);
      // 折叠台账（task summary = 唯一折叠操作）：覆盖区间 + 成员任务；coveredBy 派生
      ln({
        id, action: "fold", file: sessFile, kind: "task-summary", label, summaryEntry: r.summaryId, summaryLabel: opts2.summaryLabel,
        attach: r.attachId, from: r.fromId, covered: r.coveredIds.length, coveredIds: r.coveredIds,
        members: tasksCovering(ctx.workdir, new Set(r.coveredIds)),
      });
    },

    mark(label: string) {
      const sm2 = (sess as any).sessionManager as SessionManager;
      const leaf = sm2.getLeafId();
      if (!leaf) throw new Error("mark 失败：会话无叶子节点");
      // 注意：pi 单条目单标签，叶子已带标签时打标会覆盖旧标签——
      // 裸 goto(X) 后叶子正是 X 锚点条目，此时打标会毁掉锚点（09-11 mem-b hunt3 实踩）。
      // 调用方责任：goto 后、打标前先让叶子推进（发消息/摘要），或像 fresh hunt 那样跳过 start 标。
      sm2.appendLabelChange(leaf, label);
      ln({ id, action: "mark", label, entry: leaf });
    },

    async compact(instructions?: string) {
      await sess.compact(instructions);
      ln({ id, action: "compact" });
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
      ln({ id, action: "goto", label, summarize: !!opts?.summarize, summaryLabel: opts?.summaryLabel });
    },

    async fork(newId: string, newAgent?: string, newBinding?: ToolBinding) {
      // 注意：createBranchedSession 会把调用它的 SessionManager 就地变成新分支（pi 的 /branch 语义），
      // 所以必须用一次性实例操作，否则会话本身被劫持（fork 后原会话标记全丢）。
      const sm2 = (sess as any).sessionManager as SessionManager;
      const leaf = sm2.getLeafId();
      if (!leaf) throw new Error("fork 失败：会话无叶子节点");
      // 叶子上溯：总结/打标会把叶子留在 label 条目上，直接以此为分叉点会得到空分支（09-20 实踩：hunt-end）
      let forkLeaf = leaf;
      {
        const byId = new Map(sm2.getEntries().map((e) => [e.id, e as { id: string; type?: string; parentId?: string | null }]));
        let g = 0;
        while (g++ < 1000) {
          const e = byId.get(forkLeaf);
          if (!e || e.type !== "label") break;
          forkLeaf = e.parentId ?? "";
        }
        if (!forkLeaf) throw new Error("fork 失败：叶子上溯未找到内容条目");
      }
      const srcFile = sm2.getSessionFile?.();
      if (!srcFile) throw new Error("fork 失败：会话未持久化");
      const tmp = SessionManager.open(srcFile);
      const path = tmp.createBranchedSession(forkLeaf);
      if (!path) throw new Error("fork 失败：createBranchedSession 未返回路径");
      // pi 的 createBranchedSession 在分支无 assistant 消息时不落盘（延迟到 _persist，留给同实例续写）；
      // 我们按路径新开会话（不同实例），需显式落盘——否则分支内容丢失得到空链（09-20 实踩：hunt-end fork）
      if (!existsSync(path)) (tmp as any)._rewriteFile?.();
      if (!existsSync(path)) throw new Error("fork 失败：分支文件未生成");
      ln({ id, action: "fork", child: newId, childAgent: newAgent ?? opts.agent, file: path });
      return startSession(ctx, {
        agent: newAgent ?? opts.agent,
        id: newId,
        binding: newBinding ?? opts.binding,
        sessionFile: path,
        modelRuntime,
        resolvedModel,
        modelThinking,
        modelAgentKey: opts.modelAgentKey,
      });
    },

    async execCommand(text: string) {
      const cmdName = text.startsWith("/") ? text.slice(1).split(/\s+/)[0] : "";
      const runner = (sess as any)._extensionRunner;
      const cmd = cmdName ? runner?.getCommand?.(cmdName) : undefined;
      if (!cmd) { ln({ id, action: "command-skip", command: text }); return; }
      await sess.prompt(text);
      ln({ id, action: "command", command: text });
    },

    setBinding(patch: Partial<ToolBinding>) { Object.assign(bindingRef, patch); },

    async setResolvedModel(model: unknown, thinking?: string) {
      const selected = model as NonNullable<CreateAgentSessionOptions["model"]>;
      await sess.setModel(selected);
      if (thinking) {
        const parsed = parseModelSpec(`${selected.provider}/${selected.id}:${thinking}`);
        sess.setThinkingLevel(parsed.thinking!);
        assertModelSelection(sess, { providerId: selected.provider, modelId: selected.id, thinking: parsed.thinking });
      }
      const m = model as { provider?: string; id?: string };
      ln({ id, action: "set-model", model: `${m.provider ?? "?"}/${m.id ?? "?"}${thinking ? ":" + thinking : ""}` });
    },

    async setModel(spec: string) {
      if (opts.modelAgentKey && ctx.modelRegistry) {
        const selected = parseModelSpec(spec);
        const snapshot = ctx.modelRegistry.snapshot(opts.modelAgentKey);
        await ctx.modelRegistry.replaceAgentModel(opts.modelAgentKey, { ...snapshot, version: snapshot.version + 1,
          selection: { providerId: selected.provider, modelId: selected.id, thinking: selected.thinking ?? snapshot.selection.thinking } });
        return;
      }
      const { model, parsed } = await resolveModel(ctx.engineDir, spec);
      await handle.setResolvedModel(model, parsed.thinking);
    },

    isIdle() {
      try { const f = (sess as unknown as { isIdle?: () => boolean }).isIdle; return f ? !!f.call(sess) : true; } catch { return true; }
    },

    currentModel() {
      try { const m = (sess as unknown as { model?: { provider?: string; id?: string } }).model; return m?.provider && m?.id ? `${m.provider}/${m.id}` : null; } catch { return null; }
    },

    sessionFile() {
      try { return (sess as any).sessionManager?.getSessionFile?.(); } catch { return undefined; }
    },

    state() {
      try {
        const sm3 = (sess as any).sessionManager as SessionManager;
        return buildSessionState({
          file: sessFile ?? "",
          workdir: ctx.workdir,
          entries: sm3.getEntries() as unknown as Parameters<typeof buildSessionState>[0]["entries"],
          leafId: sm3.getLeafId(),
        });
      } catch {
        return buildSessionState({ file: sessFile ?? "", workdir: ctx.workdir });
      }
    },

    close() {
      if (closed) return;
      closed = true;
      unregisterAgentModel?.();
      unregisterAgentModel = undefined;
      monitorState.nodeEnd(id);
      try { (sess as any).dispose?.(); } catch { /* 无碍 */ }
    },
  };

  if (opts.modelAgentKey && ctx.modelRegistry) unregisterAgentModel = ctx.modelRegistry.register(opts.modelAgentKey, handle);
  ln({ id, action: "start", agent: opts.agent, resumed: !!opts.sessionFile, file: sessFile });
  return handle;
}

/**
 * 从会话文件的标记处分叉出独立会话（forkFromLabel）。
 * 每次调用都从磁盘重读当前文件——并行模式下 hunt 仍在追加会话，旧 handle 的内存状态看不到新标记（fish 09-21）。
 * 分支点语义与 handle.fork 一致：定位标记 → 叶子上溯跳过 label → createBranchedSession → 显式落盘。
 */
export async function forkFromLabel(
  ctx: SessionCtx,
  sessionFile: string,
  label: string,
  newId: string,
  o?: { agent?: string; binding?: ToolBinding; modelSpec?: string; modelAgentKey?: string },
): Promise<SessionHandle> {
  const sm = SessionManager.open(sessionFile);
  const entries = sm.getEntries();
  const entry = entries.find((e) => sm.getLabel(e.id) === label)
    ?? entries.find((e) => (sm.getLabel(e.id) ?? "").startsWith(label));   // 前缀匹配（成分表标记）
  if (!entry) throw new Error(`fork 失败：会话树上没有标记 "${label}"`);
  const byId = new Map(entries.map((e) => [e.id, e as unknown as { id: string; type?: string; parentId?: string | null }]));
  let forkLeaf: string = entry.id;
  let g = 0;
  while (g++ < 1000) {
    const e = byId.get(forkLeaf);
    if (!e || e.type !== "label") break;
    forkLeaf = e.parentId ?? "";
  }
  if (!forkLeaf) throw new Error("fork 失败：叶子上溯未找到内容条目");
  const path = sm.createBranchedSession(forkLeaf);
  if (!path) throw new Error("fork 失败：createBranchedSession 未返回路径");
  if (!existsSync(path)) (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
  if (!existsSync(path)) throw new Error("fork 失败：分支文件未生成");
  lineage(ctx.workdir, ctx.runId
    ? { run: ctx.runId, id: newId, action: "fork", label, file: path }
    : { id: newId, action: "fork", label, file: path });
  return startSession(ctx, {
    agent: o?.agent ?? "hyp-chain",
    id: newId,
    binding: o?.binding,
    sessionFile: path,
    modelSpec: o?.modelSpec,
    modelAgentKey: o?.modelAgentKey,
  });
}

