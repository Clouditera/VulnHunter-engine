/**
 * finding 工具 —— 漏洞报告 + 证据附件（findings/<BUG>/record.json，工具独占）。
 *
 * create：仅 HYP 裁决 confirmed 时调用；编号继承 BUG-<链>（binding.hypId）；
 * update：与 create 同构字段表（全可选）＋状态机（poc/exp 迁移、finding_class 仅降级）、attachments 三操作；
 * get / list：读取。
 * attachments 字段值＝操作条目列表：add {file,kind,name?,note?} / update {aid,…} / delete {aid}；
 * 文件本体存 findings/<BUG>/attachments/（沙箱产物先 scp 回本地再 add）。
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  atomicWriteJSON, ensureDir, err, listDir, nextSerial, ok, paths, readJSON, rejectUnknown,
  type ToolBinding, type WsContext,
} from "./common.ts";
import { lineage } from "../ledger.ts";

export type FindingClass = "vulnerability" | "risk";
export type DynStatus = "pending" | "reproduced" | "fail-reproduced" | "blocked" | "not-needed";
export type AttachKind = "poc" | "exp";

export interface Attachment {
  aid: string; name: string; kind: AttachKind; note: string; size: number; addedAt: string; file: string;
}

export interface AttachmentOp {
  op: "add" | "update" | "delete";
  file?: string; kind?: AttachKind; name?: string; note?: string; aid?: string;
}

export interface FindingRecord {
  id: string; hyp: string;
  title: string; vuln_type: string; finding_class: FindingClass;
  cwe: string[]; cvss_vector: string; cvss_score: number;
  ev_vector: string; ev_score: number; ev_priority: string; ev_rationale: string;
  poc_status: DynStatus; exp_status: DynStatus; poc_evidence: string;
  affected_versions: string; summary: string; background: string;
  dataflow: unknown[]; reproduction: unknown | null; fix_patch: string; references: string[];
  attachments: Attachment[];
  createdAt: string; updatedAt: string;
}

export const DYN_TRANSITIONS: Record<DynStatus, DynStatus[]> = {
  pending: ["reproduced", "fail-reproduced", "blocked", "not-needed"],
  blocked: ["pending", "reproduced", "fail-reproduced", "not-needed"],
  reproduced: [], "fail-reproduced": [], "not-needed": [],
};

export const FINDING_CREATE_REQUIRED = [
  "title", "vuln_type", "finding_class", "cwe", "cvss_vector", "cvss_score",
  "ev_vector", "ev_score", "ev_priority", "ev_rationale", "affected_versions",
  "summary", "background", "dataflow", "references",
];

const CONTENT_KEYS = [
  "title", "vuln_type", "cwe", "cvss_vector", "cvss_score",
  "ev_vector", "ev_score", "ev_priority", "ev_rationale",
  "affected_versions", "summary", "background", "dataflow", "reproduction", "fix_patch", "references",
] as const;

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export function readFinding(workdir: string, id: string): FindingRecord | null {
  return readJSON<FindingRecord>(paths.finding(workdir, id));
}

export function listFindings(workdir: string): FindingRecord[] {
  const dir = join(workdir, "findings");
  return listDir(dir)
    .filter((d) => d.startsWith("BUG-"))
    .map((d) => readFinding(workdir, d))
    .filter((r): r is FindingRecord => !!r);
}

// ---------------------------------------------------------------------------
// attachments 三操作
// ---------------------------------------------------------------------------

function sanitizeName(n: string): string {
  const s = n.replace(/[^\w.\-]+/g, "_");
  return s || "file";
}

function applyAttachments(workdir: string, id: string, atts: Attachment[], ops: AttachmentOp[]): { error?: string; log: string[] } {
  const dir = paths.findingAttach(workdir, id);
  const log: string[] = [];
  for (const [i, raw] of ops.entries()) {
    const r = raw as unknown as Record<string, unknown>;
    const op = String(r.op ?? "");
    if (op === "add") {
      const file = String(r.file ?? "");
      if (!file || !existsSync(file)) return { error: `attachments[${i}]：add 需要存在的本地文件路径（收到 "${file || "（空）"}"）。沙箱产物先 scp 回本地再 add。`, log };
      if (r.kind !== "poc" && r.kind !== "exp") return { error: `attachments[${i}]：add 需要 kind=poc|exp`, log };
      const aid = `a${nextSerial(atts.map((a) => a.aid), /^a(\d+)$/)}`;
      const name = String(r.name ?? basename(file));
      const stored = `${aid}-${sanitizeName(name)}`;
      ensureDir(dir);
      copyFileSync(file, join(dir, stored));
      atts.push({ aid, name, kind: r.kind, note: String(r.note ?? ""), size: statSync(file).size, addedAt: new Date().toISOString(), file: stored });
      log.push(`+${aid}(${r.kind})`);
      continue;
    }
    if (op === "update") {
      const aid = String(r.aid ?? "");
      const a = atts.find((x) => x.aid === aid);
      if (!a) return { error: `attachments[${i}]：update 需要 aid（现有：${atts.map((x) => x.aid).join(",") || "无"}）`, log };
      if (r.kind !== undefined) {
        if (r.kind !== "poc" && r.kind !== "exp") return { error: `attachments[${i}]：kind 只允许 poc|exp`, log };
        a.kind = r.kind;
      }
      if (r.note !== undefined) a.note = String(r.note);
      if (r.file !== undefined) {
        const f = String(r.file);
        if (!existsSync(f)) return { error: `attachments[${i}]：替换文件不存在（${f}）`, log };
        const newName = r.name !== undefined ? String(r.name) : a.name;
        const stored = `${aid}-${sanitizeName(newName)}`;
        ensureDir(dir);
        copyFileSync(f, join(dir, stored));
        if (stored !== a.file) { try { rmSync(join(dir, a.file), { force: true }); } catch { /* 清旧失败无碍 */ } }
        a.file = stored; a.size = statSync(f).size;
        if (r.name !== undefined) a.name = newName;
      } else if (r.name !== undefined) {
        a.name = String(r.name);
      }
      log.push(`~${aid}`);
      continue;
    }
    if (op === "delete") {
      const aid = String(r.aid ?? "");
      const idx = atts.findIndex((x) => x.aid === aid);
      if (idx < 0) return { error: `attachments[${i}]：delete 需要 aid（现有：${atts.map((x) => x.aid).join(",") || "无"}）`, log };
      try { rmSync(join(dir, atts[idx].file), { force: true }); } catch { /* 同上 */ }
      atts.splice(idx, 1);
      log.push(`-${aid}`);
      continue;
    }
    return { error: `attachments[${i}]：op 只允许 add|update|delete（收到 "${op}"）`, log };
  }
  return { log };
}

// ---------------------------------------------------------------------------
// create / update
// ---------------------------------------------------------------------------

export function createFinding(workdir: string, hypId: string, f: Record<string, unknown>, attachOps?: AttachmentOp[]): { rec?: FindingRecord; error?: string } {
  const id = `BUG-${hypId.replace(/^HYP-/, "")}`;
  if (readFinding(workdir, id)) return { error: `finding ${id} 已存在——如需修改用 finding({op:"update", id:"${id}", …})。` };
  const cls = f.finding_class as FindingClass;
  const dyn: DynStatus = cls === "vulnerability" ? "pending" : "not-needed";
  const now = new Date().toISOString();
  const rec: FindingRecord = {
    id, hyp: hypId,
    title: String(f.title), vuln_type: String(f.vuln_type), finding_class: cls,
    cwe: f.cwe as string[], cvss_vector: String(f.cvss_vector), cvss_score: Number(f.cvss_score),
    ev_vector: String(f.ev_vector), ev_score: Number(f.ev_score), ev_priority: String(f.ev_priority), ev_rationale: String(f.ev_rationale),
    poc_status: dyn, exp_status: dyn, poc_evidence: "",
    affected_versions: String(f.affected_versions), summary: String(f.summary), background: String(f.background),
    dataflow: f.dataflow as unknown[], reproduction: (f.reproduction as unknown) ?? null,
    fix_patch: String(f.fix_patch ?? ""), references: f.references as string[],
    attachments: [],
    createdAt: now, updatedAt: now,
  };
  if (attachOps?.length) {
    const r = applyAttachments(workdir, id, rec.attachments, attachOps);
    if (r.error) return { error: r.error };
  }
  atomicWriteJSON(paths.finding(workdir, id), rec);
  lineage(workdir, { action: "finding.create", id, hyp: hypId, class: cls });
  return { rec };
}

export function updateFinding(workdir: string, id: string, p: Record<string, unknown>): { rec?: FindingRecord; changed?: string[]; error?: string } {
  const rec = readFinding(workdir, id);
  if (!rec) return { error: `finding ${id} 不存在。` };
  const changed: string[] = [];

  if (p.finding_class !== undefined) {
    if (!(rec.finding_class === "vulnerability" && p.finding_class === "risk")) {
      return { error: `finding_class 仅允许 vulnerability→risk 降级（当前 ${rec.finding_class}）` };
    }
    rec.finding_class = "risk"; rec.poc_status = "not-needed"; rec.exp_status = "not-needed";
    changed.push("finding_class");
  }

  for (const k of ["poc_status", "exp_status"] as const) {
    const v = p[k] as DynStatus | undefined;
    if (v === undefined) continue;
    const allowed = DYN_TRANSITIONS[rec[k]] ?? [];
    if (!allowed.includes(v)) return { error: `${k} 不允许 ${rec[k]} → ${v}（允许：${allowed.join("|") || "终态"}）` };
    rec[k] = v; changed.push(k);
  }

  if (p.poc_evidence !== undefined) { rec.poc_evidence = String(p.poc_evidence); changed.push("poc_evidence"); }

  for (const k of CONTENT_KEYS) {
    if (p[k] !== undefined) { (rec as any)[k] = p[k]; changed.push(k); }
  }

  if (p.attachments !== undefined) {
    const r = applyAttachments(workdir, id, rec.attachments, p.attachments as AttachmentOp[]);
    if (r.error) return { error: r.error };
    if (r.log.length) changed.push(`attachments[${r.log.join(" ")}]`);
  }

  if (!changed.length) return { error: "未提供任何待更新字段。" };
  rec.updatedAt = new Date().toISOString();
  atomicWriteJSON(paths.finding(workdir, id), rec);
  lineage(workdir, { action: "finding.update", id, changed });
  return { rec, changed };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const KNOWN = [
  "op", "id",
  ...FINDING_CREATE_REQUIRED, "reproduction", "fix_patch",
  "poc_status", "poc_evidence", "exp_status", "attachments",
];

function renderFinding(rec: FindingRecord): string {
  const atts = rec.attachments.length
    ? rec.attachments.map((a) => `${a.aid}(${a.kind}${a.note ? ` ${a.note}` : ""})`).join(" ")
    : "无";
  return [
    `# ${rec.id}（${rec.finding_class} | ${rec.ev_priority}）`,
    rec.title,
    `cvss=${rec.cvss_score}  poc_status=${rec.poc_status}  exp_status=${rec.exp_status}  附件：${atts}`,
    `--- record.json ---`,
    JSON.stringify(rec, null, 2),
  ].join("\n");
}

export function makeFindingTool(ws: WsContext, binding: ToolBinding): ToolDefinition {
  return defineTool({
    name: "finding",
    label: "Finding",
    description:
      "漏洞报告与证据附件。op：create（仅 HYP 裁决 confirmed 时；编号继承 BUG-<链>）/ update（同字段表全可选＋状态机）/ get / list。" +
      "字段规格固定（schema 外拒收）；attachments 为操作列表（add/update/delete）。存储由工具维护，勿手改。",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "create / update / get / list" })),
      id: Type.Optional(Type.String({ description: "BUG 编号（update/get）" })),
      title: Type.Optional(Type.String({ description: "一句话标题：受影响功能(按业务职责称呼)+漏洞类型+后果" })),
      vuln_type: Type.Optional(Type.String({ description: "类型简写（sqli/cmdi/bof/uaf/path/deser/…，见 bug-report 枚举表）" })),
      finding_class: Type.Optional(Type.Union([Type.Literal("vulnerability"), Type.Literal("risk")], { description: "vulnerability=正式漏洞；risk=前提苛刻/影响有限/弱点" })),
      cwe: Type.Optional(Type.Array(Type.String(), { description: 'CWE 编号列表，如 ["CWE-121"]' })),
      cvss_vector: Type.Optional(Type.String({ description: "CVSS v3.1 向量（用 cvss-calc.py 计算，禁手算）" })),
      cvss_score: Type.Optional(Type.Number()),
      ev_vector: Type.Optional(Type.String({ description: "EV 向量" })),
      ev_score: Type.Optional(Type.Number()),
      ev_priority: Type.Optional(Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")])),
      ev_rationale: Type.Optional(Type.String({ description: "EV 逐维度判断依据" })),
      affected_versions: Type.Optional(Type.String({ description: "受影响版本范围；未知写 unknown" })),
      summary: Type.Optional(Type.String({ description: "概览：一段读懂——缺陷位置/触发/后果/前提" })),
      background: Type.Optional(Type.String({ description: "业务背景：项目是什么/模块干什么/相关输入或数据" })),
      dataflow: Type.Optional(Type.Array(Type.Object({
        step: Type.Number(),
        location: Type.String({ description: "file:line（须经 grep 核实）" }),
        function: Type.Optional(Type.String()),
        role: Type.Optional(Type.String({ description: "source|propagation|sink；无数据流留空" })),
        snippet: Type.String({ description: "该 location 处真实代码原文（逐字复制）" }),
        description: Type.String(),
        flaw: Type.Optional(Type.String({ description: "根因步骤为何是缺陷" })),
      }, { additionalProperties: true }))),
      reproduction: Type.Optional(Type.Object({
        medium: Type.String(),
        preconditions: Type.Array(Type.String()),
        request: Type.String(),
        payload_variants: Type.Array(Type.String()),
        success_condition: Type.String(),
        notes: Type.String(),
      }, { additionalProperties: true })),
      fix_patch: Type.Optional(Type.String({ description: "diff --git a/ 开头的最小 unified diff；无法安全给出时省略" })),
      references: Type.Optional(Type.Array(Type.String())),
      poc_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("reproduced"), Type.Literal("fail-reproduced"), Type.Literal("blocked"), Type.Literal("not-needed")])),
      poc_evidence: Type.Optional(Type.String({ description: "复现证据（现象/日志摘要）" })),
      exp_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("reproduced"), Type.Literal("fail-reproduced"), Type.Literal("blocked"), Type.Literal("not-needed")])),
      attachments: Type.Optional(Type.Array(Type.Object({
        op: Type.String({ description: "add / update / delete" }),
        file: Type.Optional(Type.String({ description: "本地文件路径（add 必填；update 可作替换）" })),
        kind: Type.Optional(Type.Union([Type.Literal("poc"), Type.Literal("exp")])),
        name: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        aid: Type.Optional(Type.String({ description: "附件编号（update/delete 必填）" })),
      }, { additionalProperties: true }), { description: "附件操作列表（按序执行）" })),
    }),
    async execute(_id, params) {
      const bad = rejectUnknown(params as Record<string, unknown>, KNOWN);
      if (bad) return err(bad);
      const op = String(params.op ?? "");

      if (op === "create") {
        if (!binding.hypId) return err(`create 需要会话绑定 hypId（由 workflow 注入）——finding 编号继承 BUG-<链>。`);
        const missing = FINDING_CREATE_REQUIRED.filter((k) => (params as Record<string, unknown>)[k] === undefined);
        if (missing.length) return err(`create 缺必填字段：${missing.join(", ")}。字段规格见工具描述（评分用 cvss-calc.py）。`);
        const r = createFinding(ws.workdir, binding.hypId, params as Record<string, unknown>, params.attachments as AttachmentOp[] | undefined);
        if (r.error) return err(r.error);
        const atts = r.rec!.attachments.length ? `附件：${r.rec!.attachments.map((a) => a.aid).join(",")}。` : "";
        return ok(`已创建 findings/${r.rec!.id}/record.json（编号继承 ${binding.hypId}；poc_status=exp_status=${r.rec!.poc_status}）。${atts}`);
      }

      if (op === "update") {
        if (!params.id) return err(`update 需要 id。示例：finding({op:"update", id:"BUG-hunt1-H1", poc_status:"reproduced", poc_evidence:"…"})`);
        const p: Record<string, unknown> = {};
        for (const k of KNOWN) if (k !== "op" && k !== "id" && (params as Record<string, unknown>)[k] !== undefined) p[k] = (params as Record<string, unknown>)[k];
        const r = updateFinding(ws.workdir, String(params.id), p);
        if (r.error) return err(r.error);
        return ok(`已更新 ${params.id}：${r.changed!.join(", ")}。`);
      }

      if (op === "get") {
        if (!params.id) return err(`get 需要 id。`);
        const rec = readFinding(ws.workdir, String(params.id));
        if (!rec) return err(`finding ${params.id} 不存在。`);
        return ok(renderFinding(rec));
      }

      if (op === "list") {
        let recs = listFindings(ws.workdir);
        if (params.finding_class !== undefined) recs = recs.filter((r) => r.finding_class === params.finding_class);
        if (!recs.length) return ok("（无 finding）");
        const lines = recs.map((r) => `${r.id}  [${r.finding_class} | ${r.ev_priority}]  cvss=${r.cvss_score}  poc=${r.poc_status}  exp=${r.exp_status}  att=${r.attachments.length}  ${r.title}`);
        return ok(`${recs.length} 条：\n${lines.join("\n")}`);
      }

      return err(`finding 支持 op：create / update / get / list。收到 op=${op || "（空）"}。`);
    },
  });
}
