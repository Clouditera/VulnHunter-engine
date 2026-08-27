/**
 * static-audit：静态审计 workflow（M1 骨架版）
 *
 * M1 只打通链路：单 cognize 节点冒烟。
 * M2 补全：onboard → cognize 循环 → hunt/verify 循环 → 覆盖率门禁收尾。
 */

import { defineWorkflow } from "../extensions/runner/runtime.ts";

export default defineWorkflow({
  name: "static-audit",
  description: "静态审计：onboard → cognize → hunt/verify 循环 → 覆盖率门禁（M1 骨架：单 cognize 冒烟）",
  async run(ctx) {
    ctx.report(`static-audit 启动，目标 ${ctx.cwd}，参数 ${JSON.stringify(ctx.params)}`);

    // M1 冒烟：起一个 cognize 节点验证 SDK 会话链路
    const r = await ctx.node("cognize", {
      task: "冒烟任务：列出项目根目录结构（ls 两层），写入 knowledge/wiki/overview.md 的'## 结构速览'节，然后结束。",
    });
    ctx.report(`cognize 节点完成，输出 ${r.output.length} 字${r.aborted ? "（超时中止）" : ""}`);
  },
});
