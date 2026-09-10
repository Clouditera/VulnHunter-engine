// audit-lite 实跑驱动（fish 09-09 测试）：darkhttpd + glm-5.3-flash，hunt 2 轮，每轮前 2 条 HYP 跑链
import { readFileSync, writeFileSync } from "node:fs";

const engineDir = "/home/lhy/dev/llm/VulnHunter-engine";
const cwd = "/tmp/lite-target";

const mod = await import(`${engineDir}/.dist/workflows/audit-lite.js`);
const run = mod.run;

const ctx = {
  cwd,
  engineDir,
  workdir: cwd + "/.vulnforge",
  params: { rounds: "2", chain_filter: "2", vuln_focus: "内存安全与输入解析问题" },
  report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m),
};

const t0 = Date.now();
try {
  await run(ctx);
  console.log(`=== audit-lite 完成，耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟 ===`);
} catch (e) {
  console.error("=== 异常 ===", e);
  process.exitCode = 1;
}
process.exit(0);
