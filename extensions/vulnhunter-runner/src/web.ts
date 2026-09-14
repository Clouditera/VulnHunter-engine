/**
 * VulnHunter web 观察台（fish 09-14）：进程内嵌的只读 web 服务。
 *
 * 启动方式（环境变量，缺省不起）：
 *   VULNHUNTER_WEB=1        启动 web 服务
 *   VULNHUNTER_WEB_PORT     端口（默认 4100）
 *   VULNHUNTER_WEB_HOST     绑定地址（默认 127.0.0.1）
 *
 * 两个挂载点：pi 扩展入口（index.ts，交互态即起）与 runStages（驱动跑批即起）。
 * 数据源：monitorState（进程内注册表：池/会话/事件/Run）+ 磁盘（run-state、血缘、session jsonl）。
 *
 * 页面：
 *   /            SPA——运行池 / 进行中会话 / Run 列表 / 事件流，3s 自刷
 *   /api/state   上述 JSON
 *   /api/run     ?workdir=&runId=  run-state + 血缘
 *   /session     ?file=<jsonl>     会话详情渲染（user prompt/思考/工具调用/结果/标记/摘要）
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorState } from "./monitor-state.ts";

let started = false;

export function ensureWebService(): string | null {
  if (started) return null;
  const flag = process.env.VULNHUNTER_WEB;
  if (!flag || flag === "0") return null;
  started = true;
  const port = Number(process.env.VULNHUNTER_WEB_PORT || "4100");
  const host = process.env.VULNHUNTER_WEB_HOST || "127.0.0.1";
  const srv = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(e));
    });
  });
  srv.unref();   // 观察台不拖住宿主进程退出
  srv.listen(port, host);
  const url = `http://${host}:${port}`;
  monitorState.log(`web 观察台启动：${url}`);
  console.error(`[vulnhunter-web] 观察台：${url}`);
  return url;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname === "/api/state") return sendJson(res, buildState());
  if (u.pathname === "/api/run") return sendJson(res, buildRun(u.searchParams.get("workdir") ?? "", u.searchParams.get("runId") ?? ""));
  if (u.pathname === "/session") return sendHtml(res, renderSession(u.searchParams.get("file") ?? ""));
  return sendHtml(res, SPA);
}

function sendJson(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// 数据装配
// ---------------------------------------------------------------------------

function buildState() {
  const now = Date.now();
  return {
    now,
    pools: [...monitorState.pools.values()].map((p) => ({
      name: p.name, max: p.max, queued: p.queued,
      active: [...p.active.entries()].map(([label, ts]) => ({ label, ms: now - ts })),
    })),
    running: [...monitorState.running.values()].map((n) => ({
      id: n.id, agent: n.agent, target: n.target, ms: now - n.startTs,
      sessionFile: n.sessionFile, workdir: n.workdir, cwd: n.cwd,
    })),
    events: monitorState.events.slice(-60),
    runs: [...monitorState.runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30),
  };
}

function buildRun(workdir: string, runId: string) {
  if (!workdir || !runId) return { error: "缺 workdir/runId" };
  const statePath = join(workdir, "runs", `audit-lite-${runId}.json`);
  const out: Record<string, unknown> = { workdir, runId };
  try { out.state = JSON.parse(readFileSync(statePath, "utf-8")); }
  catch { out.state = null; }
  try {
    const lines = readFileSync(join(workdir, "sessions-lineage.jsonl"), "utf-8").trim().split("\n");
    out.lineage = lines.slice(-120).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { out.lineage = []; }
  try { out.leads = readdirSyncSafe(join(workdir, "leads")); } catch { out.leads = []; }
  try { out.findings = readdirSyncSafe(join(workdir, "findings")); } catch { out.findings = []; }
  return out;
}

function readdirSyncSafe(d: string): string[] {
  try { return readdirSync(d); } catch { return []; }
}

// ---------------------------------------------------------------------------
// 会话详情渲染（jsonl → HTML：当前分支根→叶，标记/摘要/工具调用全量）
// ---------------------------------------------------------------------------

interface SessEntry {
  type: string; id?: string; parentId?: string | null; timestamp?: string;
  label?: string; targetId?: string;
  message?: { role?: string; content?: unknown[]; [k: string]: unknown };
  [k: string]: unknown;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSession(file: string): string {
  if (!file || !file.endsWith(".jsonl") || file.includes("..") || !existsSync(file)) {
    return page("会话不存在", `<p class="err">会话文件不可读：${esc(file || "(空)")}</p>`);
  }
  const entries: SessEntry[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  const byId = new Map<string, SessEntry>();
  let leaf: string | null = null;
  let header: SessEntry | null = null;
  for (const e of entries) {
    if (e.type === "session") { header = e; continue; }
    if (e.id) { byId.set(e.id, e); leaf = e.id; }
  }
  // 根→叶当前分支（模型此刻上下文所见）；侧枝=已被摘要折叠的历史现场
  const onBranch = new Set<string>();
  for (let cur = leaf; cur;) {
    const e = byId.get(cur);
    if (!e) break;
    onBranch.add(cur);
    cur = e.parentId ?? null;
  }
  // 条目上的标签（label 条目的 targetId → label 文本）
  const labels = new Map<string, string[]>();
  for (const e of entries) {
    if (e.type === "label" && e.targetId && e.label) {
      const arr = labels.get(e.targetId) ?? [];
      arr.push(e.label);
      labels.set(e.targetId, arr);
    }
  }

  const parts: string[] = [];
  const mtime = statSync(file).mtime.toISOString().replace("T", " ").slice(0, 19);
  parts.push(`<div class="meta">会话文件：${esc(file)}<br>目录：${esc(String(header?.cwd ?? "?"))} ｜ 条目 ${entries.length}（当前分支 ${onBranch.size}，侧枝 ${entries.length - onBranch.size - 1}）｜ 文件更新 ${mtime} ｜ <a href="javascript:location.reload()">刷新</a><br><span class="sidechip">灰底=侧枝条目（已被摘要折叠出活跃上下文，工程现场完整保留）</span></div>`);

  for (const e of entries) {
    if (e.type === "session") continue;
    const side = e.id && !onBranch.has(e.id) ? " side" : "";
    const ts = (e.timestamp ?? "").slice(11, 19);
    const tag = labels.get(e.id ?? "")?.map((l) => `<span class="mark">◆ ${esc(l)}</span>`).join(" ") ?? "";
    if (e.type === "model_change") {
      parts.push(`<div class="meta${side}">[${ts}] 模型 → ${esc(String((e as any).provider ?? ""))}/${esc(String((e as any).modelId ?? ""))} ${tag}</div>`);
    } else if (e.type === "thinking_level_change") {
      parts.push(`<div class="meta${side}">[${ts}] 思考档 → ${esc(String((e as any).thinkingLevel ?? ""))} ${tag}</div>`);
    } else if (e.type === "label") {
      if (!labels.get(e.targetId ?? "")) parts.push(`<div class="meta${side}">[${ts}] <span class="mark">◆ ${esc(e.label ?? "")}</span></div>`);
    } else if (e.type === "branch_summary") {
      parts.push(`<div class="sum${side}">[${ts}] <b>Σ 分支摘要</b> ${e.label ? `<span class="mark">◆ ${esc(e.label)}</span>` : ""}${tag}<br>${nl2br(esc(summaryText(e)))}</div>`);
    } else if (e.type === "message" && e.message) {
      const role = e.message.role ?? "?";
      if (role === "user") {
        parts.push(`<div class="user${side}">[${ts}] <b>USER</b> ${tag}<br>${nl2br(esc(contentText(e.message.content)))}</div>`);
      } else if (role === "assistant") {
        const body = (e.message.content ?? []).map((c: any) => {
          if (c?.type === "thinking") return `<details class="think"><summary>思考（${String(c.thinking ?? "").length} 字）</summary><pre>${esc(c.thinking ?? "")}</pre></details>`;
          if (c?.type === "text") return `<div class="atext">${nl2br(esc(c.text ?? ""))}</div>`;
          if (c?.type === "toolCall") return `<div class="call"><b>→ ${esc(c.name ?? "?")}</b> <span class="cid">${esc(c.id ?? "")}</span><details${argLen(c) < 400 ? " open" : ""}><summary>参数</summary><pre>${esc(pretty(c.arguments ?? c.args))}</pre></details></div>`;
          return "";
        }).join("");
        parts.push(`<div class="asst${side}">[${ts}] <b>ASSISTANT</b> ${tag}${body}</div>`);
      } else if (role === "toolResult") {
        const text = contentText(e.message.content);
        const long = text.length > 800;
        parts.push(`<div class="result${side}"><b>← ${esc(String((e.message as any).toolName ?? "tool"))}</b> <span class="cid">${esc(String((e.message as any).toolCallId ?? ""))}</span>${(e.message as any).isError ? ' <span class="err">ERROR</span>' : ""} ${tag}<details${long ? "" : " open"}><summary>结果（${text.length} 字）</summary><pre>${esc(text)}</pre></details></div>`);
      }
    }
  }
  return page(`会话 ${file.split("/").pop()}`, parts.join("\n"));
}

function summaryText(e: SessEntry): string {
  const c = (e as any).content ?? (e as any).summary ?? "";
  return typeof c === "string" ? c : JSON.stringify(c, null, 2);
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((c: any) => (c?.type === "text" ? c.text : "")).filter(Boolean).join("\n");
}

function argLen(c: any): number { return JSON.stringify(c.arguments ?? c.args ?? {}).length; }
function pretty(v: unknown): string { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function nl2br(s: string): string { return s.replace(/\n/g, "<br>"); }

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{background:#0f1115;color:#d7dde8;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:16px 24px}
a{color:#6ea8fe} pre{white-space:pre-wrap;word-break:break-all;margin:6px 0}
.meta{color:#8b95a7;margin:10px 0} .err{color:#ff7b72}
.user,.asst,.result,.sum{border-left:3px solid #2c3550;margin:12px 0;padding:6px 12px;background:#151923;border-radius:0 6px 6px 0}
.user{border-color:#3b82f6} .asst{border-color:#22c55e} .result{border-color:#6b7280;margin-left:24px}
.sum{border-color:#d97706;background:#1a1610}
.mark{display:inline-block;background:#3b2f0b;color:#fbbf24;border-radius:4px;padding:0 6px;margin:1px 3px;font-size:12px}
.cid{color:#5c6675;font-size:11px;margin-left:8px}
details{margin:4px 0} summary{cursor:pointer;color:#8b95a7}
.think summary{color:#a78bfa} .call{margin:6px 0} .atext{margin:6px 0}
.side{opacity:.52}.sidechip{color:#8b95a7;background:#151923;padding:1px 6px;border-radius:4px}
</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// SPA
// ---------------------------------------------------------------------------

const SPA = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>VulnHunter 观察台</title><style>
body{background:#0f1115;color:#d7dde8;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:18px 26px}
h1{font-size:16px;margin:0 0 4px} h2{font-size:13px;color:#9aa6bb;margin:18px 0 6px;border-bottom:1px solid #242b3d;padding-bottom:4px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #1d2331;padding:4px 8px;text-align:left;vertical-align:top}
th{color:#7c8698;font-weight:normal} a{color:#6ea8fe;cursor:pointer;text-decoration:none}
.pill{border-radius:4px;padding:0 6px;font-size:12px}.run-ok{background:#0f2c1a;color:#4ade80}.run-ing{background:#12283f;color:#60a5fa}.run-err{background:#3a1414;color:#f87171}
.dim{color:#8b95a7}.ev{color:#9aa6bb;font-size:12px;white-space:pre-wrap}
#runDetail{background:#151923;border:1px solid #242b3d;border-radius:8px;padding:12px 16px;margin-top:10px;display:none}
pre{white-space:pre-wrap;word-break:break-all}
</style></head><body>
<h1>VulnHunter 观察台 <span class="dim" id="clock"></span></h1>
<div class="dim">只读视图 · 3s 自刷 · <a href="/api/state">/api/state</a></div>
<h2>运行池</h2><div id="pools">…</div>
<h2>进行中的会话</h2><div id="running">…</div>
<h2>Runs（本进程所见）</h2><div id="runs">…</div>
<div id="runDetail"></div>
<h2>事件</h2><div id="events" class="ev">…</div>
<script>
const fmtMs = (ms) => ms < 60000 ? (ms/1000|0) + "s" : (ms/60000|0) + "m" + ((ms/1000|0)%60) + "s";
const fmtTs = (ts) => new Date(ts).toTimeString().slice(0,8);
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;");
async function j(u){ const r = await fetch(u); return r.json(); }
function sessLink(f,label){ return f ? ' <a href="/session?file=' + encodeURIComponent(f) + '" target="_blank">[' + (label||"详情") + ']</a>' : ""; }

async function tick(){
  try {
    const s = await j("/api/state");
    document.getElementById("clock").textContent = fmtTs(s.now);
    document.getElementById("pools").innerHTML = s.pools.length === 0 ? '<span class="dim">（无池——hunt 串行阶段不建池）</span>' :
      "<table><tr><th>池</th><th>在跑/上限</th><th>排队</th><th>在跑任务</th></tr>" + s.pools.map(p =>
        "<tr><td>" + esc(p.name) + "</td><td>" + p.active.length + "/" + p.max + "</td><td>" + p.queued + "</td><td>" +
        p.active.map(a => esc(a.label) + " <span class='dim'>" + fmtMs(a.ms) + "</span>").join("<br>") + "</td></tr>").join("") + "</table>";
    document.getElementById("running").innerHTML = s.running.length === 0 ? '<span class="dim">（无进行中会话）</span>' :
      "<table><tr><th>会话</th><th>agent</th><th>目标</th><th>已跑</th><th></th></tr>" + s.running.map(n =>
        "<tr><td>" + esc(n.id) + "</td><td>" + esc(n.agent) + "</td><td>" + esc(n.target ?? "") + "</td><td>" + fmtMs(n.ms) + "</td><td>" + sessLink(n.sessionFile,"会话") + "</td></tr>").join("") + "</table>";
    document.getElementById("runs").innerHTML = s.runs.length === 0 ? '<span class="dim">（本进程还没有 run——驱动跑批或经 vulnhunter 工具启动后可见）</span>' :
      "<table><tr><th>workflow</th><th>runId</th><th>状态</th><th>开始</th><th>目标</th><th></th></tr>" + s.runs.map(r =>
        "<tr><td>" + esc(r.workflow) + "</td><td>" + esc(r.runId) + "</td><td><span class='pill run-" + (r.status==="running"?"ing":r.status==="done"?"ok":"err") + "'>" + r.status + "</span></td><td>" + fmtTs(r.startedAt) + "</td><td class='dim'>" + esc(r.cwd) + "</td><td><a onclick='showRun(&quot;" + encodeURIComponent(r.workdir) + "&quot;,&quot;" + esc(r.runId) + "&quot;)'>[详情]</a></td></tr>").join("") + "</table>";
    document.getElementById("events").innerHTML = s.events.slice().reverse().map(e => "[" + fmtTs(e.ts) + "] " + esc(e.msg)).join("\\n");
  } catch (e) { /* 下一轮重试 */ }
}
async function showRun(workdir, runId){
  const d = await j("/api/run?workdir=" + workdir + "&runId=" + encodeURIComponent(runId));
  const el = document.getElementById("runDetail");
  const st = d.state || {};
  const stages = st.stages ? Object.entries(st.stages).map(([k,v]) => "<tr><td>" + esc(k) + "</td><td>" + esc(v) + "</td></tr>").join("") : "";
  const sess = st.sessions ? Object.entries(st.sessions).map(([k,v]) => "<tr><td>" + esc(k) + "</td><td>" + esc(v) + sessLink(v,"查看会话") + "</td></tr>").join("") : "";
  const rh = (st.data && st.data.roundHyps) ? Object.entries(st.data.roundHyps).map(([k,v]) => esc(k) + ": " + (Array.isArray(v)?v.length:0) + " 条").join("　") : "";
  const lin = (d.lineage||[]).slice(-30).map(l => "[" + String(l.ts||"").slice(11,19) + "] " + esc(l.action) + " " + esc(l.label ?? l.summaryLabel ?? l.id ?? "")).join("\\n");
  el.style.display = "block";
  el.innerHTML = "<h2>Run " + esc(runId) + "</h2>" +
    "<div class='dim'>leads: " + (d.leads||[]).length + " ｜ findings: " + (d.findings||[]).length + " ｜ 逐轮 HYP：" + (rh || "无") + "</div>" +
    "<h2>阶段</h2><table>" + stages + "</table>" +
    "<h2>会话文件</h2><table>" + sess + "</table>" +
    "<h2>血缘（末 30 条）</h2><pre>" + lin + "</pre>";
}
setInterval(tick, 3000); tick();
</script></body></html>`;
