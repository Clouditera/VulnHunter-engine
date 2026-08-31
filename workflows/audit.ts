/**
 * audit：主审计 workflow（M2 范围：Phase 0 —— onboard → 动态门禁 → research）
 *
 * M3 接入主循环（cognize/hunt/verify 三池）；M4 接池 D 与 coverage 门禁。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow } from "../extensions/runner/runtime.ts";
import { loadState, saveState, readSandboxState } from "../extensions/runner/state.ts";

export default defineWorkflow({
  name: "audit",
  description: "审计主流程（M2：onboard/research 一次性阶段 + 动态门禁；主循环 M3 接入）",
  async run(ctx) {
    const st = loadState(ctx.workdir);
    const dynamic = !!ctx.params.sandbox_cfg;

    // ---- onboard（一次性，幂等跳过）----
    if (!st.onboard_done) {
      ctx.report("Phase 0: onboard 启动");
      const r = await ctx.node("onboard", {
        task: [
          `目标项目根：${ctx.cwd}`,
          dynamic
            ? `已启用动态验证，沙箱配置：${ctx.params.sandbox_cfg}。请实际验证沙箱内构建可用性并 update_build_state。`
            : "未启用动态验证。update_build_state 记录 status: unavailable 并说明（未配置沙箱）。",
          ctx.params.vuln_focus ? `漏洞关注方向：${ctx.params.vuln_focus}` : "",
        ].filter(Boolean).join("\n"),
      });
      ctx.report(`onboard 结束${r.aborted ? "（异常中止）" : ""}`);
      if (r.aborted) { ctx.report("onboard 未完成，本次运行中止"); return; }
      st.onboard_done = true;
      saveState(ctx.workdir, st);
    } else {
      ctx.report("Phase 0: onboard 已完成（跳过）");
    }

    // ---- 动态门禁 ----
    if (dynamic) {
      const sandbox = readSandboxState(ctx.workdir);
      if (sandbox !== "available") {
        ctx.report(`动态验证已启用但环境不可用（sandbox: ${sandbox}），workflow 退出。请检查沙箱后重跑。`);
        return;
      }
      ctx.report("动态门禁通过（sandbox: available）");
    }

    // ---- research（一次性，幂等跳过）----
    if (!st.research_done) {
      ctx.report("Phase 0: research 启动");
      st.counters.research_run++;
      saveState(ctx.workdir, st);
      const r = await ctx.node("research", {
        binding: { runNo: st.counters.research_run },
        task: [
          `检索方向：项目 ${ctx.cwd}（版本以仓库状态为准）。`,
          ctx.params.vuln_focus ? `关注面：${ctx.params.vuln_focus}` : "",
          "已有 knowledge/research/ 档案时先读档案，增量检索。",
        ].filter(Boolean).join("\n"),
      });
      ctx.report(`research 结束${r.aborted ? "（异常中止）" : ""}`);
      st.research_done = true;
      saveState(ctx.workdir, st);
    } else {
      ctx.report("Phase 0: research 已完成（跳过）");
    }

    ctx.report("Phase 0 完成（M2 范围）。主循环（cognize/hunt/verify/池D/门禁）M3-M4 接入。");
  },
});
