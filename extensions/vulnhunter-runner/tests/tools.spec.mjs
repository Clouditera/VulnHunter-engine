/**
 * 工具层语义测试：sandbox / hyp / finding / profiler（2026-09-20 工具重构 Phase 1）。
 * 运行：node tests/tools.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandboxTool, readSandboxState } from "../.dist/src/tools/sandbox.js";
import { makeHypTool, readHyp } from "../.dist/src/tools/hyp.js";
import { makeFindingTool, readFinding } from "../.dist/src/tools/finding.js";
import { makeProfilerTool, readProfiler } from "../.dist/src/tools/profiler.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}
const tmp = () => mkdtempSync(join(tmpdir(), "tools-"));
const ws = (dir) => ({ workdir: dir, cwd: dir });
const isErr = (r) => r?.isError === true;
const txt = (r) => r?.content?.[0]?.text ?? "";

// ---------------------------------------------------------------- sandbox
await t("sandbox：初始 unknown（fail-closed 读侧）", async () => {
  assert(readSandboxState(tmp()).status === "unknown");
});
await t("sandbox：report→get；坏 status 打回", async () => {
  const dir = tmp(); const tool = makeSandboxTool(ws(dir), "build");
  assert(isErr(await tool.execute("", { op: "report", status: "bad" })), "坏 status 应打回");
  assert(!isErr(await tool.execute("", { op: "report", status: "available", note: "ssh ok" })));
  assert(readSandboxState(dir).status === "available");
  assert(txt(await tool.execute("", { op: "get" })).includes("available"));
  assert(isErr(await tool.execute("", { op: "nope" })), "未知 op 应打回");
});

// ---------------------------------------------------------------- hyp
await t("hyp：create 需 binding.tag＋body；编号递增", async () => {
  const dir = tmp();
  assert(isErr(await makeHypTool(ws(dir), {}).execute("", { op: "create", body: "x" })), "无 tag 应打回");
  const tool = makeHypTool(ws(dir), { tag: "hunt1" });
  assert(isErr(await tool.execute("", { op: "create", body: "  " })), "空 body 应打回");
  assert(txt(await tool.execute("", { op: "create", body: "## 主张\n锚点 src/a.c:1" })).includes("HYP-hunt1-H1"));
  assert(txt(await tool.execute("", { op: "create", body: "## 主张2\n锚点 src/b.c:2" })).includes("HYP-hunt1-H2"));
  assert(readHyp(dir, "HYP-hunt1-H1")?.status === "pending");
});
await t("hyp：update 裁决——两项写齐转办结；单写不结；list 筛选", async () => {
  const dir = tmp(); const tool = makeHypTool(ws(dir), { tag: "hunt1" });
  await tool.execute("", { op: "create", body: "x" });
  await tool.execute("", { op: "create", body: "y" });
  assert(!isErr(await tool.execute("", { op: "update", id: "HYP-hunt1-H1", conclusion: "refuted" })));
  assert(readHyp(dir, "HYP-hunt1-H1").status === "pending", "未写齐不办结");
  assert(!isErr(await tool.execute("", { op: "update", id: "HYP-hunt1-H1", verdict: "不成立：校验在位" })));
  const rec = readHyp(dir, "HYP-hunt1-H1");
  assert(rec.status === "closed" && rec.conclusion === "refuted");
  assert(isErr(await tool.execute("", { op: "update", id: "HYP-hunt1-H1", conclusion: "maybe" })), "非法 conclusion 应打回");
  assert(isErr(await tool.execute("", { op: "update", id: "HYP-nope-H1", verdict: "x" })), "不存在应打回");
  const l1 = txt(await tool.execute("", { op: "list", tag: "hunt1" }));
  assert(l1.includes("HYP-hunt1-H1") && l1.includes("HYP-hunt1-H2"));
  const l2 = txt(await tool.execute("", { op: "list", status: "closed" }));
  assert(l2.includes("HYP-hunt1-H1") && !l2.includes("HYP-hunt1-H2"), "状态筛选应生效");
});

// ---------------------------------------------------------------- finding
const FULL = {
  title: "x 模块 CRLF 注入", vuln_type: "crlf-injection", finding_class: "vulnerability",
  cwe: ["CWE-93"], cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N", cvss_score: 6.5,
  ev_vector: "EV:…", ev_score: 7.0, ev_priority: "P1", ev_rationale: "……",
  affected_versions: "1.16", summary: "s", background: "b",
  dataflow: [{ step: 1, location: "a.c:1", snippet: "x", description: "d" }],
  references: ["https://example.com"],
};
await t("finding：create 继承编号；必填校验；重复打回", async () => {
  const dir = tmp();
  assert(isErr(await makeFindingTool(ws(dir), {}).execute("", { op: "create", ...FULL })), "无 hypId 应打回");
  const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt1-H1" });
  assert(isErr(await tool.execute("", { op: "create", title: "x" })), "缺必填应打回");
  assert(txt(await tool.execute("", { op: "create", ...FULL })).includes("BUG-hunt1-H1"));
  const rec = readFinding(dir, "BUG-hunt1-H1");
  assert(rec.poc_status === "pending" && rec.exp_status === "pending");
  assert(isErr(await tool.execute("", { op: "create", ...FULL })), "重复 create 应打回");
});
await t("finding：状态机（合法迁移通过；非法/终态打回）", async () => {
  const dir = tmp(); const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt1-H1" });
  await tool.execute("", { op: "create", ...FULL });
  assert(isErr(await tool.execute("", { op: "update", id: "BUG-hunt1-H1", poc_status: "pending" })), "同值迁移应打回");
  assert(!isErr(await tool.execute("", { op: "update", id: "BUG-hunt1-H1", poc_status: "reproduced", poc_evidence: "6 req 5 hit" })));
  assert(isErr(await tool.execute("", { op: "update", id: "BUG-hunt1-H1", poc_status: "pending" })), "终态应打回");
});
await t("finding：降级 vulnerability→risk 自动 not-needed；不回升级", async () => {
  const dir = tmp(); const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt3-H1" });
  await tool.execute("", { op: "create", ...FULL });
  assert(!isErr(await tool.execute("", { op: "update", id: "BUG-hunt3-H1", finding_class: "risk" })));
  const rec = readFinding(dir, "BUG-hunt3-H1");
  assert(rec.finding_class === "risk" && rec.poc_status === "not-needed" && rec.exp_status === "not-needed");
  assert(isErr(await tool.execute("", { op: "update", id: "BUG-hunt3-H1", finding_class: "vulnerability" })), "不允许回升级");
});
await t("finding：schema 外字段拒收", async () => {
  const dir = tmp(); const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt1-H1" });
  await tool.execute("", { op: "create", ...FULL });
  const r = await tool.execute("", { op: "update", id: "BUG-hunt1-H1", nonsense: 1 });
  assert(isErr(r) && txt(r).includes("nonsense"), "schema 外应拒收");
});
await t("finding：attachments add/update/delete 全链", async () => {
  const dir = tmp(); const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt4-H1" });
  await tool.execute("", { op: "create", ...FULL });
  const poc = join(dir, "poc.py"); writeFileSync(poc, "print(1)\n");
  assert(isErr(await tool.execute("", { op: "update", id: "BUG-hunt4-H1", attachments: [{ op: "add", file: join(dir, "nope.py"), kind: "poc" }] })), "文件不存在应打回");
  assert(!isErr(await tool.execute("", { op: "update", id: "BUG-hunt4-H1", attachments: [{ op: "add", file: poc, kind: "poc", note: "复现脚本" }] })));
  let rec = readFinding(dir, "BUG-hunt4-H1");
  assert(rec.attachments.length === 1 && rec.attachments[0].aid === "a1");
  const stored = join(dir, "findings", "BUG-hunt4-H1", "attachments", rec.attachments[0].file);
  assert(existsSync(stored), "附件文件应落盘");
  assert(!isErr(await tool.execute("", { op: "update", id: "BUG-hunt4-H1", attachments: [{ op: "update", aid: "a1", note: "改注" }] })));
  rec = readFinding(dir, "BUG-hunt4-H1");
  assert(rec.attachments[0].note === "改注");
  assert(!isErr(await tool.execute("", { op: "update", id: "BUG-hunt4-H1", attachments: [{ op: "delete", aid: "a1" }] })));
  rec = readFinding(dir, "BUG-hunt4-H1");
  assert(rec.attachments.length === 0 && !existsSync(stored), "删除应清文件");
  assert(isErr(await tool.execute("", { op: "update", id: "BUG-hunt4-H1", attachments: [{ op: "delete", aid: "a9" }] })), "不存在 aid 应打回");
});
await t("finding：list/get", async () => {
  const dir = tmp(); const tool = makeFindingTool(ws(dir), { hypId: "HYP-hunt1-H1" });
  await tool.execute("", { op: "create", ...FULL });
  const l = txt(await tool.execute("", { op: "list" }));
  assert(l.includes("BUG-hunt1-H1") && l.includes("cvss=6.5"));
  const g = txt(await tool.execute("", { op: "get", id: "BUG-hunt1-H1" }));
  assert(g.includes('"finding_class": "vulnerability"'));
});

// ---------------------------------------------------------------- profiler
await t("profiler：空 update 打回；分节深合并；get", async () => {
  const dir = tmp(); const tool = makeProfilerTool(ws(dir));
  assert(isErr(await tool.execute("", { op: "update" })), "空 update 应打回");
  await tool.execute("", { op: "update", language: ["C"], entrypoints: ["src/main.c"] });
  await tool.execute("", { op: "update", frameworks: ["libc"], build: { system: "make" } });
  const rec = readProfiler(dir);
  assert(rec.language[0] === "C" && rec.frameworks[0] === "libc" && rec.build.system === "make");
  assert(txt(await tool.execute("", { op: "get" })).includes("entrypoints"));
});

console.log(`\ntools.spec: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
