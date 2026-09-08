// 阶段 A（漏洞发现）评测驱动：init 一次 → 逐用例 fork + 定向 hunt
// 容器内运行。环境变量：
//   EVAL_MODEL   模型
//   EVAL_CASES   JSON：[{name, scope}]（scope=模块级审计范围描述）
//   ROUNDS       每用例 hunt 轮数（默认 1）
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "/opt/vulnforge/.dist/workflows/lib.js";
import { buildPrompt } from "/opt/vulnforge/.dist/extensions/runner/session.js";

const engineDir = "/opt/vulnforge";
const cwd = "/target";
const model = process.env.EVAL_MODEL;
const cases = JSON.parse(process.env.EVAL_CASES || "[]");
const rounds = Number(process.env.ROUNDS || "3");

// 模型切换
const settingsPath = `${engineDir}/settings.json`;
const settings = JSON.parse((await import("node:fs")).readFileSync(settingsPath, "utf-8"));
settings.defaultModel = model;
settings.defaultProvider = model.startsWith("deepseek") ? "cloudrouter" : "zai-coding-cn";
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

mkdirSync(join(cwd, ".vulnforge", "leads"), { recursive: true });

const ctx = {
  cwd, engineDir, workdir: cwd + "/.vulnforge",
  params: { no_research: "1", vuln_focus: process.env.VULN_FOCUS || "内存安全与输入解析" },
  report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m),
};

console.log(`=== 阶段A 开始：${model}，${cases.length} 个用例 ===`);
const init = await runInit(ctx);
if (!init) { console.error("init 失败"); process.exit(1); }

for (const c of cases) {
  const before = new Set(readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith("HYP-")));
  console.log(`--- 用例 ${c.name}（scope: ${c.scope}）---`);
  const h = await init.fork(`case-${c.name}`, "hunt", { advId: "ADV-C0-A1" });
  try {
    h.mark("case-start");
    for (let r = 1; r <= rounds; r++) {
      const angle = r === 1 ? "系统性通读范围内的代码，沿真实数据流挖掘" : (r === 2 ? "换角度：边界条件、整数/长度运算、编码转换细节" : "换角度：跨函数状态组合、调用方与被调方的契约缝隙");
      const rr = await h.prompt(buildPrompt(ctx, "hunt",
        `hunt 任务（第 ${r} 轮）。审计范围严格限定：${c.scope}。${angle}，尽可能挖掘风险假设（HYP），每条落到具体 file:line；范围外的不要追；与前几轮已提的 HYP 重复的不提。确认没有新东西就明说。`));
      if (rr.aborted) break;
      if (r < rounds) {
        // pi tree 跳回任务起点，本轮关键发现以摘要留在会话里（发现累积）
        await h.goto("case-start", {
          summarize: true,
          summaryLabel: `${c.name}-r${r}`,
          customInstructions: "只保留本轮新提出的 HYP 标题+一句话主张+关键锚点行号，以及读过的代码区域清单；丢弃推演过程。",
        });
      }
    }
  } finally {
    h.close();
  }
  // 收集本用例产出的 HYP，归档到 /out/<case>/
  const after = readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith("HYP-") && !before.has(f));
  try {
    mkdirSync(`/out/${c.name}`, { recursive: true });
    for (const f of after) {
      try { copyFileSync(join(ctx.workdir, "leads", f), `/out/${c.name}/${f}`); rmSync(join(ctx.workdir, "leads", f)); }
      catch (e) { console.log(`归档单文件失败 ${f}:`, String(e)); }  // 失败则文件留在容器 leads 里
    }
    writeFileSync(`/out/${c.name}/_meta.json`, JSON.stringify({ case: c.name, model, scope: c.scope, hyps: after }, null, 2));
  } catch (e) { console.log("out 归档失败:", String(e)); }
  console.log(`--- 用例 ${c.name} 完成：${after.length} 条 HYP ---`);
}
init.close();
// 持久化本次运行的 token 用量到 /out（防止容器清理后丢失）
try {
  const { readdirSync: rd, readFileSync: rf, statSync } = await import("node:fs");
  let ti = 0, to = 0;
  const walk = (d) => { for (const f of rd(d)) { const fp = join(d, f); try { if (statSync(fp).isDirectory()) walk(fp); else if (f.endsWith(".jsonl")) for (const line of rf(fp, "utf8").split("\n")) { if (!line.includes('"usage"')) continue; try { const e = JSON.parse(line); if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) { ti += (e.message.usage.input || 0) + (e.message.usage.cacheRead || 0); to += e.message.usage.output || 0; } } catch {} } } catch {} } };
  walk(join(ctx.workdir, "sessions"));
  writeFileSync(`/out/_usage-${model}-${Date.now()}.json`, JSON.stringify({ model, inputInclCache: ti, output: to, cases: cases.map(c => c.name) }, null, 2));
} catch (e) { console.log("usage 归档失败:", String(e)); }
console.log(`=== 阶段A 完成 ===`);
process.exit(0);
