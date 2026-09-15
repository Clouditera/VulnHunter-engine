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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODES, type NodeSpec } from "./nodes.ts";
import { lineage, OpsCounter, tasksCovering } from "./ledger.ts";
import { buildSessionState, type SessionState } from "./session-state.ts";
import { type FnBinding, type WsContext } from "./workspace-tools.ts";
import { makeArtifactTool } from "./artifact.ts";
import { monitorState } from "./monitor-state.ts";
import { getCoveragePaths, loadCoverageConfig, loadCoverageMap, aggregateCoverageEvents, persistCoverageMap, recordReadCoverageEvent } from "../node-ext/code-coverage/coverage-core.ts";

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
  fork(id: string, agent?: string, binding?: FnBinding): Promise<SessionHandle>;
  /** hunt 覆盖率记录开关（init 宿主只在 hunt 轮次期间打开，口径=hunt 精读） */
  setCoverage(on: boolean): void;
  /** 会话内动态改 binding（如同一主干会话切 hunt 轮次时换编号 source） */
  setBinding(patch: Partial<FnBinding>): void;
  /** 当前会话文件路径 */
  sessionFile(): string | undefined;
  /** 会话状态视图（任务定位/摘要映射/活态，fish 09-15） */
  state(): SessionState;
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

/** 从 end 沿 parentId 上溯到 preLeaf，取链上最早的用户消息条目 = 任务起点（重试轮取首个 prompt） */
function findTaskStart(sm: SessionManager, preLeaf: string | null, endEntry?: string): string | undefined {
  const byId = new Map(sm.getEntries().map((e) => [e.id, e]));
  let cur: string | null = endEntry ?? null;
  let found: string | undefined;
  let guard = 0;
  while (cur && cur !== preLeaf && guard++ < 200000) {
    const e = byId.get(cur);
    if (!e) break;
    const m = e as unknown as { type?: string; message?: { role?: string } };
    if (m.type === "message" && m.message?.role === "user") found = e.id;   // 持续覆写 → 最后留下最早的一条
    cur = (e.parentId as string | null) ?? null;
  }
  return found;
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
    additionalExtensionPaths: (spec.extensions ?? []).map((n) => join(nodeRoot(ctx.engineDir), "node-ext", n)),
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
  monitorState.nodeStart(id, { id, agent: opts.agent, target: opts.binding?.advId ?? opts.binding?.hypId, startTs: Date.now(), workdir: ctx.workdir, cwd: ctx.cwd });
  let sessFile: string | undefined;
  try { sessFile = (sess as any).sessionManager?.getSessionFile?.(); if (sessFile) monitorState.nodeSession(id, sessFile); } catch { /* 无碍 */ }

  // 模型回退守卫（09-15 sec 实报：KIMI_API_KEY 传空 → pi 静默换默认模型继续跑，盲测险情）。
  // 引擎的模型唯一来源是 settings.json 默认项，实际生效必须一致；不一致默认硬失败。
  let expectedModel: string | null = null;
  try {
    const sj = JSON.parse(readFileSync(join(ctx.engineDir, "settings.json"), "utf-8")) as { defaultProvider?: string; defaultModel?: string };
    if (sj.defaultProvider && sj.defaultModel) expectedModel = `${sj.defaultProvider}/${sj.defaultModel}`;
  } catch { /* 无 settings.json 或读不出 → 不设期望，跳过守卫 */ }
  if (expectedModel) {
    const em = (sess as unknown as { model?: { provider?: string; id?: string } }).model;
    const got = em?.provider && em?.id ? `${em.provider}/${em.id}` : "（无）";
    if (got !== expectedModel) {
      const msg = `模型回退检测：settings.json 配置 ${expectedModel}，实际生效 ${got}——疑似 provider 认证缺失被 pi 静默替换。`;
      if (process.env.VULNHUNTER_ALLOW_MODEL_FALLBACK === "1") {
        monitorState.log(`警告：${msg}（已放行）`);
        console.error(`[vulnhunter] ${msg}`);
      } else {
        monitorState.nodeEnd(id);
        try { (sess as any).dispose?.(); } catch { /* 无碍 */ }
        throw new Error(`${msg} run 已中止；确认 API key 后重试，或设 VULNHUNTER_ALLOW_MODEL_FALLBACK=1 放行。`);
      }
    }
  }
  const cov = getCoveragePaths(ctx.workdir);
  const covCfg = loadCoverageConfig(ctx.workdir);
  let covOn = opts.agent === "hunt";
  // pi 的 tool_execution_end 事件不带 args（09-11 实踩：全程零事件），
  // 须在 start 暂存参数、end 配对确认未出错后再记。
  const covReads = new Map<string, unknown>();
  sess.subscribe((ev: AgentSessionEvent) => {
    if (!covOn) return;
    if (ev.type === "tool_execution_start" && (ev as any).toolName === "read") {
      covReads.set((ev as any).toolCallId, (ev as any).args);
    } else if (ev.type === "tool_execution_end" && (ev as any).toolName === "read" && !(ev as any).isError) {
      const a = covReads.get((ev as any).toolCallId);
      covReads.delete((ev as any).toolCallId);
      if (a) recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: ctx.cwd, stage: "hunt", input: a as any, cfg: covCfg });
    }
  });

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
  let taskSeq = 0;
  const flushCoverage = () => {
    if (!cov) return;
    const map = loadCoverageMap(cov.jsonPath, ctx.cwd, ctx.workdir);
    if (aggregateCoverageEvents(cov.jsonlPath, map)) persistCoverageMap(map, cov.jsonPath);
  };

  const handle: SessionHandle = {
    id,
    agent: opts.agent,

    async prompt(text: string, marks?: { start?: string; done?: string; label?: string }) {
      // 任务台账（fish 09-15）：task = 一次 prompt 完整生命周期；start/end 条目、时长、attempt、操作计数
      const taskId = `${id}#t${++taskSeq}`;
      const startedAt = Date.now();
      const smP = (sess as any).sessionManager as SessionManager;
      const preLeaf = smP.getLeafId();
      const target = bindingRef.hypId ?? bindingRef.advId;
      const preview = text.replace(/\s+/g, " ").slice(0, 160);
      ops.reset();   // 计数窗口 = 本任务
      let failures = 0;
      let pending = text;
      let firstTry = true;
      for (;;) {
        try {
          if (firstTry) {
            if (marks?.start) handle.mark(marks.start);   // 任务发出前打 start（pi 的 prompt 会阻塞到完成，只能打在提交前——树序正确：start 标在用户消息前）
            lineage(ctx.workdir, {
              id, action: "task-start", task: taskId, file: sessFile, agent: opts.agent, target,
              label: marks?.label, marks: marks ? { start: marks.start, done: marks.done } : undefined, prompt: preview,
            });
          }
          firstTry = false;
          await sess.prompt(pending);
          await sess.waitForIdle();
          flushCoverage();
          // 任务终点 = 收尾条目（done 标之前那一叶）；起点 = 本任务链上最早的用户消息条目（fish 09-15）
          const endEntry = smP.getLeafId() ?? undefined;
          const startEntry = findTaskStart(smP, preLeaf, endEntry);
          if (marks?.done) handle.mark(marks.done);                 // 完成后打 done
          lineage(ctx.workdir, {
            id, action: "task-end", task: taskId, file: sessFile, agent: opts.agent, target,
            label: marks?.label, startEntry, endEntry, status: "done",
            attempts: failures + 1, startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt, ops: ops.snapshot(),
          });
          return { aborted: false };
        } catch (e) {
          failures++;
          if (failures >= 3) {
            lineage(ctx.workdir, { id, action: "abort", reason: String(e) });
            const endEntry = smP.getLeafId() ?? undefined;
            lineage(ctx.workdir, {
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
      const r = await branchSummarize(sess as unknown as Parameters<typeof branchSummarize>[0], ctx.engineDir, label, opts2);
      // 折叠台账（task summary = 唯一折叠操作）：覆盖区间 + 成员任务；coveredBy 派生
      lineage(ctx.workdir, {
        id, action: "fold", file: sessFile, kind: "task-summary", label, summaryEntry: r.summaryId, summaryLabel: opts2.summaryLabel,
        attach: r.attachId, from: r.fromId, covered: r.coveredIds.length, coveredIds: r.coveredIds,
        members: tasksCovering(ctx.workdir, sessFile, new Set(r.coveredIds)),
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
      flushCoverage();
      monitorState.nodeEnd(id);
      try { (sess as any).dispose?.(); } catch { /* 无碍 */ }
    },
  };

  lineage(ctx.workdir, { id, action: "start", agent: opts.agent, resumed: !!opts.sessionFile, file: sessFile });
  return handle;
}
