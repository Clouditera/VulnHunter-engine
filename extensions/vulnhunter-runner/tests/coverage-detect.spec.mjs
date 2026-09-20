/**
 * 内容探测 + 通配匹配 语义测试（fish 09-17：全部文本进分母；include/exclude 支持后缀通配）
 * 覆盖：嗅探（无后缀文本/二进制/BOM）、include 通配、exclude 通配、记录侧通配
 * 运行：node tests/coverage-detect.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCoverageMap,
  loadCoverageConfig,
  recordReadCoverageEvent,
  looksLikeTextFile,
  getCoveragePaths,
} from "../.dist/node-ext/code-coverage/coverage-core.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), "cov-detect-"));
  const out = join(root, ".vulnforge");
  mkdirSync(out, { recursive: true });
  return { root, out };
};
const covPath = (out) => getCoveragePaths(out).jsonPath;
const loadMap = (root, out) => loadCoverageMap(covPath(out), root, out);

await t("内容探测：无后缀文本进目标；二进制（即使像代码）排出", async () => {
  const { root, out } = mk();
  writeFileSync(join(root, "Makefile"), "all:\n\tcc -o x x.c\n");
  writeFileSync(join(root, "LICENSE"), "MIT License\n");
  writeFileSync(join(root, "blob.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]));
  writeFileSync(join(root, "fake.c"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10, 0x20, 0x30]));
  writeFileSync(join(root, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello utf16\n", "utf16le")]));
  const names = Object.keys(loadMap(root, out).files).sort();
  assert(names.includes("Makefile"), `Makefile missing: [${names}]`);
  assert(names.includes("LICENSE"), "LICENSE missing");
  assert(names.includes("u16.txt"), "UTF-16 BOM text missing");
  assert(!names.includes("blob.elf"), "binary blob must be excluded");
  assert(!names.includes("fake.c"), "binary with code ext must be excluded");
});

await t("嗅探器边界：空文件=文本；控制符高占比=二进制", async () => {
  const root = mkdtempSync(join(tmpdir(), "cov-sniff-"));
  writeFileSync(join(root, "empty"), "");
  writeFileSync(join(root, "ctrl"), Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 7) + 1)));
  writeFileSync(join(root, "text.txt"), "normal text\n");
  assert(looksLikeTextFile(join(root, "empty")) === true, "empty should be text");
  assert(looksLikeTextFile(join(root, "ctrl")) === false, "ctrl-heavy should be binary");
  assert(looksLikeTextFile(join(root, "text.txt")) === true, "plain text should be text");
});

await t("include 通配：*.c 只收 C 文件（任意目录深度）", async () => {
  const { root, out } = mk();
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.c"), "int main(){return 0;}\n");
  writeFileSync(join(root, "b.md"), "# doc\n");
  writeFileSync(join(root, "sub", "c2.c"), "void f(){}\n");
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(join(out, "system", "coverage", "coverage.yaml"), 'include:\n  - "*.c"\nexclude: []\n');
  const names = Object.keys(loadMap(root, out).files).sort();
  assert(names.join(",") === "a.c,sub/c2.c", `expect [a.c,sub/c2.c] got [${names}]`);
});

await t("exclude 通配：*.json 全排、目录不被误剪、其余照收", async () => {
  const { root, out } = mk();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"a":1}\n');
  writeFileSync(join(root, "data", "x.json"), '{"b":2}\n');
  writeFileSync(join(root, "data", "y.c"), "int y;\n");
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(join(out, "system", "coverage", "coverage.yaml"), 'include:\n  - "."\nexclude:\n  - "*.json"\n');
  const names = Object.keys(loadMap(root, out).files).sort();
  assert(names.join(",") === "data/y.c", `expect [data/y.c] got [${names}]`);
});

await t("记录侧：exclude 通配命中的文件不记录，未命中的照记", async () => {
  const { root, out } = mk();
  mkdirSync(join(out, "system", "coverage"), { recursive: true });
  writeFileSync(join(root, "data.json"), "{}");
  writeFileSync(join(root, "y.c"), "int y;\n");
  writeFileSync(join(out, "system", "coverage", "coverage.yaml"), 'include:\n  - "."\nexclude:\n  - "*.json"\n');
  const cfg = loadCoverageConfig(out);
  const cov = getCoveragePaths(out);
  recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: root, stage: "hunt", input: { path: join(root, "data.json") }, cfg, outputDir: out });
  assert(!existsSync(cov.jsonlPath), "excluded file must not be recorded (no jsonl yet)");
  recordReadCoverageEvent({ jsonlPath: cov.jsonlPath, targetRoot: root, stage: "hunt", input: { path: join(root, "y.c") }, cfg, outputDir: out });
  const lines = readFileSync(cov.jsonlPath, "utf8").trim().split("\n");
  assert(lines.length === 1 && JSON.parse(lines[0]).file === "y.c", `expect [y.c] got ${lines}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
