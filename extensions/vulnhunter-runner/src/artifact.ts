/**
 * artifact 元工具（docs/artifact-tool-design.md，fish 2026-09-08 发起并裁定）。
 *
 * 动机：切任务不换工具集（工具定义恒定 → KV cache 稳定），产物操作全部收敛到一个工具。
 * 权限模型：放开——不做节点级白名单，任务书指明该任务可用的 (op, type)；失控时的回退开关见
 *           环境变量 VULNFORGE_ARTIFACT_ALLOW='{"hunt":["create hyp"]}'（按节点过滤，默认不启用）。
 *
 * op 语义（仿 HTTP 动词分层）：
 *   query  ≈ GET    读产物/状态（coverage、列队、定点读 finding）
 *   create ≈ POST   新建产物（adv/hyp/lead/finding；编号自动/继承会话 binding）
 *   update ≈ PATCH  按 id 更新（finding/build-state/profiler）
 *   spec   ≈ OPTIONS 返回某 type 的权威字段规格（照填即生效）
 *   list   ≈ GET /meta 列全部可用 (op, type)
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeEmitAdv, makeEmitHyp, makeEmitLead, makeEmitFinding,
  makeUpdateFinding, makeUpdateBuildState, makeUpdateProfiler,
  type FnBinding, type WsContext,
} from "./workspace-tools.ts";
import {
  getCoveragePaths, loadCoverageMap, aggregateCoverageEvents, persistCoverageMap,
  renderCoverage, loadScope, perScopeStats,
} from "../node-ext/code-coverage/coverage-core.ts";

// ---------------------------------------------------------------------------
// 权威字段规格（spec op 的返回内容；校验也用同一份）
// ---------------------------------------------------------------------------

interface FieldSpec { type: string; required?: boolean; desc?: string; enum?: string[]; example?: unknown }
interface TypeSpec { ops: string[]; fields?: Record<string, FieldSpec>; notes?: string; example?: Record<string, unknown> }

const SPECS: Record<string, TypeSpec> = {
  adv: {
    ops: ["create", "query"],
    fields: {
      body: { type: "string(md)", required: true, desc: "ADV 正文。约定含：审计链路/锚点/认知依据/关注的威胁。编号自动分配。" },
    },
    example: { op: "create", type: "adv", fields: { body: "## 审计链路\n…\n## 锚点\nsrc/x.c:123\n…" } },
  },
  hyp: {
    ops: ["create", "query"],
    fields: {
      body: { type: "string(md)", required: true, desc: "HYP 正文。约定含：漏洞主张/代码锚点(file:line)/风险类型/提出原因。编号由工具自动分配（HYP-<来源>-H<n>），创建返回值为准；正文标题不要自写编号（引用其他 HYP 时用返回的正式编号）。" },
    },
    example: { op: "create", type: "hyp", fields: { body: "## 漏洞主张\nXACKDEL 静态数组栈溢出…\n**代码锚点**：src/t_stream.c:1234" } },
  },
  lead: {
    ops: ["create", "query"],
    fields: {
      type: { type: "string", required: true, desc: "research=补充检索；hunt=转审计链路继续挖", enum: ["research", "hunt"] },
      body: { type: "string(md)", required: true, desc: "线索正文（问题与锚点）" },
    },
    example: { op: "create", type: "lead", fields: { type: "research", body: "该模块疑似使用过期解析库，需检索已知 CVE。" } },
  },
  finding: {
    ops: ["create", "update", "query"],
    fields: {
      title: { type: "string", required: true, desc: "受影响功能(业务职责称呼)+漏洞类型+后果" },
      vuln_type: { type: "string", required: true, desc: "类型简写（sqli/cmdi/bof/oob-read/oob-write/uaf/null-deref/int-overflow/path/deser/…；可自由扩展，建议对齐 CWE 名）" },
      finding_class: { type: "string", required: true, enum: ["vulnerability", "risk"], desc: "vulnerability=正式漏洞；risk=前提苛刻/影响有限/弱点" },
      cwe: { type: "array<string>", required: true, desc: "CWE 编号列表", example: ["CWE-121"] },
      cvss_vector: { type: "string", required: true, desc: "CVSS v3.1 向量" },
      cvss_score: { type: "number", required: true, desc: "CVSS v3.1 基础分" },
      ev_vector: { type: "string", required: true, desc: 'EV 向量，格式 EV:1.0/R:{N|M|L|P}/E:{D|C|R|P}/C:{D|F|T}/I:{X|S|D}（Reachability/Exposure/Certainty/Impact，枚举值以 skills/bug-report/exploit-value-guide.md 为准）；用引擎仓 python3 skills/bug-report/cvss-calc.py 计算，禁止手算' },
      ev_score: { type: "number", required: true, desc: "EV 评分" },
      ev_priority: { type: "string", required: true, enum: ["P0", "P1", "P2", "P3"], desc: "处置优先级：P0=立即修（可远程无前提利用）/P1=高/P2=中/P3=低，口径见 bug-report 技能" },
      ev_rationale: { type: "string", required: true, desc: "EV 逐维度判断依据（exploitability/价值 逐维写明）" },
      affected_versions: { type: "string", required: true, desc: "受影响版本范围；未知写 unknown" },
      summary: { type: "string", required: true, desc: "概览：一段读懂（缺陷位置/触发/后果/前提）" },
      background: { type: "string", required: true, desc: "业务背景" },
      dataflow: { type: "array<object>", required: true, desc: "{step, location(file:line), function?, role?(source/propagation/sink), snippet(逐字复制真实代码), description, flaw?}" },
      reproduction: { type: "object", desc: "{medium, preconditions[], request, payload_variants[], success_condition, notes}" },
      fix_patch: { type: "string", desc: "diff --git 开头的最小 unified diff；无法安全给出时省略" },
      references: { type: "array<string>", required: true, desc: "参考链接/依据列表" }
    },
    notes: "仅当前 HYP 裁决 confirmed 时 create。编号继承（BUG-<链>）。finding_class=vulnerability 时 poc_status/exp_status 自动置 pending，risk 时 not-needed。",
  },
  "finding.update": {
    ops: ["update"],
    fields: {
      id: { type: "string", required: true, desc: "finding 编号，如 BUG-C1-A2-H3" },
      poc_status: { type: "string", enum: ["pending", "reproduced", "fail-reproduced", "blocked", "not-needed"], desc: "状态机：pending→reproduced/fail-reproduced/blocked/not-needed；blocked 可回 pending；其余终态" },
      poc_evidence: { type: "string", desc: "复现证据（现象/日志摘要）" },
      exp_status: { type: "string", enum: ["pending", "reproduced", "fail-reproduced", "blocked", "not-needed"], desc: "同 poc_status 状态机" },
      ev_score: { type: "number" },
      ev_priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
      ev_rationale: { type: "string" },
      finding_class: { type: "string", enum: ["risk"], desc: "仅允许 vulnerability→risk 降级（降级时 poc/exp 自动 not-needed）" },
    },
    notes: "缺省字段保持不变。",
  },
  "build-state": {
    ops: ["update", "query"],
    fields: {
      status: { type: "string", enum: ["available", "unavailable"], desc: "沙箱/部署目标可用性（workflow 动态验证门禁）" },
      body: { type: "string(md)", desc: "整体替换正文。结构约定：构建系统/依赖/编译命令/部署拓扑/实例连接信息" },
    },
    notes: "首次调用至少给 status 或 body 之一。",
  },
  profiler: {
    ops: ["update", "query"],
    fields: {
      language: { type: "array<string>" },
      frameworks: { type: "array<string>" },
      entrypoints: { type: "array<string>", desc: "入口点（协议/API/命令）" },
      modules: { type: "array<object>", desc: "{name, path, role}[]" },
      build: { type: "object", desc: "{system, commands}" },
    },
    notes: "分节深合并：给值的节合并更新，缺省的节保持不变；可分多次调用逐步补齐。",
  },
  coverage: {
    ops: ["query"],
    fields: {
      scope: { type: "string", required: true, enum: ["global", "marked"], desc: "global=全项目覆盖；marked=标记范围对照阈值" },
      path: { type: "string", desc: "目录或文件路径（仅 global）" },
      depth: { type: "number", desc: "目录树展开深度（仅 global，默认 1）" },
    },
  },
};

const TYPE_LIST = Object.entries(SPECS)
  .filter(([k]) => !k.includes("."))
  .map(([t, s]) => `- ${t}: ${s.ops.join(" / ")}`)
  .join("\n");

// ---------------------------------------------------------------------------
// 校验（教学化报错：缺什么 + 正确示例）
const EV_RE = /^EV:\d+\.\d+\/R:[A-Z]\/(E|S|..?):.{1,3}\//;  // 粗校验：必须是 EV:x.y/R:?/... 结构化向量
// ---------------------------------------------------------------------------

function validateFields(type: string, fields: Record<string, unknown>): string | null {
  const spec = SPECS[type];
  if (!spec?.fields) return null;
  const missing: string[] = [];
  const badEnum: string[] = [];
  for (const [name, fs] of Object.entries(spec.fields)) {
    const v = fields[name];
    if (fs.required && v === undefined) missing.push(name);
    if (v !== undefined && fs.enum && !fs.enum.includes(String(v))) badEnum.push(`${name} 仅允许 ${fs.enum.join("/")}（收到 ${JSON.stringify(v)}）`);
  }
  const badFormat: string[] = [];
  const evv = fields.ev_vector;
  if (evv !== undefined && !EV_RE.test(String(evv))) badFormat.push(`ev_vector 必须是结构化向量 EV:1.0/R:{N|P}/E:{D|S}/C:{D|X}/I:{D|X}（收到 ${JSON.stringify(evv)}）；评分流程见 skills/bug-report/SKILL.md`);
  if (!missing.length && !badEnum.length && !badFormat.length) return null;
  const parts = [];
  if (missing.length) parts.push(`缺必填字段：${missing.join(", ")}`);
  if (badEnum.length) parts.push(`枚举越界：${badEnum.join("；")}`);
  if (badFormat.length) parts.push(`格式不符：${badFormat.join("；")}`);
  // 字段级示例：优先 spec.example，缺失字段给逐字段提示，避免空 {}
  const fieldHints = missing.map((n) => {
    const fs = (spec.fields ?? {})[n];
    return `  ${n}: ${fs?.example !== undefined ? JSON.stringify(fs.example) : `<${fs?.type ?? "值"}>${fs?.desc ? "（" + fs.desc.slice(0, 40) + "）" : ""}`}`;
  });
  return `${parts.join("；")}。\n该 type 的权威规格：\n${renderSpec(type)}${fieldHints.length ? `\n缺失字段填法：\n${fieldHints.join("\n")}` : ""}${spec.example ? `\n完整示例：\n${JSON.stringify(spec.example, null, 1)}` : ""}`;
}

function renderSpec(type: string): string {
  const spec = SPECS[type] ?? SPECS[`${type}.update`];
  if (!spec) return `未知 type：${type}。可用：\n${TYPE_LIST}`;
  const lines = Object.entries(spec.fields ?? {}).map(([n, fs]) =>
    `  ${n}: ${fs.type}${fs.required ? "（必填）" : ""}${fs.enum ? ` 枚举[${fs.enum.join("|")}]` : ""}${fs.desc ? ` — ${fs.desc}` : ""}`);
  return `${type}（${spec.ops.join("/")}）字段规格：\n${lines.join("\n")}${spec.notes ? `\n注意：${spec.notes}` : ""}`;
}

// ---------------------------------------------------------------------------
// query 处理器（读侧：列队/定点读/coverage）
// ---------------------------------------------------------------------------

function queryArtifact(ws: WsContext, type: string, id?: string, fields?: Record<string, unknown>) {
  if (type === "coverage") return queryCoverage(ws, fields ?? {});
  if (id) {
    if (type === "finding") {
      const p = join(ws.workdir, "findings", id, "report.yaml");
      if (!existsSync(p)) return errT(`未找到 finding ${id}（${p}）`);
      return okT(readFileSync(p, "utf-8"));
    }
    for (const q of ["leads", "todo", "done"]) {   // 产物会被 workflow 在队列间流转，三处都搜
      const p = join(ws.workdir, q, id.endsWith(".md") ? id : `${id}.md`);
      if (existsSync(p)) return okT(readFileSync(p, "utf-8") + `\n\n（位置：${q}/）`);
    }
    return errT(`未找到 ${type} ${id}（已搜 leads/todo/done 三个队列目录）`);
  }
  // 列队：leads/todo/done 三目录（直接在 workdir 下）该 type 的文件名
  const prefix = { hyp: "HYP-", lead: "LEAD-", adv: "ADV-", finding: "BUG-" }[type];
  if (!prefix) return errT(`query 不支持 type=${type}（可指定 id 定点读 finding，或列 hyp/lead/adv）`);
  const lines: string[] = [];
  for (const q of ["leads", "todo", "done"]) {
    const dir = join(ws.workdir, q);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix)) : [];
    if (files.length) lines.push(`${q}: ${files.join(", ")}`);
  }
  if (type === "finding" && existsSync(join(ws.workdir, "findings"))) {
    const fs = readdirSync(join(ws.workdir, "findings")).filter((f) => f.startsWith("BUG-"));
    if (fs.length) lines.push(`findings: ${fs.join(", ")}`);
  }
  return okT(lines.length ? lines.join("\n") : `（${type} 队列当前为空）`);
}

function queryCoverage(ws: WsContext, fields: Record<string, unknown>) {
  const scope = String(fields.scope ?? "");
  if (!["global", "marked"].includes(scope))
    return errT(`coverage 缺 scope=global|marked。\n${renderSpec("coverage")}`);
  const { jsonPath, jsonlPath } = getCoveragePaths(ws.workdir);
  const map = loadCoverageMap(jsonPath, ws.cwd, ws.workdir);
  aggregateCoverageEvents(jsonlPath, map);
  persistCoverageMap(map, jsonPath);
  if (scope === "marked") {
    const sc = loadScope(ws.workdir);
    if (!sc) return okT("尚未标记范围（scope.yaml 不存在）。");
    const stats = perScopeStats(map, sc);
    return okT(`标记范围覆盖：\n` + stats.map((s) => `${s.pass ? "✅" : "❌"} ${s.path}  ${s.pct}%（${s.read}/${s.total} 行，阈值 ${s.threshold}%）`).join("\n"));
  }
  return okT(renderCoverage(map, { path: fields.path as string | undefined, depth: (fields.depth as number) ?? 1 }));
}

// ---------------------------------------------------------------------------
// 主装配
// ---------------------------------------------------------------------------

function okT(text: string) { return { content: [{ type: "text" as const, text }], details: {} }; }
function errT(text: string): never {
  // pi-agent-core agent-loop.js:477 对正常返回的工具结果硬编码 isError:false（返回值里的 isError 字段被丢弃）；
  // 只有 throw 才会以 isError:true 落盘。所以校验/用法错误一律抛（文本不变，模型看到的教学内容相同）。
  throw new Error("ERROR: " + text);
}

/** 组装 artifact 元工具（每个节点会话恒定挂载） */
export function makeArtifactTool(ws: WsContext, binding: FnBinding, nodeId?: string): ToolDefinition {
  // 回退开关（默认不开）：VULNFORGE_ARTIFACT_ALLOW='{"hunt":["create hyp",…]}'
  let allow: Record<string, string[]> | null = null;
  try { if (process.env.VULNFORGE_ARTIFACT_ALLOW) allow = JSON.parse(process.env.VULNFORGE_ARTIFACT_ALLOW); } catch { /* 忽略坏配置 */ }

  return defineTool({
    name: "artifact",
    label: "Artifact",
    description:
      "审计产物统一管理。产物 type：profiler/build-state/wiki/adv/lead/hyp/finding/coverage/exploit。" +
      "op：query（读）/ create（新建）/ update（更新）/ spec（查字段规格）/ list（列可用操作）。" +
      "不确定某类产物的字段时先 artifact({op:\"spec\", type:\"<类型>\"})。产出只走本工具，落盘后不要自行删除。",
    // 顶层全 optional：schema 校验不进 pi 的 ajv（它的报错对模型无诊断性），自检在 execute 内做教学化报错
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "query/create/update/spec/list 之一" })),
      type: Type.Optional(Type.String({ description: "产物类型（query/create/update/spec 必填）" })),
      id: Type.Optional(Type.String({ description: "目标产物编号（update / 定点 query 用）——顶层参数，不放 fields" })),
      fields: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true, description: "载荷，字段规格见 spec" })),
    }),
    async execute(_id, params) {
      const { op } = params;
      if (!op || !["query", "create", "update", "spec", "list"].includes(op)) {
        return errT(`参数缺失/非法：本工具收到的顶层键 = [${Object.keys(params).join(", ") || "（空）"}]；需要 op（必填）+ type + fields。正确示例：artifact({op:"create", type:"hyp", fields:{body:"…"}})`);
      }
      const type = params.type ?? "";
      const fields = params.fields ?? {};

      if (op === "list") return okT(`可用产物操作：\n${TYPE_LIST}\n\n查字段规格：artifact({op:"spec", type:"<类型>"})`);
      if (op === "spec") {
        if (!type) return errT(`spec 需要 type。\n${TYPE_LIST}`);
        return okT(renderSpec(type));
      }
      if (!type) return errT(`${op} 需要 type。\n${TYPE_LIST}`);

      // 回退开关：按节点过滤
      if (allow && nodeId) {
        const allowed = allow[nodeId] ?? [];
        if (!allowed.includes(`${op} ${type}`) && !allowed.includes("*"))
          return errT(`节点 ${nodeId} 不被允许 ${op} ${type}（VULNFORGE_ARTIFACT_ALLOW 生效中）`);
      }

      switch (`${op} ${type}`) {
        case "create adv": {
          if (binding.runNo === undefined || !binding.advLine) return errT("create adv 需要会话绑定 runNo 与 advLine（由 workflow 注入）。");
          const e = validateFields("adv", fields); if (e) return errT(e);
          return makeEmitAdv(ws, binding.advLine, binding.runNo).execute("", { body: String(fields.body) }, undefined, undefined, undefined as never);
        }
        case "create hyp": {
          if (!binding.advId) return errT("create hyp 需要会话绑定 advId（由 workflow 注入）。");
          const e = validateFields("hyp", fields); if (e) return errT(e);
          return makeEmitHyp(ws, binding.advId).execute("", { body: String(fields.body) }, undefined, undefined, undefined as never);
        }
        case "create lead": {
          const e = validateFields("lead", fields); if (e) return errT(e);
          return makeEmitLead(ws).execute("", { type: fields.type as "research" | "hunt", body: String(fields.body) }, undefined, undefined, undefined as never);
        }
        case "create finding": {
          if (!binding.hypId) return errT("create finding 需要会话绑定 hypId（由 workflow 注入）。");
          const e = validateFields("finding", fields); if (e) return errT(e);
          return makeEmitFinding(ws, binding.hypId).execute("", fields as never, undefined, undefined, undefined as never);
        }
        case "update finding": {
          if (!params.id) return errT(`update finding 需要顶层参数 id（不放 fields 里）：artifact({op:"update", type:"finding", id:"BUG-xxx", fields:{...}})。\n${renderSpec("finding.update")}`);
          return makeUpdateFinding(ws).execute("", { id: params.id, ...fields } as never, undefined, undefined, undefined as never);
        }
        case "update build-state":
          return makeUpdateBuildState(ws).execute("", fields as never, undefined, undefined, undefined as never);
        case "update profiler":
          return makeUpdateProfiler(ws).execute("", fields as never, undefined, undefined, undefined as never);
        default:
          if (op === "query") return queryArtifact(ws, type, params.id, fields);
          return errT(`不支持 ${op} ${type}。\n${TYPE_LIST}`);
      }
    },
  });
}
