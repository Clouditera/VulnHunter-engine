/**
 * 阶段×工具矩阵断言（工具级限制的单一事实源守卫；会话装配测试在 Phase 2 扩展）。
 * 运行：node tests/stage-tools.spec.mjs（先构建 .dist）
 */
import { STAGE_TOOLS, stageTools } from "../.dist/src/tools/common.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
const norm = (a) => [...a].sort().join(",");
const expect = {
  onboard: ["profiler"],
  "init-host": ["profiler", "hyp", "sandbox"],
  build: ["sandbox"],
  research: ["hyp"],
  compress: [],
  hunt: ["hyp"],
  "hunt-intuition": ["hyp"],
  "static-verify": ["hyp", "finding"],
  "dynamic-verify": ["hyp", "finding", "sandbox"],
  "hyp-chain": ["hyp", "finding", "sandbox"],
  "ev-assess": ["finding", "sandbox"],
};

for (const [stage, tools] of Object.entries(expect)) {
  if (norm(stageTools(stage)) === norm(tools)) { console.log("PASS", stage, "→", tools.join("+")); pass++; }
  else { console.log("FAIL", stage, "-", `[${stageTools(stage)}] != [${tools}]`); fail++; }
}
if (Object.keys(STAGE_TOOLS).length === Object.keys(expect).length) { console.log("PASS 表条目数一致"); pass++; }
else { console.log("FAIL 表条目数", Object.keys(STAGE_TOOLS).length, "!=", Object.keys(expect).length); fail++; }
if (stageTools("nope").length === 0) { console.log("PASS 未知阶段=空"); pass++; } else { console.log("FAIL 未知阶段非空"); fail++; }

console.log(`\nstage-tools.spec: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
