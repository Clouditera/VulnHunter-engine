/**
 * 产物操作函数层（8 个）——结构化产物的唯一写入通道。
 *
 * 约定（docs/runner-design.md §4）：
 *   - emit_*  创建类：不给 id，编号函数内取（线别/继承链由 binding 绑死）
 *   - update_* 更新类：必须给 id，参数缺省 = 该字段保持不变
 *   - 返回值统一：落盘路径+编号 + 摘要 + frontmatter 提示
 *   - 校验在调用时：枚举/状态机不合法当场打回（isError）
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const HINT = "提示：结构化字段由函数维护，勿直接编辑 frontmatter/report.yaml 字段；正文部分可用 edit 自由补充。";

export interface WsContext {
  /** 工作区根 <cwd>/.vulnforge */
  workdir: string;
  /** 目标项目根 */
  cwd: string;
}

/** 节点绑定的编号上下文（runner 拉起节点时注入） */
export interface FnBinding {
  /** cognize/research 的运行序号（emit_adv 取号用） */
  runNo?: number;
  /** hunt 正在消费的 ADV id（emit_hyp 继承编号用），如 ADV-C1-A2 */
  advId?: string;
  /** verify 正在研判的 HYP id（emit_finding 继承编号用），如 HYP-C1-A2-H3 */
  hypId?: string;
}

export type FnKind =
  | "emit_adv_c" | "emit_adv_s"          // C 线（cognize）/ S 线（research）
  | "emit_hyp" | "emit_lead" | "emit_finding"
  | "update_finding" | "update_build_state" | "update_profiler";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}
function ensureDir(p: string) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

/** 全局取号：扫 dir 中匹配 prefix 的文件，取最大序号 +1 */
function nextSerial(dirs: string[], re: RegExp): number {
  let max = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}

/** 队列三目录（编号占用判定要覆盖已流转走的文件） */
function queueDirs(ws: WsContext): string[] {
  return [join(ws.workdir, "leads"), join(ws.workdir, "todo"), join(ws.workdir, "done")];
}

// ---------------------------------------------------------------------------
// emit_adv —— 审计链路（纯散文，无 frontmatter；线别 C/S 由 binding 绑死）
// ---------------------------------------------------------------------------

function makeEmitAdv(ws: WsContext, line: "C" | "S", runNo: number): ToolDefinition {
  let seq = nextSerial(queueDirs(ws), new RegExp(`^ADV-${line}${runNo}-A(\\d+)\\.md$`)) - 1;
  return defineTool({
    name: "emit_adv",
    label: "Emit ADV",
    description: "产出一条审计链路（ADV）。正文为自由 markdown（建议含：审计链路/锚点/认知依据/关注的威胁）。编号自动分配。",
    parameters: Type.Object({
      body: Type.String({ description: "ADV 正文（自由 markdown）" }),
    }),
    async execute(_id, params) {
      seq++;
      const advId = `ADV-${line}${runNo}-A${seq}`;
      ensureDir(join(ws.workdir, "leads"));
      const p = join(ws.workdir, "leads", `${advId}.md`);
      writeFileSync(p, params.body + "\n");
      return ok(`已创建 leads/${advId}.md（编号 ${advId}）。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// emit_hyp —— 风险假设（纯散文；编号继承 binding.advId）
// ---------------------------------------------------------------------------

function makeEmitHyp(ws: WsContext, advId: string): ToolDefinition {
  const chain = advId.replace(/^ADV-/, ""); // C1-A2
  // 初始序号取该链已有 HYP 最大号（防同 ADV 重跑/重试时覆盖已有 HYP）
  let seq = nextSerial(queueDirs(ws), new RegExp(`^HYP-${chain}-H(\\d+)\\.md$`)) - 1;
  return defineTool({
    name: "emit_hyp",
    label: "Emit HYP",
    description: `产出一条风险假设（HYP），编号自动继承当前审计链路 ${advId}。正文：漏洞主张、代码锚点、风险类型、提出原因。一条链路可多次调用产多条。`,
    parameters: Type.Object({
      body: Type.String({ description: "HYP 正文（自由 markdown）" }),
    }),
    async execute(_id, params) {
      seq++;
      const hypId = `HYP-${chain}-H${seq}`;
      ensureDir(join(ws.workdir, "leads"));
      const p = join(ws.workdir, "leads", `${hypId}.md`);
      writeFileSync(p, params.body + "\n");
      return ok(`已创建 leads/${hypId}.md（编号 ${hypId}）。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// emit_lead —— 回流线索（frontmatter 仅留 type，workflow 路由要解析）
// ---------------------------------------------------------------------------

function makeEmitLead(ws: WsContext): ToolDefinition {
  return defineTool({
    name: "emit_lead",
    label: "Emit Lead",
    description: "产出一条回流线索（LEAD）：本节点无法闭环、需要后续跟进的问题。type 供工作流路由。",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("research"), Type.Literal("hunt")], { description: "research=补充检索；hunt=转审计链路继续挖" }),
      body: Type.String({ description: "线索正文（自由 markdown，写明问题与锚点）" }),
    }),
    async execute(_id, params) {
      const leadsDir = join(ws.workdir, "leads");
      ensureDir(leadsDir);
      const n = nextSerial(queueDirs(ws), /^LEAD-L(\d+)\.md$/);
      const leadId = `LEAD-L${n}`;
      const p = join(leadsDir, `${leadId}.md`);
      writeFileSync(p, `---\nid: ${leadId}\ntype: ${params.type}\n---\n\n${params.body}\n`);
      return ok(`已创建 leads/${leadId}.md（type: ${params.type}）。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// emit_finding —— 漏洞报告（对齐 bug-report 四段式模板；编号继承 binding.hypId）
// ---------------------------------------------------------------------------

function makeEmitFinding(ws: WsContext, hypId: string): ToolDefinition {
  const chain = hypId.replace(/^HYP-/, ""); // C1-A2-H3
  const bugId = `BUG-${chain}`;
  return defineTool({
    name: "emit_finding",
    label: "Emit Finding",
    description: `产出漏洞报告（findings/${bugId}/report.yaml）。字段对齐 bug-report 模板；finding_class=vulnerability 时 poc_status/exp_status 自动置 pending。仅当前 HYP 裁决 confirmed 时调用。`,
    parameters: Type.Object({
      title: Type.String({ description: "一句话标题：受影响功能(按业务职责称呼)+漏洞类型+后果" }),
      vuln_type: Type.String({ description: "类型简写（sqli/cmdi/bof/uaf/path/deser/... 见 bug-report 枚举表）" }),
      finding_class: Type.Union([Type.Literal("vulnerability"), Type.Literal("risk")], { description: "vulnerability=正式漏洞；risk=前提苛刻/影响有限/弱点" }),
      cwe: Type.Array(Type.String(), { description: "CWE 编号列表，如 [\"CWE-121\"]" }),
      cvss_vector: Type.String({ description: "CVSS v3.1 向量（用 cvss-calc.py 计算）" }),
      cvss_score: Type.Number({ description: "CVSS v3.1 基础分数" }),
      ev_vector: Type.String({ description: "EV 向量" }),
      ev_score: Type.Number(),
      ev_priority: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
      ev_rationale: Type.String({ description: "EV 逐维度判断依据" }),
      affected_versions: Type.String({ description: "受影响版本范围；未知写 unknown" }),
      summary: Type.String({ description: "概览：一段读懂——缺陷位置/触发/后果/前提" }),
      background: Type.String({ description: "业务背景：项目是什么/模块干什么/相关输入或数据" }),
      dataflow: Type.Array(Type.Object({
        step: Type.Number(),
        location: Type.String({ description: "file:line" }),
        function: Type.Optional(Type.String()),
        role: Type.Optional(Type.String({ description: "source|propagation|sink；无数据流留空" })),
        snippet: Type.String({ description: "该 location 处真实代码原文（逐字复制）" }),
        description: Type.String(),
        flaw: Type.Optional(Type.String({ description: "根因步骤为何是缺陷" })),
      })),
      reproduction: Type.Optional(Type.Object({
        medium: Type.String(),
        preconditions: Type.Array(Type.String()),
        request: Type.String(),
        payload_variants: Type.Array(Type.String()),
        success_condition: Type.String(),
        notes: Type.String(),
      })),
      fix_patch: Type.Optional(Type.String({ description: "diff --git a/ 开头的最小 unified diff；无法安全给出时省略" })),
      references: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      const dir = join(ws.workdir, "findings", bugId);
      if (existsSync(join(dir, "report.yaml"))) return err(`finding ${bugId} 已存在——如需修改用 update_finding({id: "${bugId}", ...})。`);
      ensureDir(dir);
      const dynamic = params.finding_class === "vulnerability" ? "pending" : "not-needed";
      const report = {
        metadata: {
          title: params.title, vuln_type: params.vuln_type, finding_class: params.finding_class,
          cwe: params.cwe, cvss_vector: params.cvss_vector, cvss_score: params.cvss_score,
          ev_vector: params.ev_vector, ev_score: params.ev_score, ev_priority: params.ev_priority, ev_rationale: params.ev_rationale,
          poc_status: dynamic, exp_status: dynamic, affected_versions: params.affected_versions,
        },
        description: { summary: params.summary, background: params.background },
        code: { dataflow: params.dataflow, ...(params.reproduction ? { reproduction: params.reproduction } : {}), fix_patch: params.fix_patch ?? "" },
        references: params.references,
      };
      writeFileSync(join(dir, "report.yaml"), YAML.stringify(report));
      return ok(`已创建 findings/${bugId}/report.yaml（编号继承 ${hypId}；poc_status/exp_status=${dynamic}）。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// update_finding —— 按编号更新（状态机校验）
// ---------------------------------------------------------------------------

const POC_TRANSITIONS: Record<string, string[]> = {
  pending: ["reproduced", "fail-reproduced", "blocked", "not-needed"],
  blocked: ["pending", "reproduced", "fail-reproduced", "not-needed"],
  reproduced: [], "fail-reproduced": [], "not-needed": [],
};

function makeUpdateFinding(ws: WsContext): ToolDefinition {
  return defineTool({
    name: "update_finding",
    label: "Update Finding",
    description: "按编号更新 finding（poc/exp 状态与证据、EV 字段、降级等）。参数缺省=该字段保持不变。",
    parameters: Type.Object({
      id: Type.String({ description: "finding 编号，如 BUG-C1-A2-H3" }),
      poc_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("reproduced"), Type.Literal("fail-reproduced"), Type.Literal("blocked"), Type.Literal("not-needed")])),
      poc_evidence: Type.Optional(Type.String({ description: "复现证据（现象/日志摘要）" })),
      exp_status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("reproduced"), Type.Literal("fail-reproduced"), Type.Literal("blocked"), Type.Literal("not-needed")])),
      ev_score: Type.Optional(Type.Number()),
      ev_priority: Type.Optional(Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")])),
      ev_rationale: Type.Optional(Type.String()),
      finding_class: Type.Optional(Type.Union([Type.Literal("vulnerability"), Type.Literal("risk")], { description: "仅允许 vulnerability→risk 降级" })),
    }),
    async execute(_id, params) {
      const p = join(ws.workdir, "findings", params.id, "report.yaml");
      if (!existsSync(p)) return err(`finding ${params.id} 不存在（${p}）。`);
      const doc = YAML.parse(readFileSync(p, "utf-8"));
      const md = doc.metadata;
      const changed: string[] = [];
      const fail = (m: string) => err(`更新 ${params.id} 被拒绝：${m}`);

      if (params.poc_status !== undefined) {
        const allowed = POC_TRANSITIONS[md.poc_status] ?? [];
        if (!allowed.includes(params.poc_status)) return fail(`poc_status 不允许 ${md.poc_status} → ${params.poc_status}`);
        md.poc_status = params.poc_status; changed.push("poc_status");
      }
      if (params.exp_status !== undefined) {
        const allowed = POC_TRANSITIONS[md.exp_status] ?? [];
        if (!allowed.includes(params.exp_status)) return fail(`exp_status 不允许 ${md.exp_status} → ${params.exp_status}`);
        md.exp_status = params.exp_status; changed.push("exp_status");
      }
      if (params.finding_class !== undefined) {
        if (!(md.finding_class === "vulnerability" && params.finding_class === "risk")) return fail(`finding_class 仅允许 vulnerability→risk（当前 ${md.finding_class}）`);
        md.finding_class = params.finding_class;
        if (params.finding_class === "risk") { md.poc_status = "not-needed"; md.exp_status = "not-needed"; }
        changed.push("finding_class");
      }
      for (const k of ["poc_evidence", "ev_score", "ev_priority", "ev_rationale"] as const) {
        if (params[k] !== undefined) { md[k] = params[k]; changed.push(k); }
      }
      if (!changed.length) return err("未提供任何待更新字段。");
      writeFileSync(p, YAML.stringify(doc));
      return ok(`已更新 ${params.id}：${changed.join(", ")}。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// update_build_state —— 沙箱/构建状态（knowledge/build/build.md）
// ---------------------------------------------------------------------------

function makeUpdateBuildState(ws: WsContext): ToolDefinition {
  return defineTool({
    name: "update_build_state",
    label: "Update Build State",
    description: "更新动态环境状态（knowledge/build/build.md）。status 为沙箱可用性，workflow 据此判定动态验证门禁。",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal("available"), Type.Literal("unavailable")], { description: "沙箱可用性" })),
      body: Type.Optional(Type.String({ description: "环境说明正文（工具链/配置/问题记录），给定则整体替换正文" })),
    }),
    async execute(_id, params) {
      const dir = join(ws.workdir, "knowledge", "build");
      ensureDir(dir);
      const p = join(dir, "build.md");
      let status: string | undefined;
      let body = "";
      if (existsSync(p)) {
        const m = readFileSync(p, "utf-8").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (m) { status = YAML.parse(m[1])?.sandbox; body = m[2].trim(); }
      }
      if (params.status !== undefined) status = params.status;
      if (params.body !== undefined) body = params.body;
      if (status === undefined && !params.body) return err("首次调用至少给 status 或 body 之一。");
      writeFileSync(p, `---\nsandbox: ${status ?? "unknown"}\nupdated: ${new Date().toISOString()}\n---\n\n${body}\n`);
      return ok(`已更新 knowledge/build/build.md（sandbox: ${status ?? "unknown"}）。${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// update_profiler —— 项目画像分节深合并（knowledge/profiler.yaml）
// ---------------------------------------------------------------------------

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    return out;
  }
  return b;
}

function makeUpdateProfiler(ws: WsContext): ToolDefinition {
  return defineTool({
    name: "update_profiler",
    label: "Update Profiler",
    description: "分节更新项目画像（knowledge/profiler.yaml）。每节一个参数，给值的节深合并更新，缺省的节保持不变；可分多次调用逐步补齐。",
    parameters: Type.Object({
      language: Type.Optional(Type.Array(Type.String())),
      frameworks: Type.Optional(Type.Array(Type.String())),
      entrypoints: Type.Optional(Type.Array(Type.String())),
      modules: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String(), role: Type.String() }))),
      build: Type.Optional(Type.Object({ system: Type.Optional(Type.String()), commands: Type.Optional(Type.String()) })),
    }),
    async execute(_id, params) {
      const dir = join(ws.workdir, "knowledge");
      ensureDir(dir);
      const p = join(dir, "profiler.yaml");
      const cur = existsSync(p) ? (YAML.parse(readFileSync(p, "utf-8")) ?? {}) : {};
      const given: Record<string, unknown> = {};
      for (const k of ["language", "frameworks", "entrypoints", "modules", "build"] as const)
        if (params[k] !== undefined) given[k] = params[k];
      if (!Object.keys(given).length) return err("未提供任何字段组。");
      const merged = deepMerge(cur, given);
      writeFileSync(p, YAML.stringify(merged));
      const missing = ["language", "frameworks", "entrypoints", "modules", "build"].filter((k) => !(k in merged));
      return ok(`已更新 profiler.yaml：${Object.keys(given).join(", ")}。${missing.length ? `尚未填写：${missing.join(", ")}。` : "各节齐全。"}${HINT}`);
    },
  });
}

// ---------------------------------------------------------------------------
// 工厂：按 FnKind + binding 组装节点的函数集
// ---------------------------------------------------------------------------

export function makeNodeTools(ws: WsContext, kinds: FnKind[], binding: FnBinding): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const k of kinds) {
    switch (k) {
      case "emit_adv_c":
      case "emit_adv_s": {
        if (binding.runNo === undefined) throw new Error(`${k} 需要 binding.runNo`);
        out.push(makeEmitAdv(ws, k === "emit_adv_c" ? "C" : "S", binding.runNo));
        break;
      }
      case "emit_hyp": {
        if (!binding.advId) throw new Error("emit_hyp 需要 binding.advId");
        out.push(makeEmitHyp(ws, binding.advId));
        break;
      }
      case "emit_lead": out.push(makeEmitLead(ws)); break;
      case "emit_finding": {
        if (!binding.hypId) throw new Error("emit_finding 需要 binding.hypId");
        out.push(makeEmitFinding(ws, binding.hypId));
        break;
      }
      case "update_finding": out.push(makeUpdateFinding(ws)); break;
      case "update_build_state": out.push(makeUpdateBuildState(ws)); break;
      case "update_profiler": out.push(makeUpdateProfiler(ws)); break;
    }
  }
  return out;
}
