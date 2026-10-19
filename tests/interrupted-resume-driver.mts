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
  // 复刻 index.ts resume 自动定位：failed | interrupted 同权；未收敛的历史 run 同规则预判（不落盘）
  const statePath = join(workdir, "system", "runs", `mock-wf-${runId}.json`);
  const st = JSON.parse(readFileSync(statePath, "utf-8"));
  const failed = Object.entries(st.stages as Record<string, string>).find(([, v]) => v === "failed" || v === "interrupted")?.[0]
    ?? (convergeInterrupted(st), Object.entries(st.stages as Record<string, string>).find(([, v]) => v === "failed" || v === "interrupted")?.[0]);
  console.log(`LOCATED_FROM=${failed ?? ""}`);
  if (!failed) { console.error("未定位到 failed/interrupted 阶段"); process.exit(2); }
  await runStages(wf, ctx, { runId, from: failed });
} else {
  await runStages(wf, ctx, { runId });
}
console.log("DRIVER_DONE");
