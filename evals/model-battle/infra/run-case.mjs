// 评测用例驱动（容器内跑）：环境变量驱动，结果写 /out
//   EVAL_MODEL   — glm-5.2 / glm-5.3 / glm-5.3-flash
//   EVAL_CASE    — 用例名（日志用）
//   VULN_FOCUS / SANDBOX_CFG / MODE — 同 smoke-driver
import { readFileSync, writeFileSync } from "node:fs";

const engineDir = "/opt/vulnforge";
const cwd = "/target";
const model = process.env.EVAL_MODEL || "glm-5.3-flash";
const caseName = process.env.EVAL_CASE || "unnamed";

// 每用例指定模型：settings.json 已默认 zai-coding-cn，这里覆盖模型项
const settingsPath = `${engineDir}/settings.json`;
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
settings.defaultModel = model;
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

const workflow = (await import(`${engineDir}/.dist/workflows/audit-direct.js`)).default;

const t0 = Date.now();
const logs = [];
const ctx = {
  cwd,
  engineDir,
  workdir: cwd + "/.vulnforge",
  params: {
    vuln_focus: process.env.VULN_FOCUS || "内存安全与输入解析问题",
    ...(process.env.NO_RESEARCH === "1" ? { no_research: "1" } : {}),
    ...(process.env.SANDBOX_CFG ? { sandbox_cfg: process.env.SANDBOX_CFG } : {}),
  },
  node: undefined, // audit-direct 不用 ctx.node（lib 直接走 session.ts）
  report: (m) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; logs.push(line); console.log(line); },
};

console.log(`=== 用例 ${caseName} 开始（模型 ${model}）===`);
try {
  await workflow.run(ctx);
  console.log(`=== 用例 ${caseName} 完成，耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟 ===`);
} catch (e) {
  console.error(`=== 用例 ${caseName} 异常 ===`, e);
  process.exitCode = 1;
} finally {
  try {
    writeFileSync(`/out/${caseName}.log`, logs.join("\n") + "\n");
  } catch { /* /out 未挂载时跳过 */ }
}
