// 阶段化驱动（fish 09-09）：每个阶段独立触发、可单独重跑
//   node stage.mjs onboard|build|research|compress|hunt1|hunt2|hunt3
//   node stage.mjs chain HYP-hunt1-H1
//   node stage.mjs exp
// 状态：/tmp/lite-target/.vulnforge/stage-state.json（init 会话文件路径 + 进度标记）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSession, buildPrompt } from "/home/lhy/dev/llm/VulnHunter-engine/.dist/extensions/runner/session.js";

const engineDir = "/home/lhy/dev/llm/VulnHunter-engine";
const cwd = "/tmp/lite-target";
const workdir = join(cwd, ".vulnforge");
mkdirSync(join(workdir, "leads"), { recursive: true });
const stateFile = join(workdir, "stage-state.json");

const ctx = { cwd, engineDir, workdir, params: { vuln_focus: "内存安全与输入解析问题" }, report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m) };

const loadSt = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf-8")) : { roundsDone: 0 });
const saveSt = (st) => writeFileSync(stateFile, JSON.stringify(st, null, 2));

async function openInit(st, fresh = false) {
  if (!fresh && st.initSessionFile && existsSync(st.initSessionFile))
    return startSession(ctx, { agent: "init-host", id: "init", sessionFile: st.initSessionFile, binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
  return startSession(ctx, { agent: "init-host", id: "init", binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
}
const leadsNow = () => readdirSync(join(workdir, "leads")).filter((f) => f.startsWith("HYP-"));
const advCount = () => readdirSync(join(workdir, "leads")).filter((f) => f.startsWith("ADV-")).length;

const stage = process.argv[2];
const arg = process.argv[3];
const st = loadSt();

if (stage === "onboard") {
  const s = await openInit(st, true);
  const r = await s.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。"), { start: "onboard-start[∅]", done: "onboard-done[on][+profiler]" });
  if (r.aborted) throw new Error("API aborted");
  st.initSessionFile = s.sessionFile(); st.onboard = true; saveSt(st); s.close();
} else if (stage === "build" || stage === "research") {
  const s = await openInit(st);
  const ing = stage === "build" ? "on" : "on,bu";
  const before = advCount();
  const r = await s.prompt(buildPrompt(ctx, stage, `${stage} 任务。`), { start: `${stage}-start[${ing}]` });
  if (r.aborted) throw new Error("API aborted");
  s.mark(stage === "build" ? "build-done[on,bu][+build-state]" : `research-done[on,bu,re][+ADV×${advCount() - before},wiki]`);
  st[stage] = true; st.initSessionFile = s.sessionFile(); saveSt(st); s.close();
} else if (stage === "compress") {
  const s = await openInit(st);
  await s.goto("onboard-start", { summarize: true, summaryLabel: "init[Σ(on,bu,re)]",
    customInstructions: "保留：项目画像与威胁模型要点、构建部署要点、关键代码区域与行号、漏洞认可口径、检索到的情报结论。丢弃：过程性输出与重复细节。摘要正文控制在 4000 字以内。" });
  st.compressed = true; st.initSessionFile = s.sessionFile(); saveSt(st); s.close();
} else if (/^hunt(\d+)$/.test(stage || "")) {
  const r0 = Number(stage.match(/\d+/)[0]);
  const s = await openInit(st);
  const rn = `hunt${r0}`, mine = `h${r0}`;
  const sigmaPrev = Array.from({ length: r0 - 1 }, (_, i) => `Σhunt${i + 1}`);
  if (r0 === 1) s.mark("hunt-start[init]");
  s.setBinding({ advId: rn });
  s.setCoverage(true);
  const before = new Set(leadsNow());
  const angle = r0 === 1 ? "系统性通读范围内的代码，沿真实数据流挖掘" : r0 === 2 ? "换角度：边界条件、整数/长度运算、编码转换细节" : "换角度：跨函数状态组合、契约缝隙";
  const r = await s.prompt(`hunt 任务（第 ${r0} 轮）。审计范围：整份代码。${angle}，尽可能挖掘风险假设（HYP），每条落到具体 file:line；与前几轮已提的重复不提。`,
    { start: `${rn}-start[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""}]` });
  if (r.aborted) throw new Error("API aborted");
  const news = leadsNow().filter((f) => !before.has(f));
  s.mark(`${rn}-done[init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""},${mine}][+${news.length}HYP]`);
  await s.goto("hunt-start", { summarize: true, summaryLabel: `Σhunt${r0}`,
    customInstructions: "只保留本轮新提出的 HYP 标题+一句话主张+关键锚点行号，以及读过的代码区域清单；丢弃推演过程。控制在 2000 字内。" });
  s.setCoverage(false);
  st.roundsDone = r0; st.initSessionFile = s.sessionFile(); saveSt(st); s.close();
} else if (stage === "chain") {
  const hypId = arg?.replace(/\.md$/, "");
  if (!hypId) throw new Error("用法：stage.mjs chain HYP-huntN-Hn");
  const birthRound = Number(hypId.match(/HYP-hunt(\d+)-/)?.[1] ?? "1");
  const sigmaPrev = Array.from({ length: birthRound - 1 }, (_, i) => `Σhunt${i + 1}`);
  const ing = `Σ(init${sigmaPrev.length ? "," + sigmaPrev.join(",") : ""},h${birthRound})`;
  const hypShort = hypId.replace(/^HYP-/, "");
  const init = await openInit(st);
  await init.goto(`hunt${birthRound}-done`);
  const chain = await init.fork(`init/h${birthRound}/chain-${hypId}`, "hyp-chain", { hypId });
  try { await chain.compact("保留：当前研判 HYP 的主张/锚点/相关代码细节与推理、项目画像与构建要点；丢弃无关过程。"); }
  catch (e) { ctx.report(`启动 compact 跳过（${String(e).includes("too small") ? "过小" : String(e).slice(0, 60)}）`); }
  const r = await chain.prompt(buildPrompt(ctx, "verify", "verify 任务，研判风险假设的成立性。", `风险假设：leads/${hypId}.md`),
    { start: `ve(${hypShort})-start[${ing}]` });
  if (r.aborted) throw new Error("API aborted");
  const bugDir = join(workdir, "findings", hypShort.replace(/^/, "BUG-"));
  chain.mark(existsSync(bugDir) ? `ve(${hypShort})-done[${ing},ve(${hypShort})][+BUG-${hypShort}·confirmed]` : `ve(${hypShort})-done[${ing},ve(${hypShort})][+refuted]`);
  chain.close(); init.close();
} else if (stage === "exp") {
  const s = await openInit(st);
  await s.goto("init[Σ(on,bu,re)]");
  const x = await s.fork("init/exp-build", "exp-build");
  const r = await x.prompt(buildPrompt(ctx, "exp-build", "exp-build 任务，为已确认 finding 构造武器化 exp。"), { start: "exp:start[Σ(on,bu,re)]" });
  if (r.aborted) throw new Error("API aborted");
  x.mark("exp:done"); x.close(); s.close();
} else {
  console.log("用法：stage.mjs onboard|build|research|compress|hunt1..3|chain HYP-xxx|exp");
  process.exit(1);
}
console.log(`=== 阶段 ${stage} 完成 ===`);
process.exit(0);
