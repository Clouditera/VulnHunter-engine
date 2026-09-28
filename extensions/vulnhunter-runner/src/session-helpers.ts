import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionCtx } from "./session.ts";
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
    `工作区根目录：${ctx.workdir}（任务里的产物相对路径——knowledge/ findings/ system/ 等——都以它为基准）`,
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
export function findTaskStart(sm: SessionManager, preLeaf: string | null, endEntry?: string): string | undefined {
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
