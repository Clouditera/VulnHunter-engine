/**
 * session-archive — 会话记录归档扩展
 *
 * 复用 pi 自带的 `pi --export`，把当前 run 的完整会话树
 * （主会话 + 全部 subagent 会话）批量导出为 HTML + index.html 索引（输出 <cwd>/.vulnforge/report/sessions/）。
 * 核心逻辑在 export-run.mjs（可独立命令行使用）。
 *
 * 触发：
 *   /export-run      手动导出（测试中途随时可执行）
 *   session_shutdown 退出 TUI 时自动导出（detached + 延迟 2s 等转录落盘）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "export-run.mjs");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("export-run", {
    description: "导出当前 run 的完整会话树为 HTML（主会话 + 全部 subagent）→ .vulnforge/report/sessions/",
    handler: async (_args, ctx) => {
      const child = spawn(process.execPath, [SCRIPT, process.cwd()], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        if (code === 0) ctx.ui.notify(out.trim() || "导出完成", "info");
        else ctx.ui.notify(`导出失败: ${err.trim() || out.trim() || code}`, "error");
      });
    },
  });

  pi.on("session_shutdown", (e) => {
    if (e.reason !== "quit") return;
    const child = spawn(process.execPath, [SCRIPT, process.cwd(), "--delay", "2"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
  });
}
