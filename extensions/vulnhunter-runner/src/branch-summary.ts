/**
 * 自研分支摘要（fish 09-11：主动触发的能力，不依赖 pi 的摘要器）。
 *
 * 等价于 pi tree 的 branch summary，但全链路自控：
 * - 条目收集：沿 parentId 从当前叶走到挂载点（不依赖 pi 内部函数）；
 * - 序列化：我们自己把条目流压成文本（thinking 截断、toolResult 截断、标记/前序摘要保留）；
 * - 模型调用：同一会话的 SDK runtime、模型和思考档；摘要预算仍由这里指定，
 *   不使用 Pi 内置摘要器的截取/预算规则，也不另读凭证文件或硬编码某一种协议；
 * - 落树：SessionManager.branchWithSummary（pi 公开 API）把摘要挂到起处的前驱并推进叶子，
 *   再打标、同步 agent 内存态（与 navigateTree 末尾同款）。task summary 语义（fish 09-15）：
 *   闭区间 [起, 止] 含两端——起 = 标记所指节点（任务开始处），止 = 当前叶（收尾）；整段原位替换。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";


/** 摘要结构模板（fish 09-10）：start 任务定义 + 完成事实 + 核心论据结论，丢中间细节 */
export const SUMMARY_SHAPE = `摘要格式要求（必须遵守）：
1. 被摘要区间内每个任务/轮次都按「任务定义（start 处的目标）→ 执行完成的事实（产物编号清单、裁决/结论）→ 核心论据（关键判断与代码锚点 file:line）」记录；
2. 丢弃中间推演过程、重复代码细节、试错与回退。`;

const SUMMARY_SYSTEM = `你是对话历史摘要器。把一段安全审计流水线的会话历史压缩成结构化摘要，供后续任务继承上下文。

${SUMMARY_SHAPE}

输出中文，markdown，按任务/轮次分节。`;

interface SMLike {
  getEntries(): Array<{ id: string; parentId: string | null; type: string; [k: string]: unknown }>;
  getLeafId(): string | null;
  getLabel(id: string): string | undefined;
  branchWithSummary(targetId: string, summary: string, details?: unknown, fromHook?: boolean, usage?: unknown): string;
  appendLabelChange(entryId: string, label: string): void;
}

/** 从叶子沿 parentId 走到 stopId，收集区间内的条目（含叶子与起处本体，不含挂载点本身） */
function collectPath(sm: SMLike, stopId: string): Array<Record<string, unknown>> {
  const byId = new Map(sm.getEntries().map((e) => [e.id, e]));
  const out: Array<Record<string, unknown>> = [];
  let cur = sm.getLeafId();
  let guard = 0;
  while (cur && cur !== stopId && guard++ < 100000) {
    const e = byId.get(cur);
    if (!e) break;
    out.unshift(e);
    cur = e.parentId;
  }
  return out;
}

/** stopId 是否在当前叶的上行路径上（挂载点安全检查） */
function pathReaches(sm: SMLike, stopId: string): boolean {
  const byId = new Map(sm.getEntries().map((e) => [e.id, e]));
  let cur = sm.getLeafId();
  let guard = 0;
  while (cur && guard++ < 100000) {
    if (cur === stopId) return true;
    const e = byId.get(cur);
    if (!e) break;
    cur = e.parentId;
  }
  return false;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `……[截断，原长 ${s.length}]`;
}

/** 条目流 → 摘要器输入文本 */
export function serializeEntries(entries: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const e of entries) {
    const t = e.type as string;
    if (t === "message") {
      const m = e.message as { role?: string; content?: unknown };
      const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
      const texts: string[] = [];
      for (const p of parts as Array<Record<string, unknown>>) {
        if (p.type === "text") texts.push(clip(String(p.text ?? ""), 4000));
        else if (p.type === "thinking") texts.push(`[思考] ${clip(String(p.thinking ?? p.text ?? ""), 800)}`);
        else if (p.type === "toolCall" || p.type === "tool_call") texts.push(`[调用工具 ${p.name}] ${clip(JSON.stringify(p.arguments ?? p.args ?? {}), 1500)}`);
      }
      if (texts.length) lines.push(`## ${m.role ?? "?"}\n${texts.join("\n")}`);
    } else if (t === "custom_message") {
      lines.push(`## 定制消息\n${clip(String((e as { content?: unknown }).content ?? ""), 2000)}`);
    } else if (t === "label") {
      lines.push(`\n【标记】${(e as { label?: string }).label ?? ""}\n`);
    } else if (t === "branch_summary" || t === "compaction") {
      lines.push(`\n【前序摘要】\n${clip(String((e as { summary?: string }).summary ?? ""), 6000)}\n`);
    }
  }
  return lines.join("\n\n");
}

/** 主入口：task summary——从当前叶摘要回「起处」（targetLabel 所指节点），闭区间含两端，
 *  摘要挂到起处的前驱并推进叶子（fish 09-15 定稿） */
export async function branchSummarize(
  sess: Pick<AgentSession, "model" | "modelRuntime" | "thinkingLevel" | "refreshContext"> & { sessionManager: SMLike },
  targetLabel: string,
  opts: { summaryLabel: string; guide?: string },
): Promise<{ summaryId: string; usage: unknown; targetId: string; attachId: string; fromId?: string; coveredIds: string[] }> {
  const sm = sess.sessionManager;
  const entries = sm.getEntries();
  const target = entries.find((e) => sm.getLabel(e.id) === targetLabel)
    ?? entries.find((e) => (sm.getLabel(e.id) ?? "").startsWith(targetLabel));
  if (!target) throw new Error(`分支摘要失败：会话树上没有标记 "${targetLabel}"`);
  if (sm.getLeafId() === target.id) throw new Error(`分支摘要跳过：叶子已在 "${targetLabel}"`);

  // task summary 语义（fish 09-15）：起 = 标记所指节点（含），止 = 当前叶（含）；
  // 摘要挂到「起的前驱」——整段原位替换；前驱不在路径上时（异常调用）退回挂回起处自身。
  const attachCandidate: string | null = (target as { parentId?: string | null }).parentId ?? null;
  const attachId: string = attachCandidate && pathReaches(sm, attachCandidate) ? attachCandidate : target.id;
  const fromId = sm.getLeafId() ?? undefined;
  const slice = collectPath(sm, attachId);
  if (!slice.length) throw new Error("分支摘要跳过：区间内没有条目");
  const text = serializeEntries(slice);
  const model = sess.model;
  if (!model) throw new Error("分支摘要失败：会话无模型");

  const user = (opts.guide ? `相关性过滤：${opts.guide}\n\n---\n\n` : "") + `以下是要摘要的会话历史（${slice.length} 个条目）：\n\n${text}`;
  const response = await sess.modelRuntime.completeSimple(model, {
    systemPrompt: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: user, timestamp: Date.now() }],
  }, {
    maxTokens: 32768,
    ...(sess.thinkingLevel !== "off" ? { reasoning: sess.thinkingLevel } : {}),
    signal: AbortSignal.timeout(600_000),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`分支摘要模型调用失败：${response.errorMessage ?? response.stopReason}`);
  const summary = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!summary) throw new Error("分支摘要模型调用返回空内容");

  const summaryId = sm.branchWithSummary(attachId, summary, { guide: opts.guide?.slice(0, 300) }, true, response.usage);
  if (opts.summaryLabel) sm.appendLabelChange(summaryId, opts.summaryLabel);
  // 0.87 起 SessionManager 是 provider context 的唯一事实源；不要直接写 agent.state.messages。
  // refreshContext() 只刷新 AgentSession 的只读/检查缓存，下一次请求仍从 SessionManager 构建上下文。
  sess.refreshContext();
  return { summaryId, usage: response.usage, targetId: target.id, attachId, fromId, coveredIds: slice.map((e) => String(e.id)) };
}
