// interrupted-resume 验收的子进程驱动：用真实 runtime.runStages 跑一个 mock 阶段化 workflow。
// argv: <targetDir> <runId> <mode>   mode: die-at-3（第3轮中途挂起等待被杀）| resume-auto（复刻 index.ts resume 定位）
import { mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runStages, defineStagedWorkflow, convergeInterrupted } from "../extensions/vulnhunter-runner/src/runtime.ts";

const [target, runId, mode] = process.argv.slice(2);
const workdir = join(target, ".vulnforge");
mkdirSync(join(workdir, "system", "runs"), { recursive: true });

const mark = (m: string) => { appendFileSync(join(target, "marks.txt"), m + "\n"); if (mode === "die-at-3" && m === "hunt2-done") appendFileSync(join(target, "ready"), "1"); };
const ctx: any = {
  cwd: target,
  engineDir: target,
  workdir,
  params: {},
  node: () => { throw new Error("unused"); },
  report: () => {},
};

// mock workflow：hunt 类阶段逐轮落盘（save 先于 mark，与 audit-lite 同序），共 4 轮；after 阶段验证后续联动。
const wf = defineStagedWorkflow({
  name: "mock-wf",
  description: "interrupted 恢复验收 mock",
  stages: () => [
    { name: "init", run: async () => { mark("init-done"); } },
    {
      name: "hunt",
      run: async (s) => {
        const d = s.state.data as any;
        const observed = (s.state.stages as any).hunt;
        if (mode === "resume-auto") console.log(`HUNT_STATUS_AT_RERUN=${observed}`);
        for (let r0 = ((d.huntRound as number | undefined) ?? 0) + 1; r0 <= 4; r0++) {
          const rn = `hunt${r0}`;
          ((d.roundHyps ??= {}) as any)[rn] = [`HYP-r${r0}`];
          d.huntRound = r0;
          s.save();               // save 先于 mark（非原子窗口收窄，同 audit-lite 定稿顺序）
          if (mode === "die-at-3" && r0 === 3) await new Promise(() => {});   // 卡在 save 与 mark 之间，等待父进程 kill -9
          mark(`${rn}-done`);
        }
      },
    },
    { name: "after", run: async () => { mark("after-done"); } },
  ],
});

if (mode === "resume-auto") {
  // 复刻 index.ts 生产路径：readRuns 投影（只挑 runId/workflow/stages/data 四字段，不读完整 JSON）
  // → failed|interrupted 定位 → 未收敛历史 run 对副本同规则预判（不落盘）。
  // 防回归（评审 f5fa8a48）：投影缺 data 时预判抛 TypeError；定位读未收敛原对象时永远定位不到。
  const statePath = join(workdir, "system", "runs", `mock-wf-${runId}.json`);
  const j = JSON.parse(readFileSync(statePath, "utf-8"));
  const last: any = { runId: j.runId, workflow: j.workflow, stages: j.stages ?? {}, data: j.data ?? {} };   // = readRuns 投影输出
  let failed = Object.entries(last.stages as Record<string, string>).find(([, v]) => v === "failed" || v === "interrupted")?.[0];
  if (!failed) {
    const copy = JSON.parse(JSON.stringify(last));
    convergeInterrupted(copy);
    failed = Object.entries(copy.stages as Record<string, string>).find(([, v]) => v === "failed" || v === "interrupted")?.[0];
  }
  console.log(`LOCATED_FROM=${failed ?? ""}`);
  if (!failed) { console.error("未定位到 failed/interrupted 阶段"); process.exit(2); }
  await runStages(wf, ctx, { runId, from: failed });
} else {
  await runStages(wf, ctx, { runId });
}
console.log("DRIVER_DONE");
