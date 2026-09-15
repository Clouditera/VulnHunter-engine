/**
 * coverage-core 单测：outputDir（工作区根）子树排除行为。
 *
 * 运行：node --test extensions/code-coverage/coverage-core.test.ts
 * （仓库无测试框架，依赖 Node 22 原生 type stripping。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateCoverageEvents,
  getCoveragePaths,
  loadCoverageMap,
  recordReadCoverageEvent,
  resolveToRel,
} from "./coverage-core.ts";

/** 构造最小目标项目 + 工作区（.vulnforge）夹具，返回三个根路径。 */
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cov-test-"));
  const targetRoot = path.join(root, "proj");
  const outputDir = path.join(targetRoot, ".vulnforge");
  mkdirSync(path.join(targetRoot, "src"), { recursive: true });
  mkdirSync(path.join(outputDir, "todo"), { recursive: true });
  mkdirSync(path.join(outputDir, "knowledge", "coverage"), { recursive: true });
  mkdirSync(path.join(root, "outside"), { recursive: true });
  writeFileSync(path.join(targetRoot, "src", "main.py"), "a = 1\nb = 2\n");
  writeFileSync(path.join(targetRoot, "README.md"), "# proj\nhello\n");
  writeFileSync(path.join(outputDir, "todo", "ADV-1.md"), "# task\ncontent\n");
  writeFileSync(path.join(outputDir, "scope.yaml"), "entries:\n  - path: src\n    threshold: 90\n");
  writeFileSync(path.join(root, "outside", "other.md"), "# outside\n");
  return { root, targetRoot, outputDir };
}

test("resolveToRel：outputDir 内外路径的放行/拦截", () => {
  const { root, targetRoot, outputDir } = makeFixture();
  try {
    // 拦截：工作区（outputDir）子树内的代码扩展名文件（HALL-45 噪声来源）
    assert.equal(resolveToRel(path.join(outputDir, "todo", "ADV-1.md"), targetRoot, outputDir), null);
    assert.equal(resolveToRel(path.join(outputDir, "knowledge", "coverage", "coverage-events.jsonl"), targetRoot, outputDir), null);
    // 拦截边界：outputDir 自身
    assert.equal(resolveToRel(outputDir, targetRoot, outputDir), null);
    // 拦截：targetRoot 之外的文件
    assert.equal(resolveToRel(path.join(root, "outside", "other.md"), targetRoot, outputDir), null);
    // 放行：targetRoot 内、outputDir 外的项目代码/文档
    assert.equal(resolveToRel(path.join(targetRoot, "src", "main.py"), targetRoot, outputDir), "src/main.py");
    assert.equal(resolveToRel(path.join(targetRoot, "README.md"), targetRoot, outputDir), "README.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("记录侧：read 工作区文件不产生 coverage 事件", () => {
  const { root, targetRoot, outputDir } = makeFixture();
  try {
    const { jsonlPath } = getCoveragePaths(outputDir);
    const input = (p: string) => ({ path: p, offset: 1, limit: 10 });
    recordReadCoverageEvent({ jsonlPath, targetRoot, outputDir, stage: "hunt", input: input(path.join(outputDir, "todo", "ADV-1.md")) });
    recordReadCoverageEvent({ jsonlPath, targetRoot, outputDir, stage: "hunt", input: input(path.join(targetRoot, "src", "main.py")) });
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    assert.equal(events[0].file, "src/main.py");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("聚合侧：存量 jsonl 中的 .vulnforge 噪声事件被跳过", () => {
  const { root, targetRoot, outputDir } = makeFixture();
  try {
    const { jsonlPath, jsonPath } = getCoveragePaths(outputDir);
    const ts = new Date().toISOString();
    writeFileSync(jsonlPath, [
      JSON.stringify({ file: ".vulnforge/todo/ADV-1.md", start: 1, end: 2, stage: "hunt", ts }),
      JSON.stringify({ file: "src/main.py", start: 1, end: 2, stage: "hunt", ts }),
      JSON.stringify({ files: [".vulnforge/todo/ADV-2.md", "README.md"], stage: "cognize", ts }),
      "",
    ].join("\n"));
    const map = loadCoverageMap(jsonPath, targetRoot, outputDir);
    assert.ok(aggregateCoverageEvents(jsonlPath, map));
    assert.deepEqual(Object.keys(map.files).sort(), ["README.md", "src/main.py"]);
    assert.ok(!map.directories[".vulnforge"]);
    assert.equal(map.files["README.md"].read_count, 1);
    assert.equal(map.files["src/main.py"].read_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("存量自愈：已有 coverage JSON 中的 .vulnforge 条目加载时被剔除", () => {
  const { root, targetRoot, outputDir } = makeFixture();
  try {
    const { jsonPath } = getCoveragePaths(outputDir);
    // 模拟旧版本写出的含噪声 coverage JSON
    writeFileSync(jsonPath, JSON.stringify({
      version: 1,
      target_root: targetRoot,
      output_dir: outputDir,
      updated_at: new Date().toISOString(),
      last_event_offset: 0,
      summary: { path: ".", files: 0, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 },
      files: {
        ".vulnforge/todo/ADV-1.md": { path: ".vulnforge/todo/ADV-1.md", total_lines: 0, read_lines: 0, coverage: 0, ranges: [], read_count: 3, stages: ["hunt"] },
        "src/main.py": { path: "src/main.py", total_lines: 2, read_lines: 2, coverage: 1, ranges: [[1, 2]], read_count: 1, stages: ["hunt"] },
      },
      directories: {
        ".": { path: ".", files: 2, covered_files: 1, total_lines: 2, read_lines: 2, coverage: 1 },
        ".vulnforge": { path: ".vulnforge", files: 1, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 },
      },
    }));
    const map = loadCoverageMap(jsonPath, targetRoot, outputDir);
    assert.ok(!map.files[".vulnforge/todo/ADV-1.md"]);
    assert.ok(!map.directories[".vulnforge"]);
    assert.deepEqual(Object.keys(map.files).sort(), ["README.md", "src/main.py"]);
    // 项目代码统计不受影响
    assert.equal(map.files["src/main.py"].read_count, 1);
    assert.equal(map.summary.total_lines, 4); // main.py(2) + README.md(2)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
