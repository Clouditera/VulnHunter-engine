/**
 * 扩展加载 smoke test（HALL-47 / GH#4）：
 * 用 pi 宿主自己的扩展加载器（jiti + @earendil-works/* alias）真实加载 vulnhunter-runner，
 * 断言 workflow 静态注册表生效——vulnhunter 工具报"未知 workflow"时可用清单里含 audit-lite。
 *
 * 运行：node tests/extension-smoke.spec.mjs
 * 前提：能定位 pi 安装——优先 PI_PACKAGE_DIR 环境变量（指向 @earendil-works/pi-coding-agent
 * 包目录），否则按 pi-node 分发目录布局从本进程 node 可执行文件推断（<root>/bin/node →
 * <root>/lib/node_modules/...）。找不到则 SKIP（退出码 0），CI 未装 pi 时不算失败。
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

/** 定位 pi 包目录（供复用其扩展加载器；找不到返回 null） */
function locatePiPackage() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const guess = resolve(dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  return existsSync(join(guess, "dist", "core", "extensions", "loader.js")) ? guess : null;
}

const piPkg = locatePiPackage();
if (!piPkg) {
  console.log("SKIP 未定位到 pi 安装（可用 PI_PACKAGE_DIR 指向 @earendil-works/pi-coding-agent 包目录）");
  process.exit(0);
}

const { loadExtensions } = await import(`file://${join(piPkg, "dist", "core", "extensions", "loader.js")}`);
const engineRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const extIndex = join(engineRoot, "extensions", "vulnhunter-runner", "index.ts");
const cwd = mkdtempSync(join(tmpdir(), "vh-smoke-"));

// ① 扩展经宿主加载器（jiti）加载成功，工具注册齐全
await t("A. 扩展经 pi 加载器加载成功，vulnhunter/mark_scope 均注册", async () => {
  const { extensions, errors } = await loadExtensions([extIndex], cwd);
  assert(errors.length === 0, `扩展加载失败：${errors.map((e) => e.error).join("; ")}`);
  const ext = extensions[0];
  assert(ext, "未加载到扩展");
  assert(ext.tools.has("vulnhunter"), "vulnhunter 工具未注册");
  assert(ext.tools.has("mark_scope"), "mark_scope 工具未注册");
});

// ② 注册表生效：未知 workflow 的报错里可用清单含 audit-lite（而非空列表）
await t("B. 未知 workflow 报错列出可用清单，含 audit-lite", async () => {
  const { extensions } = await loadExtensions([extIndex], cwd);
  const tool = extensions[0].tools.get("vulnhunter");
  const exec = (args) => tool.definition.execute("smoke", args, undefined, undefined, { cwd });
  let msg = "";
  try {
    await exec({ op: "run", workflow: "__no_such_wf__" });
    assert(false, "未知 workflow 应报错");
  } catch (e) { msg = e.message; }
  assert(msg.includes("audit-lite"), `可用清单未含 audit-lite：${msg}`);
});

// ③ status 正常返回空闲态（错误信息路径可见）
await t("C. op:status 返回空闲态", async () => {
  const { extensions } = await loadExtensions([extIndex], cwd);
  const tool = extensions[0].tools.get("vulnhunter");
  const r = await tool.definition.execute("smoke", { op: "status" }, undefined, undefined, { cwd });
  assert(r.content[0].text.includes("当前空闲"), `status 输出异常：${r.content[0].text.slice(0, 100)}`);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
