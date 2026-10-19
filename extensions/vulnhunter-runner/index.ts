/**
 * VulnHunter runner 扩展：对外暴露单个 vulnhunter 工具（op=run/status/resume/report），
 * 供外层助手帮用户启动、跟踪、续跑、解读审计 workflow。
 *
 * 设计约束：
 * - 外层助手只做启动与解读，不做中途干预（fish 09-11）；
 * - 状态唯一事实源 = 磁盘（workdir/system/runs/<runId>.json + findings/）；工具只是读它；
 * - 错误一律教学式返回（外层助手是 LLM，看得懂就能自救）。
 *
 * 另注册：mark_scope（覆盖率门禁基准，旧 workflow 用）、F9 监控台。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readdirSync, writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workflow, WorkflowContext } from "./src/runtime.ts";
import { convergeInterrupted } from "./src/runtime.ts";
import { listFindings } from "./src/tools/finding.ts";
import { effectiveModelSpec, MODEL_POOLS, parseModelSpec, readModelConfig, writeModelConfig, type ModelPool } from "./src/model-config.ts";
import { createMonitorComponent } from "./src/monitor.ts";
import { ensureWebService } from "./src/web.ts";
import { ensureControlService, WorkflowRunnerEngine } from "./src/control.ts";

const ENGINE_DIR = process.env.PI_CODING_AGENT_DIR ?? resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = resolve(__dirname, "src", "workflows");   // 代码资产集中 src/（fish 09-11）

interface RunState {
  status: "idle" | "running" | "done" | "error";
  workflow?: string;
  runId?: string;
  log: string[];
  error?: string;
}

const WF_DOC = `\
可用 workflow：
- audit-lite：onboard→build→research→hunt 多轮→每条 HYP 走研判链。
常用 params：vuln_focus（漏洞关注方向，建议给）、coverage_include / coverage_exclude（审计范围/覆盖率口径，缺省全项目；支持 *.ext 通配）、sandbox_cfg（沙箱 ssh 配置，给了就走 dynamic-verify 含沙箱复现，不给就是纯静态 static-verify）、rounds / chain_filter（试验与限成本用，一般不用给）。`;

function readRuns(workdir: string): Array<{ runId: string; workflow: string; stages: Record<string, string>; data: Record<string, unknown> }> {
  const dir = join(workdir, "system", "runs");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      // data 透传：resume 首次定位的 convergeInterrupted 预判要读 data.stageTimes（缺了会抛 TypeError）
      out.push({ runId: j.runId ?? f.replace(/\.json$/, ""), workflow: j.workflow ?? "?", stages: j.stages ?? {}, data: j.data ?? {} });
    } catch { /* 跳过损坏文件 */ }
  }
  return out;
}

function renderFindings(workdir: string): string {
  const rows = listFindings(workdir).map((r) =>
    `${r.id}  [${r.finding_class} | ${r.ev_priority}]  CVSS ${r.cvss_score} / EV ${r.ev_score}  poc=${r.poc_status} exp=${r.exp_status}  ${r.title.slice(0, 60)}`
  );
  return rows.length ? rows.join("\n") : "（无 findings）";
}

export default function (pi: ExtensionAPI) {
  const state: RunState = { status: "idle", log: [] };
  const workflows = new Map<string, Workflow>();
  const loadErrors: string[] = [];

  // web 观察台（fish 09-14）：VULNHUNTER_WEB=1 即起，端口/绑定走 VULNHUNTER_WEB_PORT/HOST
  ensureWebService();

  async function loadWorkflows() {
    workflows.clear();
    loadErrors.length = 0;
    for (const f of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
      try {
        const mod = await import(pathToFileURL(join(WORKFLOWS_DIR, f)).href);
        const def = mod.default;
        // 两种导出结构：①旧：default 自带 run；②staged：default=StagedWorkflow 定义（无 run）+ 命名导出 run（runStages 包装）
        let w: Workflow | undefined;
        if (def && typeof def.run === "function") w = def;
        else if (typeof mod.run === "function") w = { name: def?.name ?? f.replace(/\.ts$/, ""), description: def?.description, run: mod.run };
        if (w?.name && typeof w.run === "function") workflows.set(w.name, w);
      } catch (e) { loadErrors.push(`${f}: ${String(e).split("\n")[0].slice(0, 160)}`); }
    }
  }

  // 可选控制面：HTTP 只是同一纯 JS 引擎 API 的适配器，默认不监听端口。
  const controlEngine = new WorkflowRunnerEngine({
    engineDir: ENGINE_DIR,
    cwd: process.cwd(),
    loadWorkflow: async (name) => { await loadWorkflows(); return workflows.get(name); },
  });
  ensureControlService(controlEngine);

  pi.registerTool(defineTool({
    name: "vulnhunter",
    label: "VulnHunter",
    description: `VulnHunter 审计引擎入口。op=run 启动审计（后台）/ status 查进度 / resume 断点续跑 / report 读结果 / model 查或切换模型配置（按池）。target=目标项目路径（缺省=会话当前目录）。${WF_DOC}`,
    parameters: Type.Object({
      op: Type.String({ description: "run | status | resume | report | model" }),
      workflow: Type.Optional(Type.String({ description: "run/resume 用：workflow 名（run 必填，resume 缺省=上次）" })),
      target: Type.Optional(Type.String({ description: "目标项目路径（缺省=会话当前目录）；相对路径按当前目录解析" })),
      params: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "run 用：vuln_focus / coverage_include / coverage_exclude / sandbox_cfg 等" })),
      from: Type.Optional(Type.String({ description: "resume 用：从哪个阶段续跑（如 hunt1 / chains）；不填=自动从上次的 failed 阶段" })),
      pool: Type.Optional(Type.String({ description: "model 用：global | init | hunt | verify（缺省=global）" })),
      model: Type.Optional(Type.String({ description: "model 用：'provider/model[:thinking]'；给值=切换，空串=清除该池配置；不给=只查询" })),
    }),
    async execute(_id, args, _signal, _onUpdate, ectx) {
      const targetRoot = args.target ? resolve(ectx.cwd, args.target) : ectx.cwd;
      const workdir = join(targetRoot, ".vulnforge");
      const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      const bad = (text: string): never => { throw new Error(`ERROR: ${text}`); };
      if (args.target && (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory())) bad(`target 不存在或不是目录：${targetRoot}（相对路径按会话当前目录解析）`);

      if (args.op === "model") {
        const poolKey = String(args.pool ?? "global") as ModelPool;
        if (!MODEL_POOLS.includes(poolKey)) bad(`未知池：${poolKey}（可用：${MODEL_POOLS.join(" / ")}）`);
        if (args.model !== undefined && String(args.model).trim()) parseModelSpec(String(args.model));   // 语法校验，出错抛教学错误
        let cfg;
        if (args.model !== undefined) {
          const patch: Partial<Record<ModelPool, string>> = {};
          patch[poolKey] = String(args.model);
          cfg = writeModelConfig(workdir, patch);
        } else cfg = readModelConfig(workdir);
        const eff = (p: ModelPool) => effectiveModelSpec(cfg, p) ?? "（settings.json 默认）";
        const lines = MODEL_POOLS.map((p) =>
          p === "global" ? `  global  ${cfg.global ?? "（未设）"}` : `  ${p.padEnd(7)} ${cfg[p] ?? "（未设）"}  → 生效：${eff(p)}`);
        return ok(`模型配置（${workdir}/system/model.json）：\n${lines.join("\n")}\n\n运行中的 run：在跑会话下一轮生效，新任务（新链/新轮）直接生效；未设项走 settings.json 默认。`);
      }

      if (args.op === "status") {
        const runs = readRuns(workdir);
        const cur = state.status === "running" ? `当前在跑：${state.workflow}（runId=${state.runId}）\n最近日志：\n${state.log.slice(-8).join("\n")}` : `当前空闲（上次状态：${state.status}${state.error ? "，错误：" + state.error : ""}）`;
        const hist = runs.map((r) => `runId=${r.runId} workflow=${r.workflow} 阶段：${Object.entries(r.stages).map(([k, v]) => `${k}:${v}`).join(" ")}`).join("\n");
        return ok(`${cur}\n\n历史 run：\n${hist || "（无）"}`);
      }

      if (args.op === "report") {
        return ok(`findings 一览：\n${renderFindings(workdir)}`);
      }

      if (args.op === "run" || args.op === "resume") {
        if (state.status === "running") bad(`已有 workflow 在跑：${state.workflow}（一会话一任务；先 status 看进度，跑完再启动新的）`);
        await loadWorkflows();
        const name = args.workflow ?? state.workflow;
        if (!name) bad(`resume 缺 workflow 名，且本会话没有跑过任何 workflow。可用：${[...workflows.keys()].join(", ")}`);
        const w = workflows.get(name);
        if (!w) bad(`未知 workflow：${name}。可用：${[...workflows.keys()].join(", ")}${workflows.size === 0 && loadErrors.length ? `\n加载失败详情：\n${loadErrors.join("\n")}` : ""}`);

        // resume：自动定位上次 failed / interrupted（进程中断悬空，runtime 加载时已收敛）的阶段
        let runOpts: { runId?: string; from?: string } = {};
        if (args.op === "resume") {
          const runs = readRuns(workdir).filter((r) => r.workflow === name);
          const last = runs[runs.length - 1];
          if (!last) bad(`没找到 ${name} 的历史 run（workdir/system/runs/ 为空），无法续跑——请用 op=run 全新启动`);
          let failed = Object.entries(last.stages).find(([, v]) => v === "failed" || v === "interrupted")?.[0];
          if (!failed) {
            // run-state 尚未被 runStages 收敛（上次进程 kill 后首次 resume）：对副本同规则预判（不落盘），
            // 定位必须读收敛后的副本（原对象 stages 不变，否则永远定位不到）
            const copy = JSON.parse(JSON.stringify(last)) as import("./src/runtime.ts").RunState;
            convergeInterrupted(copy);
            failed = Object.entries(copy.stages).find(([, v]) => v === "failed" || v === "interrupted")?.[0];
          }
          runOpts = { runId: last.runId, from: args.from ?? failed };
          if (!runOpts.from) bad(`上次 run（runId=${last.runId}）没有 failed / interrupted 阶段（阶段状态：${Object.entries(last.stages).map(([k, v]) => k + ":" + v).join(" ")}）。要重跑某阶段请显式给 from`);
        }

        state.status = "running"; state.workflow = name; state.runId = runOpts.runId; state.log = []; state.error = undefined;
        const ctx: WorkflowContext = {
          cwd: targetRoot,
          engineDir: ENGINE_DIR,
          workdir,
          params: args.params ?? {},
          node: () => { throw new Error("旧接口 node() 已废弃"); },
          report: (msg) => { state.log.push(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`); },
        };
        w.run(ctx, runOpts)
          .then(() => { state.status = "done"; state.log.push("workflow 完成"); })
          .catch((e) => { state.status = "error"; state.error = String(e); state.log.push("异常：" + String(e).slice(0, 200)); });
        return ok(`workflow ${name} 已${args.op === "resume" ? `从阶段 ${runOpts.from} 续跑` : "启动"}（后台执行）。用 vulnhunter({op:"status"}) 查进度。`);
      }

      bad(`未知 op：${args.op}。可用 op：run（启动）/ status（进度）/ resume（续跑）/ report（结果）`);
    },
  }));

  // mark_scope：主会话与用户确认审计范围后落 scope.yaml（覆盖率门禁基准，旧 workflow 用）
  pi.registerTool(defineTool({
    name: "mark_scope",
    label: "Mark Scope",
    description: "标记审计范围：确认要审计的模块/文件清单，统计代码行数，写入目标项目 .vulnforge/scope.yaml；target 缺省=会话当前目录。",
    parameters: Type.Object({
      entries: Type.Array(Type.Object({
        path: Type.String({ description: "相对项目根的文件或目录路径" }),
        threshold: Type.Optional(Type.Number({ description: "覆盖率达标阈值（百分比），默认 90" })),
      })),
      excludes: Type.Optional(Type.Array(Type.String(), { description: "排除路径" })),
      target: Type.Optional(Type.String({ description: "目标项目路径（缺省=会话当前目录）" })),
    }),
    async execute(_id, args, _signal, _onUpdate, ectx) {
      const cwd = args.target ? resolve(ectx.cwd, args.target) : ectx.cwd;
      if (args.target && !existsSync(cwd)) throw new Error(`ERROR: target 不存在：${cwd}（相对路径按会话当前目录解析）`);
      const CODE_EXT = /\.(c|h|cc|cpp|rs|go|py|js|ts|java|rb|lua|zig|m|mm)$/i;
      const countLines = (p: string): number => {
        try {
          const st = statSync(p);
          if (st.isFile()) return CODE_EXT.test(p) ? readFileSync(p, "utf-8").split("\n").length : 0;
          let total = 0;
          for (const f of readdirSync(p)) total += countLines(join(p, f));
          return total;
        } catch { return 0; }
      };
      const lines: string[] = [];
      let total = 0;
      for (const e of args.entries) {
        const n = countLines(join(cwd, e.path));
        total += n;
        lines.push(`${e.path}: ${n} 行（阈值 ${e.threshold ?? 90}%）`);
      }
      const wd = join(cwd, ".vulnforge");
      if (!existsSync(wd)) mkdirSync(wd, { recursive: true });
      let yaml = "entries:\n" + args.entries.map((e) => `  - path: ${e.path}\n    threshold: ${e.threshold ?? 90}`).join("\n") + "\n";
      if (args.excludes?.length) yaml += "excludes:\n" + args.excludes.map((x) => `  - ${x}`).join("\n") + "\n";
      writeFileSync(join(wd, "scope.yaml"), yaml);
      return { content: [{ type: "text", text: `范围已标记（${args.entries.length} 条目，共 ${total} 行）：\n${lines.join("\n")}\n\n已写入 .vulnforge/scope.yaml，作为审计完成门禁。` }], details: {} };
    },
  }));

  // 监控台：F9 呼出三 tab 弹窗（运行/节点详情/覆盖率）
  pi.registerShortcut("f9", {
    description: "VulnHunter 监控台",
    handler: async (ectx) => {
      await ectx.ui.custom<void>((tui, theme, _kb, done) => createMonitorComponent(tui, theme, join(ectx.cwd, ".vulnforge"), () => done()), {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "80%" },
      });
    },
  });
}
