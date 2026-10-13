/**
 * 小模式 LOC 分流枚举测试（HALL-64 §1）：listCoverageTargetFiles 复用覆盖率统计口径
 * 覆盖：LOC 汇总 = 覆盖率分母行数、include/exclude 口径生效、点目录默认排除
 * 运行：node tests/small-audit-loc.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCoverageTargetFiles } from "../.dist/node-ext/code-coverage/coverage-core.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.error("FAIL", name, e); fail++; }
}

function mkProj() {
  const root = mkdtempSync(join(tmpdir(), "small-loc-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "src", "a.c"), "int a;\nint b;\nint c;\n");          // 3 行
  writeFileSync(join(root, "src", "b.h"), "// header\n");                        // 1 行
  writeFileSync(join(root, "README.md"), "doc\ndoc2\n");                         // 2 行（文本进分母）
  writeFileSync(join(root, ".git", "ignored"), "x\n");                           // 点目录默认排除
  return root;
}

await t("LOC 枚举：返回全部靶内文本文件与行数（口径=覆盖率分母）", () => {
  const root = mkProj();
  const files = listCoverageTargetFiles(root, join(root, ".vulnforge"));
  const loc = files.reduce((n, f) => n + f.lines, 0);
  assert(files.length === 3, `expect 3 files, got ${files.length}`);
  assert(loc === 6, `expect loc=6, got ${loc}`);
  assert(files.every((f) => !f.rel.startsWith(".git")), ".git must be excluded");
});

await t("LOC 枚举：include/exclude 口径与覆盖率配置一致", () => {
  const root = mkProj();
  const out = join(root, ".vulnforge");
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(join(out, "system", "coverage", "coverage.yaml"), "include:\n  - src\nexclude:\n  - '*.h'\n");
  const files = listCoverageTargetFiles(root, out);
  const loc = files.reduce((n, f) => n + f.lines, 0);
  assert(files.length === 1 && files[0].rel === "src/a.c", `expect only src/a.c, got ${JSON.stringify(files.map((f) => f.rel))}`);
  assert(loc === 3, `expect loc=3, got ${loc}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
