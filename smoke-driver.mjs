// M2 Phase 0 冒烟驱动：不经 pi 主会话，直接驱动 audit workflow（onboard → research）
import workflow from "./.dist/workflows/audit-direct.js";
import { runNode } from "./.dist/extensions/runner/runtime.js";

const cwd = "/home/lhy/dev/llm/VulLab/darkhttpd";
const engineDir = "/home/lhy/dev/llm/VulnHunter-engine";

const ctx = {
  cwd,
  engineDir,
  workdir: cwd + "/.vulnforge",
  params: { vuln_focus: "内存安全与 HTTP 请求解析问题", sandbox_cfg: "ssh sandbox-mruby", mode: "direct" },
  node: (name, opts) => runNode(ctx, name, opts),
  report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] [workflow]`, m),
};

console.log("=== Phase 0 冒烟开始 ===");
try {
  await workflow.run(ctx);
  console.log("=== 冒烟结束 ===");
} catch (e) {
  console.error("=== 冒烟异常 ===", e);
  process.exit(1);
}
