/**
 * hyp 工具 —— 风险假设（HYP）：create（编号自动 HYP-<tag>-H<n>）/ get / list / update（研判回写）。
 * 存储：system/hyp/<id>.json（工具独占）。body 建后不可改（修正进裁决追加）；状态 pending→running→closed。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  atomicWriteJSON, ensureDir, err, escapeRe, listDir, nextSerial, ok, paths, readJSON, rejectUnknown,
  type ToolBinding, type WsContext,
} from "./common.ts";
import { lineage } from "../ledger.ts";

export type HypStatus = "pending" | "running" | "closed";
export type HypConclusion = "" | "confirmed" | "refuted";

export interface HypRecord {
  id: string;
  tag: string;
  status: HypStatus;
  conclusion: HypConclusion;
  body: string;
  verdict: string;
  createdAt: string;
  updatedAt: string;
}

export function hypFiles(workdir: string): string[] {
  return listDir(paths.hypDir(workdir)).filter((f) => f.startsWith("HYP-") && f.endsWith(".json"));
}

export function hypIds(workdir: string): string[] {
  return hypFiles(workdir).map((f) => f.replace(/\.json$/, ""));
}

export function readHyp(workdir: string, id: string): HypRecord | null {
  return readJSON<HypRecord>(paths.hyp(workdir, id));
}

export function updateHyp(workdir: string, id: string, patch: Partial<HypRecord>): HypRecord | null {
  const rec = readHyp(workdir, id);
  if (!rec) return null;
  const out: HypRecord = { ...rec, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteJSON(paths.hyp(workdir, id), out);
  return out;
}

export function createHyp(workdir: string, tag: string, body: string): HypRecord {
  ensureDir(paths.hypDir(workdir));
  const n = nextSerial(hypFiles(workdir), new RegExp(`^HYP-${escapeRe(tag)}-H(\\d+)\\.json$`));
  const id = `HYP-${tag}-H${n}`;
  const now = new Date().toISOString();
  const rec: HypRecord = { id, tag, status: "pending", conclusion: "", body, verdict: "", createdAt: now, updatedAt: now };
  atomicWriteJSON(paths.hyp(workdir, id), rec);
  lineage(workdir, { action: "hyp.create", id, tag });
  return rec;
}

function excerpt(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function renderHyp(rec: HypRecord): string {
  const zh: Record<HypStatus, string> = { pending: "待判", running: "在判", closed: "办结" };
  return [
    `# ${rec.id}（${zh[rec.status]}${rec.conclusion ? ` / ${rec.conclusion}` : ""}）`,
    `created=${rec.createdAt} updated=${rec.updatedAt}`,
    `--- 正文 ---`,
    rec.body,
    ...(rec.verdict ? [`--- 裁决追加 ---`, rec.verdict] : []),
  ].join("\n");
}

export function makeHypTool(ws: WsContext, binding: ToolBinding): ToolDefinition {
  return defineTool({
    name: "hyp",
    label: "Hypothesis",
    description:
      "风险假设（HYP）管理。op：create（新建，编号自动）/ get（读全文+裁决）/ list（按 tag/status/conclusion 筛选）/ " +
      "update（研判回写：conclusion + verdict，写齐转办结）。正文由工具落盘，勿手改存储文件；引用其他 HYP 用工具返回的正式编号。",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "create / get / list / update" })),
      id: Type.Optional(Type.String({ description: "HYP 编号（get/update）" })),
      body: Type.Optional(Type.String({ description: "create 用：正文（漏洞主张 / 代码锚点 file:line / 风险类型 / 提出原因）" })),
      tag: Type.Optional(Type.String({ description: "list 筛选用：编号 tag（如 hunt1）" })),
      status: Type.Optional(Type.String({ description: "list 筛选用：pending/running/closed" })),
      conclusion: Type.Optional(Type.String({ description: "update 用：confirmed / refuted" })),
      verdict: Type.Optional(Type.String({ description: "update 用：研判裁决全文（追加，不覆盖历史）" })),
    }),
    async execute(_id, params) {
      const bad = rejectUnknown(params as Record<string, unknown>, ["op", "id", "body", "tag", "status", "conclusion", "verdict"]);
      if (bad) return err(bad);
      const op = String(params.op ?? "");

      if (op === "create") {
        if (typeof params.body !== "string" || !params.body.trim()) {
          return err('create 需要 body（正文：漏洞主张 / 代码锚点 file:line / 风险类型 / 提出原因）。示例：hyp({op:"create", body:"## 漏洞主张\\n…\\n**代码锚点**：src/x.c:123"})');
        }
        if (!binding.tag) return err(`create 需要会话绑定 tag（由 workflow 注入，如 hunt1）；本会话未绑定，无法编号。`);
        const rec = createHyp(ws.workdir, binding.tag, params.body);
        return ok(`已创建 ${rec.id}（system/hyp/${rec.id}.json，status=pending）。引用本假设时用此正式编号。`);
      }

      if (op === "get") {
        if (!params.id) return err(`get 需要 id。示例：hyp({op:"get", id:"HYP-hunt1-H1"})`);
        const rec = readHyp(ws.workdir, String(params.id));
        if (!rec) return err(`HYP ${params.id} 不存在。`);
        return ok(renderHyp(rec));
      }

      if (op === "list") {
        let recs = hypFiles(ws.workdir).map((f) => readHyp(ws.workdir, f.replace(/\.json$/, ""))).filter((r): r is HypRecord => !!r);
        if (params.tag !== undefined) recs = recs.filter((r) => r.tag === String(params.tag));
        if (params.status !== undefined) recs = recs.filter((r) => r.status === String(params.status));
        if (params.conclusion !== undefined) recs = recs.filter((r) => r.conclusion === String(params.conclusion));
        if (!recs.length) return ok("（无匹配 HYP）");
        const lines = recs.map((r) => `${r.id}  [${r.status}${r.conclusion ? `/${r.conclusion}` : ""}]  ${excerpt(r.body)}`);
        return ok(`${recs.length} 条：\n${lines.join("\n")}`);
      }

      if (op === "update") {
        if (!params.id) return err(`update 需要 id。`);
        const rec = readHyp(ws.workdir, String(params.id));
        if (!rec) return err(`HYP ${params.id} 不存在。`);
        const patch: Partial<HypRecord> = {};
        if (params.conclusion !== undefined) {
          if (params.conclusion !== "confirmed" && params.conclusion !== "refuted") {
            return err(`conclusion 只允许 confirmed / refuted（裁决结论：成立 / 不成立）。`);
          }
          patch.conclusion = params.conclusion;
        }
        if (params.verdict !== undefined) {
          if (!String(params.verdict).trim()) return err(`verdict 不能为空。`);
          patch.verdict = String(params.verdict);
        }
        if (!Object.keys(patch).length) return err(`update 需要 conclusion 和/或 verdict。示例：hyp({op:"update", id:"${rec.id}", conclusion:"refuted", verdict:"…"})`);
        const merged = { ...rec, ...patch };
        if (merged.conclusion && merged.verdict) patch.status = "closed";
        const out = updateHyp(ws.workdir, rec.id, patch)!;
        lineage(ws.workdir, { action: "hyp.update", id: rec.id, conclusion: out.conclusion, status: out.status });
        return ok(`已回写 ${out.id}：conclusion=${out.conclusion || "-"}，status=${out.status}。`);
      }

      return err(`hyp 支持 op：create / get / list / update。收到 op=${op || "（空）"}。`);
    },
  });
}
