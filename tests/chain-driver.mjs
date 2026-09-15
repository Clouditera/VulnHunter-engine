// HYP 链阶段单测驱动：复活 init → 对 leads 里的 HYP 逐条跑 runHypChain（verify only，不动态）
import { Pool } from "../extensions/vulnhunter-runner/.dist/pools.js";
import { startSession } from "../extensions/vulnhunter-runner/extensions/vulnhunter-runner/.dist/src/session.js";
import { runHypChain } from "./extensions/vulnhunter-runner/.dist/src/workflows/lib.js";
import { pending } from "../extensions/vulnhunter-runner/.dist/queue.js";
import { readFileSync } from "node:fs";

const ctx = {
  cwd: "/home/lhy/dev/llm/VulLab/darkhttpd",
  engineDir: "/home/lhy/dev/llm/VulnHunter-engine",
  workdir: "/home/lhy/dev/llm/VulLab/darkhttpd/.vulnforge",
  params: {},  // 无 sandbox_cfg → 只跑 verify
  report: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m),
};
const st = JSON.parse(readFileSync(ctx.workdir + "/run-state.json", "utf-8"));
const init = await startSession(ctx, { agent: "init-host", id: "init", sessionFile: st.init_session_file, binding: { advId: "ADV-C0-A1", runNo: 1 } });
ctx.report("init 复活");
const verifyPool = new Pool("verify", 5);
const sandboxPool = new Pool("sandbox", 1);
const chains = pending(ctx.workdir, "HYP").map((f) => runHypChain(ctx, init, f, { verifyPool, sandboxPool }));
const results = await Promise.allSettled(chains);
results.forEach((r, i) => { if (r.status === "rejected") console.log(`链 ${i} rejected:`, r.reason); });
ctx.report("全部链结束");
process.exit(0);
