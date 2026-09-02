/**
 * 队列流转（workflow 代码机械执行，agent 不参与）：
 *   leads/（待消费）→ todo/（消费中，派发即移）→ done/（完成）
 *   异常结束 → 退回 leads/（可重派）
 * LEAD 路由：research→追加 research 运行；hunt→机械转 ADV 回池 B。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type QueueKind = "ADV" | "HYP" | "LEAD";

function dir(workdir: string, stage: "leads" | "todo" | "done"): string {
  const p = join(workdir, stage);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/** 待消费队列（leads/ 下某类文件，按编号排序） */
export function pending(workdir: string, kind: QueueKind): string[] {
  const re = new RegExp(`^${kind}-.+\\.md$`);
  return readdirSync(dir(workdir, "leads")).filter((f) => re.test(f)).sort();
}

/** 幂等移动：源不在就检查目的地；两边都没有才报错（agent 可能手动 mv 过队列文件） */
function move(workdir: string, file: string, from: "leads" | "todo", to: "todo" | "done" | "leads"): void {
  const src = join(dir(workdir, from), file);
  const dst = join(dir(workdir, to), file);
  if (existsSync(src)) { renameSync(src, dst); return; }
  if (existsSync(dst)) return; // 已被（agent 或上轮）移动过，视为已达终态
  console.warn(`[queue] 移动忽略：${file} 既不在 ${from}/ 也不在 ${to}/`);
}

/** 派发即移 todo/，返回 todo 内路径 */
export function toTodo(workdir: string, file: string): string {
  move(workdir, file, "leads", "todo");
  return join("todo", file);
}

export function toDone(workdir: string, file: string): void {
  move(workdir, file, "todo", "done");
}

/** 异常结束退回 leads/ */
export function backToLeads(workdir: string, file: string): void {
  move(workdir, file, "todo", "leads");
}

export interface LeadRoute { file: string; type: "research" | "hunt"; body: string }

/** 读 leads/LEAD-* 的 type 与正文 */
export function pendingLeads(workdir: string): LeadRoute[] {
  const out: LeadRoute[] = [];
  for (const f of pending(workdir, "LEAD")) {
    const raw = readFileSync(join(dir(workdir, "leads"), f), "utf-8");
    const m = raw.match(/^---\n[\s\S]*?type:\s*(research|hunt)[\s\S]*?\n---\n?([\s\S]*)$/);
    if (m) out.push({ file: f, type: m[1] as "research" | "hunt", body: m[2].trim() });
    else out.push({ file: f, type: "hunt", body: raw }); // 无 frontmatter 的容错：按 hunt 处理
  }
  return out;
}

export function markLeadDone(workdir: string, file: string): void {
  renameSync(join(dir(workdir, "leads"), file), join(dir(workdir, "done"), file));
}

/** LEAD(hunt) → ADV：机械转化，新 C 线号（内外部 ADV 不区分） */
export function leadToAdv(workdir: string, lead: LeadRoute, runNo: number): string {
  const advId = `ADV-C${runNo}-A1`;
  writeFileSync(join(dir(workdir, "leads"), `${advId}.md`), `# 转化自 ${lead.file.replace(/\.md$/, "")}\n\n${lead.body}\n`);
  markLeadDone(workdir, lead.file);
  return advId;
}
