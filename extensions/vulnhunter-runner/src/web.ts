import { renderSession } from "./monitor-session.ts";
import { SPA } from "./monitor-page.ts";
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
import { monitorState, loadRuns } from "./monitor-state.ts";
import { buildSessionState } from "./session-state.ts";

let started = false;

export function ensureWebService(): string | null {
  if (started) return null;
  const flag = process.env.VULNHUNTER_WEB;
  if (!flag || flag === "0") return null;
  started = true;
  loadRuns();   // 回放历史 run 注册表（观察台随 pi 会话常驻，新会话也要看到旧 run）
  const port = Number(process.env.VULNHUNTER_WEB_PORT || "4100");
  const host = process.env.VULNHUNTER_WEB_HOST || "127.0.0.1";
  const srv = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(e));
    });
  });
  srv.unref();   // 观察台不拖住宿主进程退出
  // 端口冲突/监听失败不得炸掉 run：观察台是尽力而为的附属品（09-14 常驻实例占 4100 实踩）
  const tryListen = (p: number, attempt: number) => {
    srv.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && attempt < 10) {
        console.error(`[vulnhunter-web] 端口 ${p} 被占，试 ${p + 1}`);
        tryListen(p + 1, attempt + 1);
      } else {
        console.error(`[vulnhunter-web] 观察台启动失败（${e.code ?? e}），不影响 workflow`);
      }
    });
    srv.listen(p, host);
  };
  srv.once("listening", () => {
    const addr = srv.address();
    const url = typeof addr === "object" && addr ? `http://${host}:${addr.port}` : `http://${host}:${port}`;
    monitorState.log(`web 观察台启动：${url}`);
    console.error(`[vulnhunter-web] 观察台：${url}`);
  });
  tryListen(port, 0);
  return `http://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname === "/api/state") return sendJson(res, buildState());
  if (u.pathname === "/api/run") return sendJson(res, buildRun(u.searchParams.get("workdir") ?? "", u.searchParams.get("runId") ?? ""));
  if (u.pathname === "/api/stage") return sendJson(res, buildStageDetail(u.searchParams.get("workdir") ?? "", u.searchParams.get("runId") ?? "", u.searchParams.get("stage") ?? ""));
  if (u.pathname === "/api/session-state") return sendJson(res, apiSessionState(u.searchParams.get("file") ?? "", u.searchParams.get("workdir") ?? ""));
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
  // 执行器统计（fish 09-15）：容量/池/队列 = 观察台数据源；无执行器时为空
  const ex = monitorState.getExecutor()?.stats() ?? null;
  return {
    now,
    capacities: ex ? ex.capacities.map((c) => ({
      name: c.name, permits: c.permits,
      held: c.held.map((h) => ({ tag: h.tag, ms: now - h.since })),
      waiting: c.waiting,
    })) : [],
    pools: ex ? ex.pools.map((p) => ({
      name: p.name, max: p.concurrency, locked: p.locked,
      queued: p.waiting, dispatched: p.completed + p.failed + p.running.length, finished: p.completed,
      active: p.running.map((r) => ({ label: r.tag, ms: now - r.since })),
    })) : [],
    queues: [],
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
  const statePath = join(workdir, "system", "runs", `audit-lite-${runId}.json`);
  const out: Record<string, unknown> = { workdir, runId };
  try { out.state = JSON.parse(readFileSync(statePath, "utf-8")); }
  catch { out.state = null; }
  try {
    const lines = readFileSync(join(workdir, "system", "sessions-lineage.jsonl"), "utf-8").trim().split("\n");
    out.lineage = lines.slice(-120).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { out.lineage = []; }
  try { out.hyps = readdirSyncSafe(join(workdir, "system", "hyp")); } catch { out.hyps = []; }
  try { out.findings = readdirSyncSafe(join(workdir, "findings")); } catch { out.findings = []; }
  try {
    const cov = JSON.parse(readFileSync(join(workdir, "system", "coverage", "code-reading-coverage.json"), "utf-8"));
    const s = cov.summary ?? {};
    out.coverage = { pct: s.coverage != null ? Math.round(s.coverage * 1000) / 10 : null, read: s.read_lines, total: s.total_lines, coveredFiles: s.covered_files, files: s.files };
  } catch { out.coverage = null; }
  return out;
}

function readdirSyncSafe(d: string): string[] {
  try { return readdirSync(d); } catch { return []; }
}

/** /api/session-state：任务定位 + 摘要映射 + 活态（session-state 模块） */
function apiSessionState(file: string, workdir: string) {
  if (!file || !file.endsWith(".jsonl") || !existsSync(file)) return { error: "缺 file（会话 jsonl 路径）" };
  try { return buildSessionState({ file, workdir }); } catch (e) { return { error: String(e) }; }
}

// ---------------------------------------------------------------------------
// 阶段详情（09-14 fish「工厂模式」：点阶段卡看一台机器的投入/产出/加工）
// 物料模型（system/hyp 状态）：pending（待判库存）→ running（在判）→ closed（办结/裁决）；
// knowledge/ 是共享货架只增不消耗；findings/BUG-* 是成品。
// ---------------------------------------------------------------------------

interface LineageEntry { ts?: string; id?: string; action?: string; agent?: string; label?: string; target?: string; file?: string }

function buildStageDetail(workdir: string, runId: string, stage: string) {
  if (!workdir || !runId || !stage) return { error: "缺 workdir/runId/stage" };
  let state: Record<string, any> | null = null;
  try { state = JSON.parse(readFileSync(join(workdir, "system", "runs", `audit-lite-${runId}.json`), "utf-8")); } catch { /* 无 run-state */ }
  const t = state?.data?.stageTimes?.[stage] ?? null;
  const start = t?.start ? Date.parse(t.start) : null;
  const end = start != null ? (t?.ms != null ? start + t.ms : Date.now()) : null;

  // lineage 按阶段时间窗切片：[start, end) 左闭右开——相邻阶段共享边界时刻，
  // 归后一阶段（chains fork 不会漏进 hunt 窗；designer 09-14 实捕 ±2s 缓冲越界）
  let lineage: LineageEntry[] = [];
  try {
    lineage = readFileSync(join(workdir, "system", "sessions-lineage.jsonl"), "utf-8").trim().split("\n")
      .map((l) => { try { return JSON.parse(l) as LineageEntry; } catch { return null; } })
      .filter((e): e is LineageEntry => !!e)
      .filter((e) => {
        if (start == null) return true;
        const ts = e.ts ? Date.parse(e.ts) : NaN;
        return Number.isFinite(ts) && ts >= start && (end == null || ts < end);
      });
  } catch { /* 无 lineage */ }

  // 物料快照（system/hyp 状态驱动；历史时刻深度只能从 lineage 推，不猜）
  const ls = (d: string, re?: RegExp) => readdirSyncSafe(join(workdir, d)).filter((f) => !re || re.test(f));
  const hypByStatus = (st: string) => {
    const dir = join(workdir, "system", "hyp");
    return readdirSyncSafe(dir)
      .filter((f) => f.startsWith("HYP-") && f.endsWith(".json"))
      .filter((f) => { try { return (JSON.parse(readFileSync(join(dir, f), "utf-8")) as { status?: string }).status === st; } catch { return false; } })
      .map((f) => f.replace(/\.json$/, ""));
  };
  const queues = {
    stockHyp: hypByStatus("pending"),      // 待判库存
    inflightHyp: hypByStatus("running"),   // 在判
    archivedHyp: hypByStatus("closed"),    // 办结
    adv: [],
    leads: [],
    findings: ls("findings", /^BUG-/),
  };

  // 货架（knowledge/ 共享知识）
  const knowledge = {
    profiler: existsSync(join(workdir, "system", "profiler.json")),
    env: readdirSyncSafe(join(workdir, "knowledge", "env")),
    research: readdirSyncSafe(join(workdir, "knowledge", "research")),
    wiki: readdirSyncSafe(join(workdir, "knowledge", "wiki")),
    coverageMap: existsSync(join(workdir, "system", "coverage", "code-reading-coverage.json")),
  };

  // 阶段指标
  const data = state?.data ?? {};
  const metrics: Record<string, unknown> = {};
  if (stage === "hunt") {
    metrics.rounds = data.huntRound ?? null;
    metrics.roundHyps = Object.fromEntries(Object.entries(data.roundHyps ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    metrics.producedHyp = Object.values(data.roundHyps ?? {}).reduce((n: number, v) => n + (Array.isArray(v) ? v.length : 0), 0); // 阶段真实产量（run-state 记录，非盘面推）
    metrics.roundSigma = data.roundSigma ?? {};
    metrics.zeroStreak = data.huntZeroStreak ?? null;
  }
  if (stage === "chains") {
    const marks = lineage.filter((e) => e.action === "mark").map((e) => String(e.label ?? ""));
    metrics.confirmed = marks.filter((m) => /confirmed/.test(m)).length;
    metrics.refuted = marks.filter((m) => /refuted/.test(m)).length;
    metrics.findingsProduced = queues.findings.length;
  }
  // 该窗内的会话（start/end 配对出耗时；file=会话 jsonl（start 条目携带），可深链 /session 详情页）
  const sessMap = new Map<string, { id: string; agent?: string; target?: string; startTs?: string; endTs?: string; file?: string }>();
  for (const e of lineage) {
    if (!e.id) continue;
    const s = sessMap.get(e.id) ?? { id: e.id };
    if (e.agent) s.agent = e.agent;
    if (e.target) s.target = e.target;
    if (e.action === "start") { s.startTs = e.ts; if (e.file) s.file = e.file; }
    if (e.action === "end") s.endTs = e.ts;
    sessMap.set(e.id, s);
  }

  return {
    stage, runId, workdir,
    status: state?.stages?.[stage] ?? null,
    window: start != null ? { start, ms: t?.ms ?? null } : null,
    queues, knowledge, metrics,
    sessions: [...sessMap.values()],
    lineage,
  };
}

// ---------------------------------------------------------------------------
// 会话详情渲染（jsonl → HTML：当前分支根→叶，标记/摘要/工具调用全量）
// ---------------------------------------------------------------------------

