#!/usr/bin/env node
/**
 * export-run.mjs — 独立批量导出脚本（session-archive 扩展的核心逻辑）
 *
 * 用法: node export-run.mjs <cwd> [--delay <秒>]
 * 把 <cwd> 对应最新 run 的会话树（主会话 + 全部 subagent）用 `pi --export`
 * 批量导出为 HTML，输出 <cwd>/.vulnforge/report/sessions/<ts>_<uuid>/index.html（默认工作区根）。
 * 也可直接命令行使用，不依赖扩展。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? dirname(dirname(EXT_DIR));

const cwd = process.argv[2];
const delayIdx = process.argv.indexOf("--delay");
const delaySec = delayIdx > -1 ? Number(process.argv[delayIdx + 1] || 0) : 0;
if (!cwd) { console.error("用法: node export-run.mjs <cwd> [--delay 秒]"); process.exit(1); }
if (delaySec > 0) await new Promise((r) => setTimeout(r, delaySec * 1000));

/** pi 的 cwd 目录编码：/a/b/c → --a-b-c-- */
const sessionsDir = join(AGENT_DIR, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
if (!existsSync(sessionsDir)) { console.error(`无会话目录: ${sessionsDir}`); process.exit(1); }

// 最新主会话（文件名 mtime 最大者）+ 同名目录下的 subagent 会话
const mains = readdirSync(sessionsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ f, m: statSync(join(sessionsDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (!mains.length) { console.error("无会话文件"); process.exit(1); }
const stem = mains[0].f.replace(/\.jsonl$/, "");

const children = [];
const treeDir = join(sessionsDir, stem);
if (existsSync(treeDir)) {
  for (const runId of readdirSync(treeDir)) {
    for (const runN of readdirSync(join(treeDir, runId))) {
      const f = join(treeDir, runId, runN, "session.jsonl");
      if (existsSync(f)) children.push({ runId, runN, file: f });
    }
  }
}

// run-history.jsonl：taskHash 前 8 位 = runId → agent 名
const names = new Map();
const hist = join(AGENT_DIR, "run-history.jsonl");
if (existsSync(hist)) {
  for (const line of readFileSync(hist, "utf-8").split("\n")) {
    try { const e = JSON.parse(line); if (e.taskHash && e.agent) names.set(e.taskHash.slice(0, 8), e.agent); } catch {}
  }
}

const outDir = join(cwd, ".vulnforge", "report", "sessions", stem);
mkdirSync(outDir, { recursive: true });

const jobs = [
  { label: "main（decide 主会话）", file: join(sessionsDir, mains[0].f), out: "main.html" },
  ...children.map((c) => ({
    label: `${names.get(c.runId) ?? "subagent"} · ${c.runId}/${c.runN}`,
    file: c.file,
    out: `${c.runId}-${c.runN}.html`,
  })),
];

const items = [];
for (const j of jobs) {
  try {
    execFileSync("pi", ["--export", j.file, join(outDir, j.out)], { stdio: "pipe", timeout: 120_000 });
    items.push({ ...j, ok: true });
  } catch { items.push({ ...j, ok: false }); }
}

const lis = items.map((i) => (i.ok ? `<li><a href="${i.out}">${i.label}</a></li>` : `<li>${i.label}（导出失败）</li>`)).join("\n");
writeFileSync(
  join(outDir, "index.html"),
  `<!DOCTYPE html><meta charset="utf-8"><title>run ${stem}</title>\n<h2>会话树 · ${stem}</h2><ul>\n${lis}\n</ul>\n<p style="color:#888">session-archive 生成（渲染复用 pi --export）</p>`,
);
console.log(`已导出 ${items.filter((i) => i.ok).length}/${items.length} 个会话 → ${outDir}/index.html`);
