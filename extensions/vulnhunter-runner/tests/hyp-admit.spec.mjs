/**
 * HYP 准入闸测试（HALL-66：schema 扩展 novelty_basis/confidence + admit() 判定）。
 * 运行：node tests/hyp-admit.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHypTool, readHyp, hypIds, sameTarget, sameVulnClass, similarity, admit } from "../.dist/src/tools/hyp.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}
const tmp = () => mkdtempSync(join(tmpdir(), "hyp-admit-"));
const ws = (dir) => ({ workdir: dir, cwd: dir });
const isErr = (r) => r?.isError === true;
const txt = (r) => r?.content?.[0]?.text ?? "";

const BODY = "## 主张\n**代码锚点**：src/auth.c:42 login()\n风险类型：CWE-89 SQL 注入";
const mk = (over = {}) => ({ op: "create", body: BODY, novelty_basis: "首个涉及 login() SQL 拼接的假设", confidence: "med", ...over });

// ---------------------------------------------------------------- schema 扩展
await t("hyp：create 需要 novelty_basis + confidence；缺项/非法值打回", async () => {
  const dir = tmp(); const tool = makeHypTool(ws(dir), { tag: "hunt1" });
  assert(isErr(await tool.execute("", { op: "create", body: BODY })), "缺 novelty_basis/confidence 应打回");
  assert(isErr(await tool.execute("", mk({ novelty_basis: "   " }))), "空 novelty_basis 应打回");
  assert(isErr(await tool.execute("", mk({ novelty_basis: "N/A" }))), "占位 novelty_basis 应打回");
  assert(isErr(await tool.execute("", mk({ confidence: "sure" }))), "非法 confidence 应打回");
  const r = await tool.execute("", mk());
  assert(!isErr(r) && txt(r).includes("HYP-hunt1-H1"));
  const rec = readHyp(dir, "HYP-hunt1-H1");
  assert(rec.noveltyBasis.includes("login") && rec.confidence === "med", "新字段应落盘");
});

// ---------------------------------------------------------------- 规则判定
await t("sameTarget：归一化函数名 / file:line 相同为同靶点", async () => {
  const a = { body: "锚点 src/Auth.C:42 login()" };
  const b = { body: "位置：src/auth.c:42" };
  const c = { body: "锚点 src/other.c:9 logout()" };
  assert(sameTarget(a, b), "大小写归一化后同文件同函数应同靶点");
  assert(!sameTarget(a, c), "不同文件不同函数应不同靶点");
  assert(sameTarget({ body: "x src/a.c:7" }, { body: "y src/a.c:7" }), "同 file:line 应同靶点");
  assert(!sameTarget({ body: "x src/a.c:7" }, { body: "y src/a.c:8" }), "不同行应不同靶点");
});
await t("sameVulnClass：CWE 标签 / 模式词表匹配", async () => {
  assert(sameVulnClass({ body: "CWE-89 sql injection" }, { body: "风险 cwe-89" }), "同 CWE 应同类");
  assert(sameVulnClass({ body: "可能存在 SQL 注入" }, { body: "sqli 风险点" }), "模式词表同族应同类");
  assert(!sameVulnClass({ body: "CWE-89" }, { body: "CWE-79 XSS" }), "不同 CWE 不同类");
  assert(!sameVulnClass({ body: "缓冲区溢出" }, { body: "路径穿越" }), "不同模式词不同类");
});
await t("similarity：单点接口可调（默认规则实现）", async () => {
  const s = similarity({ body: "src/a.c:1 CWE-89" }, { body: "src/a.c:1 cwe-89" });
  assert(typeof s === "number" && s >= 0 && s <= 1, "应返回 0..1 分值");
});

// ---------------------------------------------------------------- 准入闸
await t("admit：同靶点+同类判 REJECT_DUP；low 且无 novelty_basis 判 REJECT_LOW_QUALITY", async () => {
  const h1 = { id: "HYP-hunt1-H1", body: "锚点 src/a.c:1 f()\nCWE-89", confidence: "med", novelty_basis: "首个 a.c 假设" };
  assert(admit({ body: "src/a.c:1 f() sql 注入", confidence: "high", novelty_basis: "x" }, [h1]) === "REJECT_DUP");
  assert(admit({ body: "src/b.c:2 g() CWE-89", confidence: "high", novelty_basis: "x" }, [h1]) === "ADMIT", "不同靶点应放行");
  assert(admit({ body: "src/c.c:3 h() CWE-79", confidence: "high", novelty_basis: "x" }, [h1]) === "ADMIT", "不同类应放行");
  assert(admit({ body: "src/c.c:3 h() CWE-79", confidence: "low", novelty_basis: "" }, [h1]) === "REJECT_LOW_QUALITY");
  assert(admit({ body: "src/c.c:3 h() CWE-79", confidence: "low", novelty_basis: "TODO" }, [h1]) === "REJECT_LOW_QUALITY", "占位文本视为缺失");
  assert(admit({ body: "src/c.c:3 h() CWE-79", confidence: "low", novelty_basis: "与 HYP-hunt1-H1 不同在于类别" }, [h1]) === "ADMIT", "low 但有具体差异点应放行");
});

// ---------------------------------------------------------------- 工具接线
await t("hyp create：REJECT 不落盘、写 rejected_hyps.log、编号不占位", async () => {
  const dir = tmp(); const tool = makeHypTool(ws(dir), { tag: "hunt1" });
  assert(!isErr(await tool.execute("", mk())));
  // 同靶点同类 → REJECT_DUP
  const dup = await tool.execute("", mk({ body: "锚点 src/auth.c:42 login()\nCWE-89", novelty_basis: "再提一次" }));
  assert(isErr(dup), "REJECT_DUP 应返回错误");
  assert(txt(dup).includes("REJECT_DUP"));
  // low 且 novelty_basis 实际缺失（如 null/空串）→ REJECT_LOW_QUALITY（占位文本在 schema 校验就被打回，见上）
  const lq = await tool.execute("", { op: "create", body: "src/x.c:1 f() CWE-79", confidence: "low", novelty_basis: " " });
  assert(isErr(lq) && (txt(lq).includes("novelty_basis") || txt(lq).includes("REJECT_LOW_QUALITY")));
  // 被拒不进 chains（hyp 目录无新记录，编号未被占用）
  assert(hypIds(dir).join(",") === "HYP-hunt1-H1", "被拒 HYP 不应进库");
  const logPath = join(dir, "rejected_hyps.log");
  assert(existsSync(logPath), "应写 rejected_hyps.log");
  const log = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert(log.length >= 1 && log[0].reason === "REJECT_DUP", "拒绝记录含理由");
  assert(log.every((r) => r.body && r.tag === "hunt1"), "日志含正文与 tag");
  // 后续正常 create 拿到 H2（被拒未占号）
  const ok2 = await tool.execute("", mk({ body: "src/z.c:9 h() CWE-22 路径穿越", novelty_basis: "首个 z.c 路径穿越" }));
  assert(txt(ok2).includes("HYP-hunt1-H2"), "被拒不占编号");
});

console.log(`\nhyp-admit.spec: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
