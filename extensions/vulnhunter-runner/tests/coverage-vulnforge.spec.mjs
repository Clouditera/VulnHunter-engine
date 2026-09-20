/**
 * .vulnforge 覆盖排除语义测试（fish 09-17；HALL-45 修复移植到新结构的验收）
 * 覆盖：记录侧拦截 / 聚合侧跳过（单文件 + 批量）/ 存量自愈
 * 运行：node tests/coverage-vulnforge.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordReadCoverageEvent,
  aggregateCoverageEvents,
  loadCoverageMap,
  getCoveragePaths,
} from "../.dist/node-ext/code-coverage/coverage-core.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cov-vf-"));
  const out = join(root, ".vulnforge");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(out, "todo"), { recursive: true });
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(join(root, "src", "a.c"), LINES);
  writeFileSync(join(out, "todo", "x.md"), LINES);
  const cov = getCoveragePaths(out);
  return { root, out, cov };
}

await t("记录侧：工作区文件拦截、目标文件放行", async () => {
  const { root, out, cov } = setup();
  recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: root, stage: "hunt", input: { path: join(out, "todo", "x.md") }, outputDir: out });
  const blockedLog = existsSync(cov.jsonlPath) ? readFileSync(cov.jsonlPath, "utf8") : "";
  assert(blockedLog === "", `workspace read must not be recorded, got: ${blockedLog}`);
  recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: root, stage: "hunt", input: { path: join(root, "src", "a.c") }, outputDir: out });
  const lines = readFileSync(cov.jsonlPath, "utf8").trim().split("\n");
  assert(lines.length === 1, `expect exactly 1 event, got ${lines.length}`);
  const evt = JSON.parse(lines[0]);
  assert(evt.file === "src/a.c" && evt.start === 1 && evt.end === 12, `unexpected event: ${lines[0]}`);
});

await t("记录侧：相对路径按项目根解析而非进程 cwd（09-20 实踩修复）", async () => {
  const { root, out, cov } = setup();
  recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: root, stage: "hunt", input: { path: "src/a.c" }, outputDir: out });
  const lines = readFileSync(cov.jsonlPath, "utf8").trim().split("\n");
  assert(lines.length === 1, `expect 1 event, got ${lines.length}`);
  const evt = JSON.parse(lines[0]);
  assert(evt.file === "src/a.c" && evt.end === 12, `unexpected event: ${lines[0]}`);
});

await t("聚合侧：旧噪声事件（单文件形态）被跳过、目录树不出现 .vulnforge", async () => {
  const { root, out, cov } = setup();
  writeFileSync(cov.jsonlPath,
    JSON.stringify({ file: ".vulnforge/todo/old.md", start: 1, end: 5, stage: "hunt", ts: "2026-09-16T00:00:00Z" }) + "\n" +
    JSON.stringify({ file: "src/a.c", start: 1, end: 12, stage: "hunt", ts: "2026-09-16T00:00:01Z" }) + "\n");
  const map = loadCoverageMap(cov.jsonPath, root, out);
  aggregateCoverageEvents(cov.jsonlPath, map);
  assert(!map.files[".vulnforge/todo/old.md"], "noise file must not be injected");
  assert(!map.directories[".vulnforge"], "workspace dir must not appear in tree");
  assert(map.files["src/a.c"]?.read_lines === 12, "normal file must be aggregated");
  assert(map.summary.files === 1, `summary.files expect 1, got ${map.summary.files}`);
});

await t("聚合侧：批量事件（files[]）里的工作区路径同样跳过", async () => {
  const { root, out, cov } = setup();
  writeFileSync(cov.jsonlPath,
    JSON.stringify({ files: [".vulnforge/todo/b.md", "src/a.c"], stage: "research", ts: "2026-09-16T00:00:00Z" }) + "\n");
  const map = loadCoverageMap(cov.jsonPath, root, out);
  aggregateCoverageEvents(cov.jsonlPath, map);
  assert(!map.files[".vulnforge/todo/b.md"], "batch noise must be skipped");
  assert(map.files["src/a.c"]?.read_count === 1, "batch normal file must be counted");
});

await t("存量自愈：旧 map 里的 .vulnforge 幽灵条目加载即被剔除", async () => {
  const { root, out, cov } = setup();
  const legacy = {
    version: 1, target_root: root, output_dir: out, updated_at: "2026-09-16T00:00:00Z",
    last_event_offset: 0,
    summary: { path: ".", files: 0, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 },
    files: {
      ".vulnforge/todo/x.md": { path: ".vulnforge/todo/x.md", total_lines: 0, read_lines: 0, coverage: 0, ranges: [], read_count: 2, stages: ["hunt"] },
      "src/a.c": { path: "src/a.c", total_lines: 12, read_lines: 0, coverage: 0, ranges: [], read_count: 0, stages: [] },
    },
    directories: {},
  };
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(cov.jsonPath, JSON.stringify(legacy));
  const map = loadCoverageMap(cov.jsonPath, root, out);
  assert(!map.files[".vulnforge/todo/x.md"], "legacy workspace entry must be healed away");
  assert(!!map.files["src/a.c"], "normal entry must survive");
  assert(map.summary.files === 1 && map.summary.total_lines === 12, `summary healed: files=${map.summary.files} lines=${map.summary.total_lines}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
