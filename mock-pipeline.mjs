// 产物契约演练驱动（fish 09-08）：顺序执行各任务节点，mock 产出验证目录结构与产物提示词可用性
// 不做真实审计——每步提示词都要求直接编 mock 产物（格式真、内容可假）。
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startSession, buildPrompt } from "/home/lhy/dev/llm/VulnHunter-engine/.dist/extensions/runner/session.js";

const engineDir = "/home/lhy/dev/llm/VulnHunter-engine";
const cwd = "/tmp/mock-target";
const workdir = join(cwd, ".vulnforge");
const ctx = { cwd, engineDir, workdir, params: {}, report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m) };

const MOCK = "\n\n【演练模式】本次是产物契约演练，不做真实审计：不要真的去读代码/检索，直接编造内容合理、格式严格符合任务书要求的 mock 产物（锚点 file:line 格式必须真实，内容可以是假想的）。重点是按任务书调用 artifact 工具把产物按规格落盘，并组织好产物目录。";
const fails = [];
async function step(name, fn) {
  ctx.report(`—— ${name} ——`);
  try { await fn(); } catch (e) { fails.push(`${name}: ${String(e).slice(0, 120)}`); ctx.report(`${name} 异常: ${e}`); }
}

// 1) init-host：onboard → build → research 同会话三段
let init;
await step("init-host 启动", async () => {
  init = await startSession(ctx, { agent: "init-host", id: "mock-init", binding: { advId: "ADV-C0-A1", runNo: 1, advLine: "S" } });
});
await step("onboard(mock)", async () => {
  const r = await init.prompt(buildPrompt(ctx, "onboard", "onboard 任务，初始化整个审计任务。") + MOCK + "\n产出 mock：profiler 五节至少填三节。");
  if (r.aborted) throw new Error("aborted");
});
await step("build(mock)", async () => {
  const r = await init.prompt(buildPrompt(ctx, "build", "build 任务，理解项目的构建与部署方式并落 build-state。") + MOCK + "\n产出 mock：build-state（status=available，body 含构建系统/命令/拓扑）。");
  if (r.aborted) throw new Error("aborted");
});
await step("research(mock)", async () => {
  const r = await init.prompt(buildPrompt(ctx, "research", "research 任务，检索公开信息与 git 信息、补齐漏洞认可口径。") + MOCK + "\n产出 mock：create adv 一条（S 线）+ create lead 一条（research）。");
  if (r.aborted) throw new Error("aborted");
});

// 2) cognize：产 C 线 ADV + query coverage
await step("cognize(mock)", async () => {
  const s = await startSession(ctx, { agent: "cognize", id: "mock-cognize", binding: { runNo: 1, advLine: "C" } });
  const r = await s.prompt(buildPrompt(ctx, "cognize", "cognize 任务，构建认知、产出审计链路。") + MOCK + "\n产出 mock：create adv 一条（C 线）+ query coverage(global) 一次。");
  if (r.aborted) throw new Error("aborted");
  s.close();
});

// 3) hunt：沿 ADV-C1-A1 产 HYP×2 + LEAD
await step("hunt(mock)", async () => {
  const s = await startSession(ctx, { agent: "hunt", id: "mock-hunt", binding: { advId: "ADV-C1-A1" } });
  const r = await s.prompt(buildPrompt(ctx, "hunt", "hunt 任务，沿审计链路 ADV-C1-A1 精读。") + MOCK + "\n产出 mock：create hyp 两条 + create lead 一条（hunt）+ 先 query hyp 查重一次。");
  if (r.aborted) throw new Error("aborted");
  s.close();
});

// 4) hyp-chain：verify→poc-verify→ev-assess 同会话（绑定第一条 HYP）
await step("hyp-chain(mock) verify+poc+ev", async () => {
  const s = await startSession(ctx, { agent: "hyp-chain", id: "mock-chain", binding: { hypId: "HYP-C1-A1-H1" } });
  let r = await s.prompt(buildPrompt(ctx, "verify", "verify 任务，研判风险假设 HYP-C1-A1-H1 的成立性。") + MOCK + "\n裁决 confirmed，产出 mock：create finding（字段全，先 spec 查规格）。");
  if (r.aborted) throw new Error("verify aborted");
  r = await s.prompt(buildPrompt(ctx, "poc-verify", "poc-verify 任务，在沙箱中复现 finding BUG-C1-A1-H1。") + MOCK + "\n产出 mock：update finding poc_status=reproduced + poc_evidence。");
  if (r.aborted) throw new Error("poc aborted");
  r = await s.prompt(buildPrompt(ctx, "ev-assess", "ev-assess 任务，评估 finding BUG-C1-A1-H1 在真实业务场景下的影响。") + MOCK + "\n产出 mock：update finding 的 ev_* 字段 + exp_status=reproduced。");
  if (r.aborted) throw new Error("ev aborted");
  s.close();
});

// 5) exp-build：回写 + exploits/ 目录
await step("exp-build(mock)", async () => {
  const s = await startSession(ctx, { agent: "exp-build", id: "mock-exp", binding: { hypId: "HYP-C1-A1-H1" } });
  const r = await s.prompt(buildPrompt(ctx, "exp-build", "exp-build 任务，为 finding BUG-C1-A1-H1 构造武器化 exp。") + MOCK + "\n产出 mock：exploits/ 目录写一个假 exp 文件（write 工具）+ update finding 备注。");
  if (r.aborted) throw new Error("aborted");
  s.close();
});

if (init) init.close();
console.log(fails.length ? `演练完成（有失败）：${fails.join(" | ")}` : "演练完成（全部步骤无异常）");
process.exit(0);
