/**
 * hyp 工具 —— 风险假设（HYP）：create（编号自动 HYP-<tag>-H<n>）/ get / list / update（研判回写）。
 * 存储：system/hyp/<id>.json（工具独占）。body 建后不可改（修正进裁决追加）；状态 pending→running→closed。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  atomicWriteJSON, ensureDir, err, escapeRe, listDir, nextSerial, ok, paths, readJSON, rejectUnknown,
  type ToolBinding, type WsContext,
} from "./common.ts";
import { lineage } from "../ledger.ts";

export type HypStatus = "pending" | "running" | "closed";
export type HypConclusion = "" | "confirmed" | "refuted";
export type HypConfidence = "high" | "med" | "low";

export interface HypRecord {
  id: string;
  tag: string;
  status: HypStatus;
  conclusion: HypConclusion;
  body: string;
  /** 与已有 HYP 的差异点（必填，空值/占位文本视为缺失） */
  noveltyBasis: string;
  /** 提出者自评把握度：high / med / low */
  confidence: HypConfidence;
  verdict: string;
  createdAt: string;
  updatedAt: string;
}

/** novelty_basis 缺失判定：空值或占位文本（TODO/N/A/待定 等无信息表述） */
export function isNoveltyBasisEmpty(s: string | undefined | null): boolean {
  if (!s) return true;
  const t = s.trim().toLowerCase();
  if (!t) return true;
  return /^(n\/?a|todo|tbd|none|null|-|——|待定|暂无|无|占位|unknown)$/.test(t);
}

/** 归一化：小写、路径分隔统一、去首尾空白 */
function norm(s: string): string {
  return s.toLowerCase().replace(/\\/g, "/").trim();
}

/** 从正文提取归一化靶点集合：file:line 锚点 + 函数名（标识符+括号） */
function targets(body: string): Set<string> {
  const out = new Set<string>();
  const b = norm(body);
  for (const m of b.matchAll(/([\w./-]+\.(?:c|cc|cpp|cxx|h|hpp|rs|go|py|js|ts|java|php|rb))\s*:\s*(\d+)/g)) {
    out.add(`file:${m[1]}:${m[2]}`);
  }
  for (const m of b.matchAll(/([a-z_]\w{1,60})\s*\(/g)) out.add(`fn:${m[1]}`);
  return out;
}

/** 漏洞模式词表：同族别名归并到一个类别键 */
const VULN_CLASSES: Record<string, string[]> = {
  "cwe-89": ["cwe-89", "sql 注入", "sql注入", "sqli", "sql injection"],
  "cwe-79": ["cwe-79", "xss", "跨站脚本"],
  "cwe-22": ["cwe-22", "路径穿越", "路径遍历", "path traversal", "目录穿越"],
  "cwe-787": ["cwe-787", "cwe-120", "cwe-121", "cwe-122", "缓冲区溢出", "buffer overflow", "栈溢出", "堆溢出", "out-of-bounds", "oob"],
  "cwe-78": ["cwe-78", "命令注入", "command injection", "os command"],
  "cwe-502": ["cwe-502", "反序列化", "deserialization"],
  "cwe-416": ["cwe-416", "use-after-free", "uaf", "释放后使用"],
  "cwe-125": ["cwe-125", "越界读", "out-of-bounds read"],
  "cwe-190": ["cwe-190", "整数溢出", "integer overflow"],
  "cwe-611": ["cwe-611", "xxe"],
  "cwe-918": ["cwe-918", "ssrf"],
  "cwe-94": ["cwe-94", "代码注入", "code injection", "模版注入", "模板注入", "ssti"],
  "cwe-798": ["cwe-798", "硬编码", "hardcoded"],
  "cwe-362": ["cwe-362", "竞态", "race condition", "toctou"],
  "cwe-401": ["cwe-401", "内存泄漏", "memory leak"],
  "cwe-476": ["cwe-476", "空指针", "null pointer"],
};

/** 从正文提取漏洞类别集合（CWE 编号 + 模式词表命中） */
function vulnClasses(body: string): Set<string> {
  const b = norm(body);
  const out = new Set<string>();
  for (const m of b.matchAll(/cwe[-\s]?(\d{1,4})/g)) out.add(`cwe-${m[1]}`);
  for (const [cls, words] of Object.entries(VULN_CLASSES)) {
    if (words.some((w) => b.includes(w))) out.add(cls);
  }
  return out;
}

/** 同靶点：归一化后的函数名 / file:line 有交集 */
export function sameTarget(a: { body: string }, b: { body: string }): boolean {
  const ta = targets(a.body), tb = targets(b.body);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

/** 同漏洞模式：CWE 标签 / 模式词表类别有交集 */
export function sameVulnClass(a: { body: string }, b: { body: string }): boolean {
  const ca = vulnClasses(a.body), cb = vulnClasses(b.body);
  for (const c of ca) if (cb.has(c)) return true;
  return false;
}

/**
 * 相似度单点接口（0..1）：第一版 = 规则实现（同靶点+同类=1，同靶点或同类=0.5，否则 0）。
 * 后续换语义向量等实现时只改本函数，admit() 判定逻辑不动。
 */
export function similarity(a: { body: string }, b: { body: string }): number {
  const t = sameTarget(a, b), c = sameVulnClass(a, b);
  return t && c ? 1 : t || c ? 0.5 : 0;
}

export type AdmitVerdict = "ADMIT" | "REJECT_DUP" | "REJECT_LOW_QUALITY";

/** 入库前准入闸（HALL-64 §2.2）：同靶点+同类去重；low 且无差异点判低质 */
export function admit(newHyp: { body: string; confidence: string; novelty_basis?: string }, existing: Array<{ body: string }>): AdmitVerdict {
  for (const h of existing) {
    if (sameTarget(h, newHyp) && sameVulnClass(h, newHyp)) return "REJECT_DUP";
  }
  if (newHyp.confidence === "low" && isNoveltyBasisEmpty(newHyp.novelty_basis)) return "REJECT_LOW_QUALITY";
  return "ADMIT";
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

export interface HypDraft {
  body: string;
  noveltyBasis: string;
  confidence: HypConfidence;
}

/** 被拒 HYP 留痕：.vulnforge/rejected_hyps.log（含理由；不进 chains、不计新增） */
export function logRejected(workdir: string, tag: string, draft: HypDraft, reason: AdmitVerdict): void {
  const rec = { ts: new Date().toISOString(), tag, reason, confidence: draft.confidence, noveltyBasis: draft.noveltyBasis, body: draft.body };
  ensureDir(workdir);
  appendFileSync(join(workdir, "rejected_hyps.log"), JSON.stringify(rec) + "\n");
}

export function createHyp(workdir: string, tag: string, draft: HypDraft): HypRecord {
  ensureDir(paths.hypDir(workdir));
  const n = nextSerial(hypFiles(workdir), new RegExp(`^HYP-${escapeRe(tag)}-H(\\d+)\\.json$`));
  const id = `HYP-${tag}-H${n}`;
  const now = new Date().toISOString();
  const rec: HypRecord = { id, tag, status: "pending", conclusion: "", verdict: "", createdAt: now, updatedAt: now, ...draft };
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
    `created=${rec.createdAt} updated=${rec.updatedAt} confidence=${rec.confidence}`,
    `novelty_basis：${rec.noveltyBasis}`,
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
      "风险假设（HYP）管理。op：create（新建，编号自动；必填 novelty_basis 差异点说明 + confidence 自评 high/med/low；" +
      "入库前过准入闸：同靶点+同漏洞模式判 REJECT_DUP，low 且无差异点判 REJECT_LOW_QUALITY，被拒仅留痕不入库）/ " +
      "get（读全文+裁决）/ list（按 tag/status/conclusion 筛选）/ " +
      "update（研判回写：conclusion + verdict，写齐转办结）。正文由工具落盘，勿手改存储文件；引用其他 HYP 用工具返回的正式编号。",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "create / get / list / update" })),
      id: Type.Optional(Type.String({ description: "HYP 编号（get/update）" })),
      body: Type.Optional(Type.String({ description: "create 用：正文（漏洞主张 / 代码锚点 file:line / 风险类型 / 提出原因）" })),
      novelty_basis: Type.Optional(Type.String({ description: "create 必填：与已有 HYP 的具体差异点（如「与 HYP-x 不同在于…」）；空值/占位文本视为缺失" })),
      confidence: Type.Optional(Type.String({ description: "create 必填：自评把握度 high / med / low" })),
      tag: Type.Optional(Type.String({ description: "list 筛选用：编号 tag（如 hunt1）" })),
      status: Type.Optional(Type.String({ description: "list 筛选用：pending/running/closed" })),
      conclusion: Type.Optional(Type.String({ description: "update 用：confirmed / refuted" })),
      verdict: Type.Optional(Type.String({ description: "update 用：研判裁决全文（追加，不覆盖历史）" })),
    }),
    async execute(_id, params) {
      const bad = rejectUnknown(params as Record<string, unknown>, ["op", "id", "body", "novelty_basis", "confidence", "tag", "status", "conclusion", "verdict"]);
      if (bad) return err(bad);
      const op = String(params.op ?? "");

      if (op === "create") {
        if (typeof params.body !== "string" || !params.body.trim()) {
          return err('create 需要 body（正文：漏洞主张 / 代码锚点 file:line / 风险类型 / 提出原因）。示例：hyp({op:"create", body:"## 漏洞主张\\n…\\n**代码锚点**：src/x.c:123", novelty_basis:"首个涉及 xx 函数 yy 模式的假设", confidence:"med"})');
        }
        if (isNoveltyBasisEmpty(typeof params.novelty_basis === "string" ? params.novelty_basis : undefined)) {
          return err('create 需要 novelty_basis（与已有 HYP 的具体差异点，如「与 HYP-x 不同在于…」或「首个涉及 xx 函数 yy 模式的假设」）；空值/占位文本视为缺失。');
        }
        const conf = String(params.confidence ?? "");
        if (conf !== "high" && conf !== "med" && conf !== "low") {
          return err(`create 需要 confidence（high / med / low，自评把握度）。收到：${params.confidence ?? "（缺）"}`);
        }
        if (!binding.tag) return err(`create 需要会话绑定 tag（由 workflow 注入，如 hunt1）；本会话未绑定，无法编号。`);
        const draft: HypDraft = { body: params.body, noveltyBasis: String(params.novelty_basis).trim(), confidence: conf };
        // 入库前准入闸（HALL-64 §2.2）：被拒留痕 .vulnforge/rejected_hyps.log，不进 chains、不计新增、不占编号
        const existing = hypFiles(ws.workdir).map((f) => readHyp(ws.workdir, f.replace(/\.json$/, ""))).filter((r): r is HypRecord => !!r);
        const verdict0 = admit({ body: draft.body, confidence: draft.confidence, novelty_basis: draft.noveltyBasis }, existing);
        if (verdict0 !== "ADMIT") {
          logRejected(ws.workdir, binding.tag, draft, verdict0);
          lineage(ws.workdir, { action: "hyp.reject", tag: binding.tag, reason: verdict0 });
          const why = verdict0 === "REJECT_DUP"
            ? "与已有 HYP 同靶点 + 同漏洞模式（变体）"
            : "confidence=low 且 novelty_basis 缺失（低质假设）";
          return err(`准入闸拒绝（${verdict0}）：${why}。已留痕 rejected_hyps.log，未入库；请换一个真正新的假设再提。`);
        }
        const rec = createHyp(ws.workdir, binding.tag, draft);
        return ok(`已创建 ${rec.id}（system/hyp/${rec.id}.json，status=pending，confidence=${rec.confidence}）。引用本假设时用此正式编号。`);
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
