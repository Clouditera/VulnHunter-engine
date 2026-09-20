import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import path, { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ============================================================================
// Constants
// ============================================================================

// 内容探测（fish 09-17 定）：不再维护扩展名白名单，改按文件内容判文本/二进制——
// 二进制排出、文本收录（全部文本类进分母）；轻量版 file(1) 思路，见 looksLikeTextFile。
const PROBE_BYTES = 8192;

// ============================================================================
// 覆盖统计目标配置（09-11 fish 定；09-20 迁 system/）：.vulnforge/system/coverage/coverage.yaml
// runner 启动参数 coverage_include / coverage_exclude 落盘而来；
// 枚举（walkFiles）、记录（resolveToRel）、查询（coverage 工具）三层共读。
// 默认仅排点目录（.vulnforge/.git 天然在内），不再内置 vendor 等黑名单。
// ============================================================================

export interface CoverageConfig { include: string[]; exclude: string[] }
export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = { include: ["."], exclude: [] };

export function loadCoverageConfig(outputDir: string): CoverageConfig {
  try {
    const p = path.join(outputDir, "system", "coverage", "coverage.yaml");
    if (!existsSync(p)) return DEFAULT_COVERAGE_CONFIG;
    const doc: any = parseYaml(readFileSync(p, "utf8"));
    const norm = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((s) => s.trim().replace(/^\.\/+|\/+$/g, "") || ".")
        : [];
    const include = norm(doc?.include), exclude = norm(doc?.exclude);
    return { include: include.length ? include : ["."], exclude };
  } catch { return DEFAULT_COVERAGE_CONFIG; }
}

/** 统计目标自检：返回靶内文件数（run 启动护栏用——0 = include 被 exclude 吞掉，coverage 将静默全程为零） */
export function countCoverageTargetFiles(targetRoot: string, outputDir: string): number {
  return walkFiles(targetRoot, loadCoverageConfig(outputDir)).length;
}

/** 单条目匹配：无 "*"=路径前缀（"."=全项目）；含 "*"=文件级通配（`*.json`、`src/*.c`；* 可跨 /） */
function entryMatches(rel: string, entry: string): boolean {
  if (entry === ".") return true;
  if (!entry.includes("*")) return rel === entry || rel.startsWith(entry + "/");
  const re = new RegExp("^" + entry.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(rel);
}

/** rel（相对项目根）是否命中路径清单（含通配条目）；"." 代表全项目 */
function underAny(rel: string, roots: string[]): boolean {
  return roots.some((r) => entryMatches(rel, r));
}

/** 文件级判定：在 include 内且不在 exclude 内（含通配条目） */
export function inCoverageTarget(cfg: CoverageConfig, rel: string): boolean {
  return underAny(rel, cfg.include) && !underAny(rel, cfg.exclude);
}

/** 目录级判定：允许下潜——命中 include，或 include 根在它更深处（如 include=vendor/mcmc 时要能潜进 vendor）；
 *  含 "*" 的条目按文件级处理：include 中一律允许下潜、exclude 中不剪枝 */
function dirMayContainTarget(cfg: CoverageConfig, rel: string): boolean {
  const inc = cfg.include.some((r) => r === "." || r.includes("*") || rel === r || rel.startsWith(r + "/") || rel.startsWith(rel + "/"));
  const exc = cfg.exclude.some((r) => !r.includes("*") && (rel === r || rel.startsWith(r + "/")));
  return inc && !exc;
}

/** 工作区目录（如 .vulnforge）相对 targetRoot 的前缀——按实际 outputDir 计算，不硬编码名字；不在 targetRoot 内或即根时返回 null */
function outputDirRelPrefix(targetRoot: string, outputDir: string): string | null {
  const rel = path.relative(path.resolve(targetRoot), path.resolve(outputDir)).replaceAll(path.sep, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/** rel 是否等于前缀或落在其子树内 */
function isUnderPrefix(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix + "/");
}

// ============================================================================
// Types
// ============================================================================

interface FileCoverage {
  path: string;
  total_lines: number;
  read_lines: number;
  coverage: number;
  ranges: Array<[number, number]>;
  read_count: number;
  first_read_at?: string;
  last_read_at?: string;
  stages: string[];
}

interface DirCoverage {
  path: string;
  files: number;
  covered_files: number;
  total_lines: number;
  read_lines: number;
  coverage: number;
}

interface CoverageMap {
  version: 1;
  target_root: string;
  output_dir: string;
  updated_at: string;
  last_event_offset: number;
  summary: DirCoverage;
  files: Record<string, FileCoverage>;
  directories: Record<string, DirCoverage>;
}

interface CoverageEvent {
  file: string;
  start: number;
  end: number;
  stage: string;
  ts: string;
}

// ============================================================================
// File system helpers
// ============================================================================

/** 读文件头 ~8KB 判文本/二进制：NUL→二进制；控制符占比>5%→二进制；UTF-16/32 BOM 放行；空文件按文本 */
export function looksLikeTextFile(full: string): boolean {
  let fd: number;
  try { fd = openSync(full, "r"); } catch { return false; }
  try {
    const buf = Buffer.alloc(PROBE_BYTES);
    const n = readSync(fd, buf, 0, PROBE_BYTES, 0);
    if (n <= 0) return true; // 空文件按文本（0 行，无害）
    // BOM：UTF-16/UTF-32 天然含 NUL，先识别放行
    if (n >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
    let i = 0;
    if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; // UTF-8 BOM 跳过
    let ctrl = 0, total = 0;
    for (; i < n; i++) {
      const b = buf[i];
      total++;
      if (b === 0) return false; // NUL → 二进制
      const isWs = b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x08 || b === 0x1b;
      if (!isWs && (b < 0x20 || b === 0x7f)) ctrl++;
    }
    return total > 0 && ctrl / total <= 0.05;
  } finally { closeSync(fd); }
}

function countLines(file: string): number {
  try {
    const text = readFileSync(file, "utf8");
    if (text.length === 0) return 0;
    const n = text.split(/\r\n|\r|\n/).length;
    // split() produces a trailing empty string when the file ends with a
    // newline, making the count 1 higher than `wc -l`. Subtract it out.
    return /\r\n|\r|\n$/.test(text.slice(-2)) ? n - 1 : n;
  } catch {
    return 0;
  }
}

function walkFiles(root: string, cfg: CoverageConfig): string[] {
  const out: string[] = [];
  function walk(dir: string, rel: string) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      // 点目录/点文件默认排除（.vulnforge/.git/.pi-subagents 天然在此列）；
      // 仅当 include 显式点名该点路径（不含 "." 通配）时放行
      if (name.startsWith(".") && !cfg.include.some((r) => r !== "." && (r === childRel || r.startsWith(childRel + "/")))) continue;
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (dirMayContainTarget(cfg, childRel)) walk(full, childRel);
      } else if (st.isFile() && st.size <= 2_000_000 && inCoverageTarget(cfg, childRel) && looksLikeTextFile(full)) out.push(full);
    }
  }
  walk(root, "");
  return out;
}

// ============================================================================
// Coverage map management
// ============================================================================

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function rangeLineCount(ranges: Array<[number, number]>): number {
  return ranges.reduce((sum, [a, b]) => sum + Math.max(0, b - a + 1), 0);
}

function dirPrefixes(fileRel: string): string[] {
  const parts = fileRel.split("/");
  const dirs = ["."];
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    dirs.push(cur);
  }
  return dirs;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function recompute(map: CoverageMap) {
  const dirs: Record<string, DirCoverage> = {};
  function getDir(p: string): DirCoverage {
    return dirs[p] ??= { path: p, files: 0, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 };
  }
  for (const f of Object.values(map.files)) {
    f.ranges = mergeRanges(f.ranges);
    f.read_lines = Math.min(f.total_lines, rangeLineCount(f.ranges));
    f.coverage = f.total_lines > 0 ? round(f.read_lines / f.total_lines) : 0;
    for (const d of dirPrefixes(f.path)) {
      const dc = getDir(d);
      dc.files += 1;
      if (f.read_lines > 0) dc.covered_files += 1;
      dc.total_lines += f.total_lines;
      dc.read_lines += f.read_lines;
    }
  }
  for (const d of Object.values(dirs)) d.coverage = d.total_lines > 0 ? round(d.read_lines / d.total_lines) : 0;
  map.directories = dirs;
  map.summary = dirs["."] ?? { path: ".", files: 0, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 };
  map.updated_at = new Date().toISOString();
}

function ensureInitialMap(targetRoot: string, outputDir: string, existing?: CoverageMap): CoverageMap {
  const cfg = loadCoverageConfig(outputDir);
  const outPrefix = outputDirRelPrefix(targetRoot, outputDir);
  const files: Record<string, FileCoverage> = existing?.files ?? {};
  // 按当前统计目标裁剪：配置变了（如 vendor 纳进/排出）分母立即对齐，不残留历史条目
  // 自愈：工作区目录（如 .vulnforge）的存量条目一并剔除——旧事件曾以 total_lines=0 形态注入过
  for (const rel of Object.keys(files))
    if (!inCoverageTarget(cfg, rel) || (outPrefix && isUnderPrefix(rel, outPrefix))) delete files[rel];
  for (const full of walkFiles(targetRoot, cfg)) {
    const rel = path.relative(targetRoot, full).replaceAll(path.sep, "/");
    if (!files[rel]) {
      files[rel] = {
        path: rel, total_lines: countLines(full), read_lines: 0,
        coverage: 0, ranges: [], read_count: 0, stages: [],
      };
    } else if (!files[rel].total_lines) {
      files[rel].total_lines = countLines(full);
    }
  }
  const map: CoverageMap = {
    version: 1, target_root: targetRoot, output_dir: outputDir,
    updated_at: new Date().toISOString(),
    last_event_offset: existing?.last_event_offset ?? 0,
    summary: { path: ".", files: 0, covered_files: 0, total_lines: 0, read_lines: 0, coverage: 0 },
    files, directories: {},
  };
  recompute(map);
  return map;
}

function loadSummaryJson(jsonPath: string, targetRoot: string, outputDir: string): CoverageMap {
  if (existsSync(jsonPath)) {
    try { return ensureInitialMap(targetRoot, outputDir, JSON.parse(readFileSync(jsonPath, "utf8"))); }
    catch { return ensureInitialMap(targetRoot, outputDir); }
  }
  return ensureInitialMap(targetRoot, outputDir);
}

// ============================================================================
// JSONL event log — append-only, multi-process safe
// ============================================================================

/**
 * Append a coverage event to the JSONL log.
 * Uses appendFileSync which opens with O_APPEND — atomic for writes < PIPE_BUF (4096 on Linux).
 * Each event line is ~150 bytes, well within the limit.
 */
function appendEvent(jsonlPath: string, event: CoverageEvent) {
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  const line = JSON.stringify(event) + "\n";
  appendFileSync(jsonlPath, line, "utf8");
}

/**
 * Incrementally aggregate events from the JSONL log into the coverage map.
 * Only reads bytes after `map.last_event_offset`.
 * Returns true if new events were processed.
 */
function aggregateEvents(jsonlPath: string, map: CoverageMap): boolean {
  if (!existsSync(jsonlPath)) return false;
  const outPrefix = outputDirRelPrefix(map.target_root, map.output_dir);

  let fd: number;
  try { fd = openSync(jsonlPath, "r"); } catch { return false; }

  try {
    const stats = fstatSync(fd);
    const currentSize = stats.size;
    const offset = map.last_event_offset ?? 0;

    if (currentSize <= offset) return false; // no new events

    const bytesToRead = currentSize - offset;
    const buf = Buffer.alloc(bytesToRead);
    readSync(fd, buf, 0, bytesToRead, offset);

    const newContent = buf.toString("utf8");
    let processed = 0;

    for (const line of newContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: CoverageEvent & { files?: unknown };
      try { evt = JSON.parse(trimmed); } catch { continue; } // skip corrupt/incomplete lines

      // 两种事件形态：单文件 {file,start,end}（hunt 精读）与
      // 批量清单 {files:[...]}（cognize 等，无行区间）。缺少有效文件字段则跳过，
      // 否则会把 undefined 写进 map.files 的 path，后续 split/startsWith 全线崩。
      const fileList: string[] =
        typeof evt.file === "string" && evt.file.length > 0
          ? [evt.file]
          : Array.isArray(evt.files)
            ? evt.files.filter((f): f is string => typeof f === "string" && f.length > 0)
            : [];
      if (fileList.length === 0) continue;

      for (const file of fileList) {
        // 工作区目录（如 .vulnforge）的事件一律不回注——防旧噪声与旁路写入
        if (outPrefix && isUnderPrefix(file, outPrefix)) continue;
        const rec: FileCoverage = map.files[file] ?? {
          path: file, total_lines: 0, read_lines: 0, coverage: 0,
          ranges: [], read_count: 0, stages: [],
        };

        if (typeof evt.start === "number" && typeof evt.end === "number" && evt.end >= evt.start)
          rec.ranges.push([evt.start, evt.end]);
        rec.read_count += 1;
        rec.first_read_at ??= evt.ts;
        rec.last_read_at = evt.ts;
        if (evt.stage && !rec.stages.includes(evt.stage)) rec.stages.push(evt.stage);
        map.files[file] = rec;
        processed++;
      }
    }

    map.last_event_offset = currentSize;

    if (processed > 0) {
      recompute(map);
      return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

function persistJson(map: CoverageMap, jsonPath: string) {
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(map, null, 2), "utf8");
}

/**
 * Resolve an absolute file path to a relative path under targetRoot.
 * Returns null if the path is outside targetRoot, inside the workspace outputDir,
 * or not a trackable code file.
 */
function resolveToRel(absPath: string, targetRoot: string, cfg: CoverageConfig = DEFAULT_COVERAGE_CONFIG, outputDir?: string): string | null {
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(targetRoot + path.sep) && resolved !== targetRoot) return null;
  // 工作区目录（如 .vulnforge）不计入覆盖：模型读自己的笔记/台账不算阅读目标代码
  if (outputDir) {
    const out = path.resolve(outputDir);
    if (resolved === out || resolved.startsWith(out + path.sep)) return null;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
  if (!looksLikeTextFile(resolved)) return null;
  const rel = path.relative(targetRoot, resolved).replaceAll(path.sep, "/");
  if (!inCoverageTarget(cfg, rel)) return null;
  return rel;
}

// ============================================================================
// Coverage tool rendering
// ============================================================================

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Get direct children of a directory in the coverage map */
function getChildren(map: CoverageMap, dir: string): Array<{
  name: string; relPath: string; type: "dir" | "file";
  files?: number; coveredFiles?: number;
  totalLines: number; readLines: number; coverage: number;
  readCount?: number;
}> {
  const prefix = dir === "." ? "" : dir + "/";
  const result = new Map<string, any>();

  // Collect child directories
  for (const d of Object.values(map.directories)) {
    if (d.path === dir || d.path === ".") continue;
    if (!d.path.startsWith(prefix)) continue;
    const rest = d.path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    result.set(rest, {
      name: rest, relPath: d.path, type: "dir",
      files: d.files, coveredFiles: d.covered_files,
      totalLines: d.total_lines, readLines: d.read_lines, coverage: d.coverage,
    });
  }

  // Collect child files
  for (const f of Object.values(map.files)) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    const name = rest;
    result.set(name, {
      name, relPath: f.path, type: "file",
      totalLines: f.total_lines, readLines: f.read_lines, coverage: f.coverage,
      readCount: f.read_count,
    });
  }

  // Sort: directories first, then files; alphabetical within each group
  return [...result.values()].sort((a: any, b: any) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)
  );
}

/** Render tree output for a directory with depth control */
function renderTree(map: CoverageMap, dir: string, depth: number, currentDepth: number = 0, prefix: string = ""): string[] {
  const children = getChildren(map, dir);
  if (children.length === 0) return ["(empty)"];

  const lines: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (child.type === "dir") {
      const covInfo = `${child.coveredFiles}/${child.files} files read`;
      lines.push(`${prefix}${connector}${child.name}/  ${pct(child.coverage)}  (${covInfo})`);
      if (currentDepth + 1 < depth) {
        const subLines = renderTree(map, child.relPath, depth, currentDepth + 1, prefix + childPrefix);
        lines.push(...subLines);
      }
    } else {
      const readInfo = child.readCount! > 0
        ? `${child.readLines}/${child.totalLines} lines read`
        : `${child.totalLines} lines`;
      lines.push(`${prefix}${connector}${child.name}  ${pct(child.coverage)}  (${readInfo})`);
    }
  }
  return lines;
}

/** Render the global summary header */
function renderSummary(map: CoverageMap): string {
  const s = map.summary;
  return [
    `Code Reading Coverage`,
    `Files: ${s.covered_files}/${s.files} (${pct(s.coverage)}) | Lines: ${s.read_lines}/${s.total_lines}`,
    `Updated: ${map.updated_at}`,
    ``,
  ].join("\n");
}

/** Render directory view */
function renderDirView(map: CoverageMap, dir: string, depth: number): string {
  const dc = map.directories[dir];
  if (!dc) return `Directory not found in coverage: ${dir}`;

  const header = dir === "."
    ? renderSummary(map)
    : [
        `${dir}/`,
        `Files: ${dc.covered_files}/${dc.files} (${pct(dc.coverage)}) | Lines: ${dc.read_lines}/${dc.total_lines}`,
        ``,
      ].join("\n");

  const tree = renderTree(map, dir, depth);
  return header + tree.join("\n");
}

/** Render file view with line-level coverage detail */
function renderFileView(map: CoverageMap, filePath: string): string {
  const f = map.files[filePath];
  if (!f) return `File not found in coverage: ${filePath}`;

  const lines: string[] = [
    `${f.path}`,
    `Lines: ${f.read_lines}/${f.total_lines} (${pct(f.coverage)}) | Read count: ${f.read_count}`,
  ];

  if (f.first_read_at) {
    lines.push(`First read: ${f.first_read_at} | Last read: ${f.last_read_at}`);
  }
  if (f.stages.length > 0) {
    lines.push(`Stages: ${f.stages.join(", ")}`);
  }

  lines.push("");

  if (f.ranges.length === 0) {
    lines.push("No lines read.");
  } else {
    lines.push(`Read ranges: ${f.ranges.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(", ")}`);

    // Compute unread ranges
    const unread: Array<[number, number]> = [];
    let cursor = 1;
    for (const [start, end] of f.ranges) {
      if (cursor < start) unread.push([cursor, start - 1]);
      cursor = end + 1;
    }
    if (cursor <= f.total_lines) unread.push([cursor, f.total_lines]);

    if (unread.length > 0) {
      lines.push(`Unread ranges: ${unread.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(", ")}`);
    }
  }

  return lines.join("\n");
}


// ============================================================================
// Shared API for split coverage extensions
// ============================================================================

export function getCoveragePaths(outputDir: string) {
  const coverageDir = path.join(outputDir, "system", "coverage");
  return {
    coverageDir,
    jsonPath: path.join(coverageDir, "code-reading-coverage.json"),
    jsonlPath: path.join(coverageDir, "coverage-events.jsonl"),
  };
}

export function loadCoverageMap(jsonPath: string, targetRoot: string, outputDir: string): CoverageMap {
  return loadSummaryJson(jsonPath, targetRoot, outputDir);
}

export function aggregateCoverageEvents(jsonlPath: string, map: CoverageMap): boolean {
  return aggregateEvents(jsonlPath, map);
}

export function persistCoverageMap(map: CoverageMap, jsonPath: string) {
  persistJson(map, jsonPath);
}

export function renderCoverage(map: CoverageMap, params: { path?: string; depth?: number }): string {
  const requestedPath = params.path?.replace(/^\/+|\/+$/g, "") || ".";
  const depth = Math.max(1, Math.min(params.depth ?? 1, 10));

  const isFile = !!map.files[requestedPath];
  const isDir = !!map.directories[requestedPath];

  if (isFile) return renderFileView(map, requestedPath);
  if (isDir) return renderDirView(map, requestedPath, depth);

  const matchingDirs = Object.keys(map.directories).filter(d => d.startsWith(requestedPath));
  const matchingFiles = Object.keys(map.files).filter(f => f.startsWith(requestedPath));
  if (matchingDirs.length > 0 || matchingFiles.length > 0) {
    let output = `Path "${requestedPath}" not found as exact match.\n\nSimilar paths:\n`;
    for (const d of matchingDirs.slice(0, 10)) output += `  ${d}/\n`;
    for (const f of matchingFiles.slice(0, 10)) output += `  ${f}\n`;
    if (matchingDirs.length + matchingFiles.length > 20) output += `  ... and ${matchingDirs.length + matchingFiles.length - 20} more\n`;
    return output;
  }
  return `Path not found in coverage: ${requestedPath}`;
}

export function recordReadCoverageEvent(args: {
  jsonlPath: string;
  targetRoot: string;
  stage: string;
  input?: { path?: string; offset?: number; limit?: number };
  cfg?: CoverageConfig;
  outputDir?: string;
}) {
  const input = args.input;
  if (!input?.path) return;

  const rel = resolveToRel(input.path, args.targetRoot, args.cfg, args.outputDir);
  if (!rel) return;

  const total = countLines(path.resolve(input.path));
  if (total === 0) return;

  const start = Math.max(1, Number(input.offset ?? 1));
  const effectiveLimit = Math.max(1, Number(input.limit ?? 2000));
  const end = Math.min(total, start + effectiveLimit - 1);
  if (end < start) return;

  appendEvent(args.jsonlPath, { file: rel, start, end, stage: args.stage, ts: new Date().toISOString() });
}

// ===========================================================================
// Scope（mark_scope 标记范围）：.vulnforge/scope.yaml
// ===========================================================================

export interface ScopeEntry { path: string; threshold: number }
export interface ScopeDef { entries: ScopeEntry[]; excludes: string[] }

/** 极简解析：仅支持本工具写出的固定形状（entries: - path/threshold；excludes: - x）。 */
export function parseScopeYaml(text: string): ScopeDef {
  const entries: ScopeEntry[] = [];
  const excludes: string[] = [];
  let section: "entries" | "excludes" | null = null;
  let cur: Partial<ScopeEntry> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t === "entries:") { section = "entries"; continue; }
    if (t === "excludes:") { section = "excludes"; if (cur?.path) { entries.push({path: cur.path, threshold: cur.threshold ?? 90}); cur=null; } continue; }
    if (section === "entries") {
      const m = t.match(/^-\s*path:\s*(.+)$/);
      if (m) { if (cur?.path) entries.push({path: cur.path, threshold: cur.threshold ?? 90}); cur = { path: m[1].trim().replace(/^["']|["']$/g, "") }; continue; }
      const th = t.match(/^threshold:\s*(\d+)/);
      if (th && cur) { cur.threshold = parseInt(th[1], 10); continue; }
    } else if (section === "excludes") {
      const m = t.match(/^-\s*(.+)$/);
      if (m) excludes.push(m[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  if (cur?.path) entries.push({ path: cur.path, threshold: cur.threshold ?? 90 });
  return { entries, excludes };
}

export function loadScope(outputDir: string): ScopeDef | null {
  const p = join(outputDir, "scope.yaml");
  if (!existsSync(p)) return null;
  try { const s = parseScopeYaml(readFileSync(p, "utf-8")); return s.entries.length ? s : null; } catch { return null; }
}

/** 路径是否落在某个 scope 条目中（目录前缀/文件精确/简单 glob * 后缀）。 */
export function scopeEntryMatches(entryPath: string, rel: string): boolean {
  const e = entryPath.replace(/\/+$/g, "");
  if (e.endsWith("*")) { const pre = e.slice(0, -1); return rel.startsWith(pre); }
  return rel === e || rel.startsWith(e + "/");
}

export function inScope(scope: ScopeDef, rel: string): boolean {
  if (scope.excludes.some((x) => scopeEntryMatches(x, rel))) return false;
  return scope.entries.some((en) => scopeEntryMatches(en.path, rel));
}

export interface ScopeStat { path: string; threshold: number; total: number; read: number; pct: number; pass: boolean }

/** 逐 scope 条目的覆盖统计（分母=标记文件总行数）。 */
export function perScopeStats(map: CoverageMap, scope: ScopeDef): ScopeStat[] {
  return scope.entries.map((en) => {
    let total = 0, read = 0;
    for (const f of Object.values(map.files)) {
      if (!f || typeof f.path !== "string") continue;
      if (scope.excludes.some((x) => scopeEntryMatches(x, f.path))) continue;
      if (!scopeEntryMatches(en.path, f.path)) continue;
      total += f.total_lines || 0;
      read += Math.min(f.total_lines || 0, f.read_lines || 0);
    }
    const pct = total > 0 ? Math.round((read / total) * 1000) / 10 : 100;
    return { path: en.path, threshold: en.threshold, total, read, pct, pass: pct >= en.threshold };
  });
}
