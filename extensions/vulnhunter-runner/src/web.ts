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
    return page("会话不存在", { meta: "", toc: "", body: `<p class="err">会话文件不可读：${esc(file || "(空)")}</p>` });
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

  const mtime = statSync(file).mtime.toISOString().replace("T", " ").slice(0, 19);
  const meta = `<b>会话</b> ${esc(file.split("/").pop() ?? file)}<br><span class="dim">目录</span> ${esc(String(header?.cwd ?? "?"))}<br><span class="dim">条目</span> ${entries.length}（当前分支 ${onBranch.size} · 侧枝 ${entries.length - onBranch.size - 1}）<br><span class="dim">更新</span> ${mtime} <a href="javascript:location.reload()">刷新</a><br><span class="sidechip">灰底=侧枝（被摘要折叠出活跃上下文的工程现场）</span>`;

  const body: string[] = [];
  const toc: string[] = [];
  const snippet = (s: string, n = 42) => esc(s.replace(/\s+/g, " ").slice(0, n));

  for (const e of entries) {
    if (e.type === "session") continue;
    const eid = e.id ?? "";
    const side = eid && !onBranch.has(eid) ? " side" : "";
    const ts = (e.timestamp ?? "").slice(11, 19);
    const marks = labels.get(eid) ?? [];
    const tag = marks.map((l) => `<span class="mark">◆ ${esc(l)}</span>`).join(" ");
    const attr = `id="e-${eid}" data-ts="${ts}" data-labeled="${marks.length ? 1 : 0}" data-side="${side ? 1 : 0}"`;
    const tocAdd = (t: string, icon: string, text: string) => {
      toc.push(`<a class="toc-item" data-t="${t}" data-labeled="${marks.length ? 1 : 0}" href="#e-${eid}" title="${esc(text.slice(0, 200))}"><span class="toc-ts">${ts}</span>${icon}${marks.length ? '<span class="toc-mark">◆</span>' : ""}<span class="toc-txt">${snippet(text)}</span></a>`);
    };

    if (e.type === "model_change") {
      body.push(`<div class="meta${side}" ${attr} data-t="meta">[${ts}] 模型 → ${esc(String((e as any).provider ?? ""))}/${esc(String((e as any).modelId ?? ""))} ${tag}</div>`);
    } else if (e.type === "thinking_level_change") {
      body.push(`<div class="meta${side}" ${attr} data-t="meta">[${ts}] 思考档 → ${esc(String((e as any).thinkingLevel ?? ""))} ${tag}</div>`);
    } else if (e.type === "label") {
      if (!labels.get(e.targetId ?? "")) body.push(`<div class="meta${side}" ${attr} data-t="meta">[${ts}] <span class="mark">◆ ${esc(e.label ?? "")}</span></div>`);
    } else if (e.type === "branch_summary") {
      const text = summaryText(e);
      body.push(`<div class="sum${side}" ${attr} data-t="sum"><div class="sum-h">Σ 分支摘要 ${e.label ? `<span class="mark">◆ ${esc(e.label)}</span>` : ""}${tag}<span class="ts">${ts}</span></div><div class="sum-b">${nl2br(esc(text))}</div></div>`);
      tocAdd("sum", "Σ", (e.label ? `[${e.label}] ` : "") + text);
    } else if (e.type === "message" && e.message) {
      const role = e.message.role ?? "?";
      if (role === "user") {
        const text = contentText(e.message.content);
        body.push(`<div class="umsg${side}" ${attr} data-t="user"><div class="ts">${ts} USER ${tag}</div><div class="ubody">${nl2br(esc(text))}</div></div>`);
        tocAdd("user", "U", text);
      } else if (role === "assistant") {
        const parts2: string[] = [];
        let firstText = "";
        for (const c of (e.message.content ?? []) as any[]) {
          if (c?.type === "thinking") {
            const t = String(c.thinking ?? "");
            parts2.push(`<details class="think"><summary><i>思考</i>（${t.length} 字）<span class="think-prev">${snippet(t, 60)}</span></summary><pre>${esc(t)}</pre></details>`);
          } else if (c?.type === "text") {
            if (!firstText) firstText = c.text ?? "";
            parts2.push(`<div class="atext">${nl2br(esc(c.text ?? ""))}</div>`);
          } else if (c?.type === "toolCall") {
            parts2.push(`<div class="tool"><div class="tool-h"><span class="dot run"></span><b>${esc(c.name ?? "?")}</b><span class="cid">${esc(c.id ?? "")}</span></div><details${argLen(c) < 400 ? " open" : ""}><summary>参数</summary><pre>${esc(pretty(c.arguments ?? c.args))}</pre></details></div>`);
          }
        }
        body.push(`<div class="amsg${side}" ${attr} data-t="asst"><div class="ts">${ts} ASSISTANT ${tag}</div>${parts2.join("")}</div>`);
        tocAdd("asst", "A", firstText || "（工具调用）");
      } else if (role === "toolResult") {
        const text = contentText(e.message.content);
        const isErr = (e.message as any).isError;
        const long = text.length > 800;
        body.push(`<div class="tres${side}" ${attr} data-t="tool"><div class="tool-h"><span class="dot ${isErr ? "err" : "ok"}"></span><b>← ${esc(String((e.message as any).toolName ?? "tool"))}</b>${isErr ? ' <span class="errtag">ERROR</span>' : ""}<span class="cid">${esc(String((e.message as any).toolCallId ?? ""))}</span> ${tag}</div><details${long ? "" : " open"}><summary>结果（${text.length} 字）</summary><pre>${esc(text)}</pre></details></div>`);
        tocAdd("tool", "←", `${(e.message as any).toolName ?? "tool"}：${text.slice(0, 30)}`);
      }
    }
  }
  return page(`会话 ${file.split("/").pop()}`, { meta, toc: toc.join("\n"), body: body.join("\n") });
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

function page(title: string, parts: { meta: string; toc: string; body: string }): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#c9d1d9;--dim:#8b949e;--accent:#58a6ff;--ubg:#1f6feb26;--ubd:#1f6feb55;--think:#b18cff;--ok:#3fb950;--err:#f85149;--amber:#d29922}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:14px/1.65 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:0}
a{color:var(--accent);text-decoration:none}
pre{white-space:pre-wrap;word-break:break-all;margin:6px 0;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}

/* 左侧导航（pi export 风） */
#side{position:fixed;left:0;top:0;bottom:0;width:290px;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column}
#side .ctrl{padding:8px;border-bottom:1px solid var(--border)}
#search{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);padding:4px 8px;font-size:12px;outline:none}
.filters{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.fbtn{background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--dim);font-size:11px;padding:2px 7px;cursor:pointer}
.fbtn.active{color:var(--accent);border-color:var(--accent)}
#toc{flex:1;overflow-y:auto;padding:4px 0}
.toc-item{display:flex;gap:6px;padding:3px 10px;color:var(--dim);font-size:11px;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc-item:hover{background:#1c2129;color:var(--fg)}
.toc-ts{color:#5c6675;flex:none;font-family:ui-monospace,monospace}
.toc-mark{color:var(--amber);flex:none}
.toc-txt{overflow:hidden;text-overflow:ellipsis}

/* 主区 */
#main{margin-left:290px;padding:14px 22px;max-width:1060px}
.hdr{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:14px}
.dim{color:var(--dim)} .err{color:var(--err)} .sidechip{color:var(--dim);background:var(--bg);padding:1px 6px;border-radius:4px;font-size:11px}

/* 条目 */
.ts{font-size:11px;color:var(--dim);margin-bottom:2px;font-family:ui-monospace,monospace}
.umsg{background:var(--ubg);border:1px solid var(--ubd);border-radius:6px;padding:8px 12px;margin:14px 0}
.ubody{white-space:pre-wrap;word-break:break-word}
.amsg{margin:14px 0}
.atext{margin:6px 0;white-space:pre-wrap;word-break:break-word}
.think{margin:6px 0;background:#1b1530;border:1px solid #3b2d6b;border-radius:6px;padding:4px 10px}
.think summary{cursor:pointer;color:var(--think);font-size:12px;font-style:italic}
.think-prev{color:#7a68a8;margin-left:8px;font-size:11px}
.tool,.tres{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:6px 0;font-size:13px}
.tres{margin-left:22px}
.tool-h{display:flex;align-items:center;gap:8px;font-family:ui-monospace,monospace;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.ok{background:var(--ok)} .dot.err{background:var(--err)} .dot.run{background:var(--accent)}
.cid{color:#5c6675;font-size:10px}
details summary{cursor:pointer;color:var(--dim);font-size:12px}
.errtag{color:var(--err);font-size:11px;border:1px solid var(--err);border-radius:3px;padding:0 4px}
.sum{background:#1a1508;border:1px solid #4a3a10;border-radius:6px;padding:8px 12px;margin:14px 0}
.sum-h{color:var(--amber);font-size:12px;margin-bottom:4px}
.sum-h .ts{float:right}
.sum-b{white-space:pre-wrap;word-break:break-word;font-size:13px}
.meta{color:var(--dim);text-align:center;font-size:11px;margin:10px 0}
.mark{display:inline-block;background:#3b2f0b;color:var(--amber);border-radius:4px;padding:0 6px;margin:1px 3px;font-size:11px}
.side{opacity:.5}
</style></head><body>
<div id="side"><div class="ctrl"><input id="search" placeholder="搜索条目…"><div class="filters"><button class="fbtn active" data-f="all">全部</button><button class="fbtn" data-f="notool">无工具结果</button><button class="fbtn" data-f="user">仅 USER</button><button class="fbtn" data-f="labeled">仅标记</button><button class="fbtn" data-f="sum">仅 Σ</button></div></div><div id="toc">${parts.toc}</div></div>
<div id="main"><div class="hdr">${parts.meta}</div>${parts.body}</div>
<script>
let F="all", Q="";
function apply(){
  for(const el of document.querySelectorAll("#main [data-t]")){
    const t=el.dataset.t, labeled=el.dataset.labeled==="1";
    let show = F==="all" || (F==="notool" && t!=="tool") || (F==="user" && t==="user") || (F==="labeled" && labeled) || (F==="sum" && t==="sum");
    if(show && Q) show = el.textContent.toLowerCase().includes(Q);
    el.style.display = show ? "" : "none";
  }
  for(const el of document.querySelectorAll(".toc-item")){
    const t=el.dataset.t, labeled=el.dataset.labeled==="1";
    let show = F==="all" || (F==="notool" && t!=="tool") || (F==="user" && t==="user") || (F==="labeled" && labeled) || (F==="sum" && t==="sum");
    if(show && Q) show = el.textContent.toLowerCase().includes(Q);
    el.style.display = show ? "" : "none";
  }
}
for(const b of document.querySelectorAll(".fbtn")) b.onclick=()=>{document.querySelector(".fbtn.active").classList.remove("active");b.classList.add("active");F=b.dataset.f;apply();};
document.getElementById("search").oninput=(e)=>{Q=e.target.value.toLowerCase();apply();};
</script></body></html>`;
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
