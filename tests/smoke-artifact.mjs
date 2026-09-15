// artifact 元工具冒烟：真实会话走 list→spec→create hyp→query hyp
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startSession, buildPrompt } from "/home/lhy/dev/llm/VulnHunter-engine/extensions/vulnhunter-runner/.dist/src/session.js";

const engineDir = "/home/lhy/dev/llm/VulnHunter-engine";
const cwd = "/home/lhy/dev/llm/VulLab/darkhttpd";
mkdirSync(join(cwd, ".vulnforge", "leads"), { recursive: true });

const ctx = { cwd, engineDir, workdir: join(cwd, ".vulnforge"), params: { no_research: "1" }, report: (m) => console.log("[r]", m) };

const s = await startSession(ctx, { agent: "hunt-intuition", id: "smoke-artifact", binding: { advId: "ADV-C0-A1" } });
const r = await s.prompt(buildPrompt(ctx, "hunt-intuition",
  "安全审计任务。范围：darkhttpd.c 中 HTTP 请求行与 header 解析部分（约前 1500 行）。凭安全直觉快速判断。发现一个可疑点就先用 artifact({op:\"spec\", type:\"hyp\"}) 查字段规格，再用 artifact create hyp 提出（只提 1 条最强的）。"));
console.log("prompt 结束, aborted =", r.aborted);
s.close();

const leads = readdirSync(join(cwd, ".vulnforge", "leads")).filter((f) => f.startsWith("HYP-"));
console.log("leads 目录 HYP:", leads);
if (leads.length) console.log("首条开头:", readFileSync(join(cwd, ".vulnforge", "leads", leads[0]), "utf-8").slice(0, 120));
process.exit(leads.length ? 0 : 1);
