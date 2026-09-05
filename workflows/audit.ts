/**
 * audit：主审计 workflow（M3：Phase 0 + 主循环三池）
 *
 * 调度规则（fish 09-02 裁定）：
 *   - 派发即移 todo；异常结束退回 leads；
 *   - 下游优先（verify > hunt > cognize），不设积压限速；
 *   - cognize 串行（池 A=1）；hunt H=2、verify V=2；全局槽位 MAX=5；
 *   - cognize 停工双信号：scope 覆盖达标（hunt 口径）或连续 2 轮零 ADV；
 *   - LEAD 路由：research→追加 research 运行；hunt→机械转 ADV；
 *   - 节点 API 三连断流（runtime 内）→ aborted → workflow 中止；
 *   - 门禁：scope.yaml 阈值（mark_scope 设定）；无 scope 时门禁只看双信号。
 * M4：池 D（poc→ev 链式）+ exp-build 收尾 + 预算。
 */

import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow, type NodeResult, type WorkflowContext } from "../extensions/runner/runtime.ts";
import { loadState, saveState, readSandboxState } from "../extensions/runner/state.ts";
import { pending, toTodo, toDone, backToLeads, pendingLeads, leadToAdv, markLeadDone } from "../extensions/runner/queue.ts";
import { loadScope, loadCoverageMap, aggregateCoverageEvents, perScopeStats, getCoveragePaths } from "../extensions/code-coverage/coverage-core.ts";

const MAX = 5;
// hunt/verify 默认吃满全局并发（fish 09-02 裁定）：派发顺序 verify>hunt 保证下游优先，
// 富余槽位自然归 hunt；cognize/research 各限 1（前者防 wiki 写冲突，后者情报合批）。
const H = MAX, V = MAX;

type NodeOutcome = NodeResult & { file?: string; failed?: boolean };

interface Running {
  agent: string;
  file?: string;          // 队列文件名（leads 内原始名）
  promise: Promise<NodeOutcome>;
}

/** scope 覆盖门禁：全部条目不达标返回 false；无 scope 返回 null（不适用） */
function coverageMet(ctx: Parameters<typeof import("../extensions/runner/runtime.ts").defineWorkflow>[0] extends never ? never : import("../extensions/runner/runtime.ts").WorkflowContext): boolean | null {
  const scope = loadScope(ctx.workdir);
  if (!scope) return null;
  const cov = getCoveragePaths(ctx.workdir);
  const map = loadCoverageMap(cov.jsonPath, ctx.cwd, ctx.workdir);
  aggregateCoverageEvents(cov.jsonlPath, map);
  return perScopeStats(map, scope).every((s) => s.pass);
}

export default defineWorkflow({
  name: "audit",
  description: "审计主流程（M3：Phase 0 + cognize/hunt/verify 三池主循环 + 覆盖门禁）",
  async run(ctx) {
    const st = loadState(ctx.workdir);
    const dynamic = !!ctx.params.sandbox_cfg;
    const dynamicOnly = ctx.params.mode === "dynamic";
    const cognizeOnly = ctx.params.mode === "cognize";  // 只跑到池 A（验证 cognize 产出）
    const phase0Only = ctx.params.mode === "phase0";    // 只跑 onboard+research（干净测试第一步）
    const directHunt = ctx.params.mode === "direct";    // 小项目直读：onboard 后整份代码一条 ADV 直接 hunt，免 research/cognize/verify

    if (dynamicOnly) ctx.report("mode=dynamic：跳过 Phase 0 与静态主循环，直接进池 D");

    // ---- Phase 0：onboard（一次性）----
    if (!dynamicOnly && !st.onboard_done) {
      ctx.report("Phase 0: onboard 启动");
      const r = await ctx.node("onboard", { task: "onboard 任务，初始化整个审计任务。" });
      if (r.aborted) { ctx.report("onboard 异常中止（API 不可用），workflow 退出"); return; }
      st.onboard_done = true; saveState(ctx.workdir, st);
      ctx.report("onboard 完成");
    } else ctx.report("Phase 0: onboard 已完成（跳过）");

    // ---- 动态门禁 ----
    if (dynamic && readSandboxState(ctx.workdir) !== "available") {
      ctx.report("动态验证已启用但环境不可用，workflow 退出。请检查沙箱后重跑。");
      return;
    }

    // ---- Phase 0：research（一次性）----
    if (!dynamicOnly && !directHunt && !st.research_done) {
      st.counters.research_run++; saveState(ctx.workdir, st);
      ctx.report("Phase 0: research 启动");
      const r = await ctx.node("research", {
        binding: { runNo: st.counters.research_run },
        task: "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径。"
      });
      if (r.aborted) { ctx.report("research 异常中止（API 不可用），workflow 退出"); return; }
      st.research_done = true; saveState(ctx.workdir, st);
      ctx.report("research 完成");
    } else ctx.report(directHunt ? "Phase 0: research 跳过（mode=direct）" : "Phase 0: research 已完成（跳过）");

        if (phase0Only) { ctx.report("mode=phase0：onboard+research 完成，收工（状态已可备份）"); return; }

    if (directHunt && !pending(ctx.workdir, "ADV").length && !existsSync(join(ctx.workdir, "done", "ADV-C0-A1.md")) && !existsSync(join(ctx.workdir, "todo", "ADV-C0-A1.md"))) {
      const advBody = [
        "# ADV：整份代码精读（小项目直读模式）",
        "",
        "## 审计链路",
        "本项目规模小，不做链路切分：整份代码即链路。从主入口/主循环开始，沿真实数据流系统性读完全部有效代码。",
        "",
        "## 要求",
        "尽可能挖掘风险假设（HYP）：任何可疑点都提出来，宁多勿漏；每条 HYP 落到具体 file:line 与触发路径。",
      ].join("\n");
      writeFileSync(join(ctx.workdir, "leads", "ADV-C0-A1.md"), advBody + "\n");
      ctx.report("mode=direct：已机械生成整份代码 ADV-C0-A1");
    }

// ---- 主循环（池 A/B/C）----
    // 崩溃恢复：todo/ 残留一律退回 leads/ 重新排队
    for (const f of pending(ctx.workdir, "ADV").concat()) { /* noop */ }
    try {
      for (const f of readdirSync(join(ctx.workdir, "todo")).filter((f) => f.endsWith(".md")))
        renameSync(join(ctx.workdir, "todo", f), join(ctx.workdir, "leads", f));
    } catch { /* todo 不存在 */ }
    const running: Running[] = [];
    let cognizeIdle = st.cognize_idle_rounds;
    let cognizeStopped = coverageMet(ctx) === true;

    const launch = (agent: string, task: string, extraOrBinding: object | string, bindingOrFile?: object | string, file?: string) => {
      // 兼容两种形态：launch(agent, task, binding, file) 或 launch(agent, task, extra, binding)
      let extra: string | undefined; let binding: object; let f = file;
      if (typeof extraOrBinding === "string") { extra = extraOrBinding; binding = (bindingOrFile as object) ?? {}; }
      else { binding = extraOrBinding; f = bindingOrFile as string | undefined; }
      const promise: Promise<NodeOutcome> = ctx.node(agent, { task, extra, binding })
        .then((res) => ({ ...res, file }))
        .catch((e) => ({ agent, output: String(e), aborted: false, failed: true, file }));
      running.push({ agent, file: f, promise });
      ctx.report(`派发 ${agent}${file ? `：${file}` : ""}`);
    };

    for (;;) {
      if (dynamicOnly) break;
      // 1) LEAD 路由：hunt 型机械转 ADV；research 型合并标记（进入槽位调度，最多 1 并发）
      let researchPending = false;
      for (const lead of pendingLeads(ctx.workdir)) {
        if (lead.type === "research") { researchPending = true; markLeadDone(ctx.workdir, lead.file); }
        else {
          const advId = leadToAdv(ctx.workdir, lead, ++st.counters.cognize_run);
          ctx.report(`LEAD 转 ADV：${lead.file} → ${advId}`);
        }
      }
      saveState(ctx.workdir, st);

      // 2) 下游优先派发
      while (running.length < MAX) {
        const hyps = pending(ctx.workdir, "HYP");
        const advs = pending(ctx.workdir, "ADV");
        // 幂等守卫：同名文件已在 todo/done → leads 里这份是节点用 write 另存的草稿副本，丢弃防重复派发
        for (const f of [...hyps, ...advs]) {
          if (existsSync(join(ctx.workdir, "todo", f)) || existsSync(join(ctx.workdir, "done", f))) {
            rmSync(join(ctx.workdir, "leads", f));
            ctx.report(`丢弃 leads 残留副本（已在流转）：${f}`);
          }
        }
        const hyps2 = pending(ctx.workdir, "HYP");
        const advs2 = pending(ctx.workdir, "ADV");
        if (!cognizeOnly && !directHunt && hyps2.length && running.filter((r) => r.agent === "verify").length < V) {
          toTodo(ctx.workdir, hyps2[0]);
          launch("verify", "verify 任务，研判风险假设的成立性。", `风险假设：todo/${hyps2[0]}`, { hypId: hyps2[0].replace(/\.md$/, "") }, hyps2[0]);
        } else if (researchPending && !running.some((r) => r.agent === "research")) {
          researchPending = false;
          st.counters.research_run++;
          launch("research", "research 任务，补充检索（有回流线索指向新的检索方向）。", { runNo: st.counters.research_run });
        } else if (!cognizeOnly && advs2.length && running.filter((r) => r.agent === "hunt").length < H) {
          toTodo(ctx.workdir, advs2[0]);
          launch("hunt", "hunt 任务，沿审计链路精读并提出风险假设。", `审计链路：todo/${advs2[0]}`, { advId: advs2[0].replace(/\.md$/, "") }, advs2[0]);
        } else if (!cognizeStopped && !directHunt
                   && !pending(ctx.workdir, "ADV").length            // 有存量方向时不生产
                   && !running.some((r) => r.agent === "hunt")       // 有在途精读时不观察（消除分析冲突）
                   && !running.some((r) => r.agent === "cognize")) { // 串行
          st.counters.cognize_run++;
          launch("cognize", "cognize 任务，从覆盖缺口自选一个切面建立认知、产出审计链路。", { runNo: st.counters.cognize_run });
        } else break;
      }
      saveState(ctx.workdir, st);

      // 3) 终止判定：无在跑 + 队列空 + cognize 停工
      if (!running.length) {
        if (directHunt && !pending(ctx.workdir, "ADV").length) break;
        if (cognizeOnly && cognizeStopped) break;
        // 队列空 + cognize 停工 → 主循环结束；否则上方 dispatch 必已补一轮 cognize
        if (!pending(ctx.workdir, "ADV").length && !pending(ctx.workdir, "HYP").length && cognizeStopped) break;
        if (!pending(ctx.workdir, "ADV").length && !pending(ctx.workdir, "HYP").length && !cognizeStopped) continue;
      }
      if (!running.length) break;

      // 4) 等任一完成
      const done: NodeOutcome = await Promise.race(running.map((r) => r.promise));
      const idx = running.findIndex((r) => r.file === done.file && r.agent === done.agent);
      running.splice(idx, 1);
      ctx.report(`${done.agent} 结束${done.aborted ? "（API 不可用中止）" : ""}`);

      if (done.aborted) { ctx.report("API 不可用，workflow 中止。"); return; }

      // 5) 善后
      if (done.file) {
        if (done.failed) {
          if (st.stalled.includes(done.file)) { toDone(ctx.workdir, done.file); ctx.report(`${done.file} 重试仍失败，标记 stalled 归档`); }
          else { st.stalled.push(done.file); backToLeads(ctx.workdir, done.file); ctx.report(`${done.file} 异常，退回 leads 待重试`); }
        } else toDone(ctx.workdir, done.file);
      }
      if (done.agent === "cognize") {
        // 零 ADV 产出判定：本轮 cognize_run 对应 ADV 数为 0 → idle++
        const mine = pending(ctx.workdir, "ADV").filter((f) => f.startsWith(`ADV-C${st.counters.cognize_run}-`));
        cognizeIdle = mine.length ? 0 : cognizeIdle + 1;
        if (cognizeIdle >= 2) { cognizeStopped = true; ctx.report("cognize 连续 2 轮零产出，池 A 停工"); }
      }
      if (done.agent === "verify" && done.file) {
        const hypId = done.file.replace(/\.md$/, "").replace(/^todo\//, "");
        const bugDir = join(ctx.workdir, "findings", hypId.replace(/^HYP-/, "BUG-"));
        ctx.report(`裁决：${hypId} → ${existsSync(bugDir) ? "confirmed（finding 已产出）" : "refuted（无 finding）"}`);
      }
      // 覆盖达标后 cognize 永久停工
      if (!cognizeStopped && coverageMet(ctx) === true) { cognizeStopped = true; ctx.report("scope 覆盖达标，cognize 停工"); }
    }

    // ---- 池 D：动态验证（poc-verify → ev-assess 同 finding 链式，并发=1 沙箱）----
    if (dynamic && !cognizeOnly && !directHunt) {
      ctx.report("静态阶段完成，进入动态验证（池 D）");
      for (;;) {
        const findingsDir = join(ctx.workdir, "findings");
        if (!existsSync(findingsDir)) break;
        const { readFileSync } = await import("node:fs");
        // 候选：finding_class=vulnerability 且 poc_status=pending
        let target: string | undefined;
        for (const d of readdirSync(findingsDir)) {
          const rp = join(findingsDir, d, "report.yaml");
          if (!existsSync(rp)) continue;
          const txt = readFileSync(rp, "utf-8");
          if (/finding_class:\s*vulnerability/.test(txt) && /poc_status:\s*pending/.test(txt)) { target = d; break; }
        }
        if (!target) break;
        ctx.report(`池 D：poc-verify → ev-assess 链式，目标 ${target}`);
        const r1 = await ctx.node("poc-verify", {
          task: "poc-verify 任务，在沙箱中复现 finding。", extra: `目标 finding：findings/${target}/report.yaml`,
        });
        if (r1.aborted) { ctx.report("API 不可用，workflow 中止。"); return; }
        // poc 成功才接 ev-assess（reproduced 才评估）
        const rp = join(findingsDir, target, "report.yaml");
        const txt = readFileSync(rp, "utf-8");
        if (/poc_status:\s*reproduced/.test(txt) && /exp_status:\s*pending/.test(txt)) {
          const r2 = await ctx.node("ev-assess", {
            task: "ev-assess 任务，评估 finding 在真实业务场景下的影响。", extra: `目标 finding：findings/${target}/report.yaml`,
          });
          if (r2.aborted) { ctx.report("API 不可用，workflow 中止。"); return; }
        }
      }

      // ---- exp-build 收尾：其它节点全部完成后执行；无新 exploits 产出即停 ----
      for (;;) {
        const exploitsDir = join(ctx.workdir, "exploits");
        const before = existsSync(exploitsDir) ? readdirSync(exploitsDir).filter((d) => d.startsWith("EXP-")).length : 0;
        // 组合信号：ev-assess 完成（exp_status 非 pending）的 vulnerability ≥ 2
        const { readFileSync } = await import("node:fs");
        const findingsDir = join(ctx.workdir, "findings");
        if (!existsSync(findingsDir)) { ctx.report("无 findings，跳过 exp-build"); break; }
        let evDone = 0;
        for (const d of readdirSync(findingsDir)) {
          const rp = join(findingsDir, d, "report.yaml");
          if (!existsSync(rp)) continue;
          const txt = readFileSync(rp, "utf-8");
          if (/finding_class:\s*vulnerability/.test(txt) && /exp_status:\s*(confirmed|downgraded)/.test(txt)) evDone++;
        }
        if (evDone < 2) { ctx.report(`组合信号不足（已完成评估的 vulnerability：${evDone}），跳过 exp-build`); break; }
        ctx.report("exp-build 启动");
        const r = await ctx.node("exp-build", { task: "exp-build 任务，探索并构造漏洞组合。" });
        if (r.aborted) { ctx.report("API 不可用，workflow 中止。"); return; }
        const after = existsSync(exploitsDir) ? readdirSync(exploitsDir).filter((d) => d.startsWith("EXP-")).length : 0;
        if (after <= before) { ctx.report("exp-build 无新 exploits 产出，停止"); break; }
      }
    }

    // ---- 门禁收尾 ----
    const met = coverageMet(ctx);
    const finds = existsSync(join(ctx.workdir, "findings")) ? readdir0(join(ctx.workdir, "findings")) : 0;
    ctx.report(`主循环结束。findings: ${finds} 个；覆盖门禁：${met === null ? "无 scope，不适用" : met ? "达标" : "未达标（缺口详见 coverage 数据）"}`);
    ctx.report("M3 范围结束。池 D 与 exp-build 收尾 M4 接入。");
  },
});

function readdir0(p: string): number {
  try { return readdirSync(p).length; } catch { return 0; }
}
