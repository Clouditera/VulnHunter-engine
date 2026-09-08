// 直觉评测驱动（容器内跑）：无 init，文件级 scope，hunt1→compact→hunt2→compact→hunt3
// 环境变量：
//   EVAL_PROJECT   项目名（intuition-set.json 里的 project）
//   EVAL_MODEL     模型
//   ROUNDS         hunt 轮数（默认 3）
//   CONCURRENCY    同容器内 scope 会话并发数（默认 2）
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSession, buildPrompt } from "/opt/vulnforge/.dist/extensions/runner/session.js";

const engineDir = "/opt/vulnforge";
const cwd = "/target";
const model = process.env.EVAL_MODEL;
const projectName = process.env.EVAL_PROJECT;
const rounds = Number(process.env.ROUNDS || "3");
const conc = Number(process.env.CONCURRENCY || "2");
const manifest = JSON.parse(readFileSync(`${engineDir}/evals/model-battle/intuition/intuition-set.json`, "utf-8"));
const proj = manifest.projects.find((p) => p.project === projectName);
if (!proj) { console.error(`未知项目 ${projectName}`); process.exit(1); }

// 模型/供应商/思考档
const settingsPath = `${engineDir}/settings.json`;
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
settings.defaultModel = model;
settings.defaultProvider = model.startsWith("deepseek") ? "cloudrouter" : "zai-coding-cn";
settings.defaultThinkingLevel = process.env.THINKING || "max";
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

mkdirSync(join(cwd, ".vulnforge", "leads"), { recursive: true });

const ctx = {
  cwd, engineDir, workdir: cwd + "/.vulnforge",
  params: { no_research: "1" },
  report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m),
};

/** 计算文件级 scope 说明：>3000 行按 anchor 定位取窗口 */
function scopeNote(f) {
  const full = `/target/${f.path}`;
  if (!existsSync(full)) return `${f.path}（⚠️ 文件不存在！）`;
  const lines = readFileSync(full, "utf-8").split("\n");
  if (lines.length <= 3000) return `${f.path}（共 ${lines.length} 行，全量审计）`;
  let a = -1;
  try { const re = new RegExp(f.anchor); a = lines.findIndex((l) => re.test(l)); } catch {}
  if (a < 0) a = Math.floor(lines.length / 2);
  const from = Math.max(1, a + 1 - 1500), to = Math.min(lines.length, a + 1 + 1500);
  return `${f.path}（共 ${lines.length} 行，只审计第 ${from}-${to} 行区间）`;
}

function sessionUsage(workdir, sessionFile) {
  let ti = 0, to = 0;
  try {
    for (const line of readFileSync(sessionFile, "utf-8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
          ti += (e.message.usage.input || 0) + (e.message.usage.cacheRead || 0);
          to += e.message.usage.output || 0;
        }
      } catch {}
    }
  } catch {}
  return { inputInclCache: ti, output: to };
}

async function runSession(spec) {
  if (existsSync(`/out/${spec.name}/_meta.json`)) { ctx.report(`会话 ${spec.name} 已有结果，跳过`); return; }
  const notes = spec.files.map(scopeNote);
  ctx.report(`会话 ${spec.name} 开始，scope: ${notes.join("；")}`);
  const hypPrefix = `HYP-${spec.name}-`;  // 归档按会话名精确前缀归因（并发会话共享 leads 目录，before/after 差集会抢隔壁的 HYP）
  const s = await startSession(ctx, { agent: "hunt-intuition", id: spec.name, binding: { advId: spec.name } });
  try {
    for (let r = 1; r <= rounds; r++) {
      const angle = r === 1
        ? "通读范围内代码，沿真实数据流找风险"
        : r === 2
          ? "换角度：边界条件、整数/长度运算、编码/解析转换细节"
          : "换角度：跨函数状态组合、调用方与被调方的契约缝隙、错误路径";
      const rr = await s.prompt(buildPrompt(ctx, "hunt-intuition",
        `安全审计任务（第 ${r} 轮）。审计范围严格限定：${notes.join("；")}。${angle}。凭安全直觉快速判断，无需深入研究、无需动态确认。发现可疑点调 emit_hyp（file:line 锚点+一句话主张）。与前几轮已提的重复不提。确认没有新东西就明说。`));
      if (rr.aborted) { ctx.report(`${spec.name} 第 ${r} 轮 aborted`); break; }
      if (r < rounds) {
        // compactToHunt<r>：压缩保留本轮发现（线性瘦身，不跳分支）
        try { await s.compact("保留：已提出的 HYP 清单（标题+一句话主张+锚点行号）；丢弃：推演过程与重复代码细节。"); }
        catch (e) { ctx.report(`${spec.name} compact 跳过（${String(e).includes("too small") ? "上下文过小" : e}）`); }
      }
    }
  } finally {
    // 用量统计（按会话文件，逐会话口径）
    const sf = s.sessionFile?.();
    const usage = sf ? sessionUsage(ctx.workdir, sf) : null;
    s.close();
    // 归档本会话产出的 HYP
    const after = readdirSync(join(ctx.workdir, "leads")).filter((f) => f.startsWith(hypPrefix));
    try {
      mkdirSync(`/out/${spec.name}`, { recursive: true });
      for (const f of after) {
        try { copyFileSync(join(ctx.workdir, "leads", f), `/out/${spec.name}/${f}`); rmSync(join(ctx.workdir, "leads", f)); }
        catch (e) { ctx.report(`归档单文件失败 ${f}: ${e}`); }
      }
      writeFileSync(`/out/${spec.name}/_meta.json`, JSON.stringify({
        session: spec.name, model, project: proj.project, version: proj.version,
        scope: notes, vulns: spec.vulns, hyps: after, usage,
      }, null, 2));
    } catch (e) { ctx.report(`out 归档失败: ${e}`); }
    ctx.report(`会话 ${spec.name} 完成：${after.length} 条 HYP，usage=${usage ? (usage.inputInclCache / 1e6).toFixed(1) + "M" : "?"}`);
  }
}

console.log(`=== 直觉评测开始：${model} @ ${proj.project}-${proj.version}，${proj.sessions.length} 个 scope 会话，并发 ${conc}，思考档 ${settings.defaultThinkingLevel} ===`);
const queue = [...proj.sessions];
const workers = Array.from({ length: Math.min(conc, queue.length) }, async () => {
  while (queue.length) { const spec = queue.shift(); if (spec) await runSession(spec); }
});
await Promise.all(workers);
console.log(`=== 直觉评测完成：${model} @ ${proj.project} ===`);
process.exit(0);
