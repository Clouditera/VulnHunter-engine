// 阶段状态悬空恢复验收（HALL-70 / GH#9）：kill -9 模拟进程中断 → 收敛 interrupted → 无 from 自动续跑。
// 用法：node tests/interrupted-resume.mjs
// 前置：extensions/vulnhunter-runner/node_modules 下需有 yaml（npm install）与
//       @earendil-works/pi-*（pi 宿主安装内，软链即可）——runtime.ts 经 session.ts 传递依赖。
// 结构：父进程编排；两轮子进程跑同一个 mock 阶段化 workflow（复用真实 runtime.runStages）——
//   第 1 轮：hunt 类阶段逐轮落盘（save 先于 mark，与 audit-lite 同序），第 3 轮中途被父进程 kill -9；
//   第 2 轮：同 runId 重启，断言加载时收敛为 interrupted，且从中断轮无损续跑（round 3 重做、4 轮完成）。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, "interrupted-resume-driver.mts");
const extDir = join(here, "..", "extensions", "vulnhunter-runner");

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✅" : "❌"} ${msg}`); if (!cond) failures++; };

// ---- 第 1 轮：跑到 hunt 第 3 轮中途，kill -9 ----
const work1 = mkdtempSync(join(tmpdir(), "vh-int-"));
const home1 = mkdtempSync(join(tmpdir(), "vh-home-"));
const child1 = spawn(process.execPath, [driver, work1, "run1", "die-at-3"], {
  env: { ...process.env, HOME: home1, NODE_PATH: join(extDir, "node_modules") },
  stdio: ["ignore", "pipe", "pipe"],
});
let out1 = "";
child1.stdout.on("d", () => {});
child1.stdout.on("data", (b) => { out1 += b; });
child1.stderr.on("data", (b) => { out1 += b; });
// 等子进程把 hunt2 落盘并打出就绪哨兵（marks.txt 含 hunt2-done；此时子进程卡在 hunt3 save 后挂起）
const statePath = join(work1, ".vulnforge", "system", "runs", "mock-wf-run1.json");
const readyPath = join(work1, "ready");
const t0 = Date.now();
for (;;) {
  if (existsSync(readyPath)) break;
  if (Date.now() - t0 > 20000) { console.error("超时：子进程未推进到 hunt2-done\n" + out1); process.exit(1); }
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 200));   // 留窗口让子进程推进到 hunt3 挂起点
child1.kill("SIGKILL");
await Promise.race([new Promise((r) => child1.on("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
await new Promise((r) => setTimeout(r, 100));   // 等内核收尸，避免竞读

const st1 = JSON.parse(readFileSync(statePath, "utf-8"));
ok(st1.stages.hunt === "pending", `kill -9 后 hunt 状态悬空为 pending（实际：${st1.stages.hunt}）`);
ok(!!st1.data.stageTimes?.hunt?.start, "stageTimes.hunt.start 已记录（in-flight 证据）");
ok(st1.data.huntRound === 3, `中断前 huntRound=3（实际：${st1.data.huntRound}）`);
ok(Array.isArray(st1.data.roundHyps?.hunt3), "roundHyps.hunt3 已随 save 先于 mark 落盘（save/mark 窗口内统计不丢）");
const marks1 = existsSync(join(work1, "marks.txt")) ? readFileSync(join(work1, "marks.txt"), "utf-8").trim().split("\n") : [];
ok(!marks1.includes("hunt3-done"), `hunt3-done mark 未写出（kill 落在 save 与 mark 之间；marks=${marks1.join(",")}）`);

// ---- 第 2 轮：同 runId 重启，无 from（复刻 index.ts 生产路径：readRuns 投影 → 预判收敛 → 定位）----
const home2 = mkdtempSync(join(tmpdir(), "vh-home-"));
const child2 = spawn(process.execPath, [driver, work1, "run1", "resume-auto"], {
  env: { ...process.env, HOME: home2, NODE_PATH: join(extDir, "node_modules") },
  stdio: ["ignore", "pipe", "pipe"],
});
let out2 = "";
child2.stdout.on("data", (b) => { out2 += b; });
child2.stderr.on("data", (b) => { out2 += b; });
const code2 = await new Promise((r) => child2.on("exit", r));
ok(code2 === 0, `续跑子进程正常退出（code=${code2}）${code2 === 0 ? "" : "\n" + out2}`);
const located = (out2.match(/^LOCATED_FROM=(.*)$/m) || [])[1];
ok(located === "hunt", `resume 无 from 经 readRuns 投影定位到 hunt（实际：${located ?? "未定位"}）——复刻生产路径，防 readRuns 投影缺陷回归`);
const observed = (out2.match(/^HUNT_STATUS_AT_RERUN=(.*)$/m) || [])[1];
ok(observed === "interrupted", `加载时收敛：hunt 重跑前状态=interrupted（实际：${observed ?? "未观测"}）`);

const st2 = JSON.parse(readFileSync(statePath, "utf-8"));
ok(st2.stages.hunt === "done", `续跑完成 hunt=done（实际：${st2.stages.hunt}）`);
ok(st2.stages.after === "done", `后续阶段联动完成 after=done（实际：${st2.stages.after}）`);
ok(st2.data.huntRound === 4, `huntRound 推进到 4（实际：${st2.data.huntRound}）`);
ok(["hunt1", "hunt2", "hunt3", "hunt4"].every((k) => Array.isArray(st2.data.roundHyps?.[k])), "roundStats 完整：hunt1..hunt4 逐轮记录无丢失（无 hunt13 式缺口）");
ok((st2.data.roundHyps?.hunt3 ?? []).join() === "HYP-r3", `中断轮 hunt3 统计保留（实际：${(st2.data.roundHyps?.hunt3 ?? []).join()}）`);
const marks2 = readFileSync(join(work1, "marks.txt"), "utf-8").trim().split("\n");
ok(marks2.filter((m) => m === "hunt4-done").length === 1, `hunt4-done mark 补打恰好一次（实际 ${marks2.filter((m) => m === "hunt4-done").length} 次）`);
ok(!marks2.includes("hunt3-done"), "hunt3-done mark 按窗口语义保持缺失（统计已落盘，mark 缺口不影响续跑与展示）");

rmSync(work1, { recursive: true, force: true });
rmSync(home1, { recursive: true, force: true });
rmSync(home2, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
