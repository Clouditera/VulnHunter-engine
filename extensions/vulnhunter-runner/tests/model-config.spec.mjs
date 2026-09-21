/** 模型配置纯函数回归：解析/读写/合并/优先级（fish 09-21 按池模型配置） */
import { parseModelSpec, readModelConfig, writeModelConfig, effectiveModelSpec, seedModelConfigFromParams, createLiveModelSwitch, createModelFileWatch } from "../.dist/src/model-config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m ?? "assert"); };
async function t(n, f) { try { await f(); console.log("PASS", n); pass++; } catch (e) { console.log("FAIL", n, "-", e?.message ?? e); fail++; } }

const mk = () => mkdtempSync(join(tmpdir(), "modelcfg-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await t("parseModelSpec：合法/非法", async () => {
  const a = parseModelSpec("zai-coding-cn/glm-5.3-flash:high");
  assert(a.provider === "zai-coding-cn" && a.id === "glm-5.3-flash" && a.thinking === "high", "三段解析");
  const b = parseModelSpec("sec-autos/glm-5.3");
  assert(b.provider === "sec-autos" && b.id === "glm-5.3" && b.thinking === undefined, "两段解析");
  let threw = false;
  try { parseModelSpec("bad-spec"); } catch { threw = true; }
  assert(threw, "非法格式要抛错");
});

await t("write/read/merge/clear", async () => {
  const W = mk();
  writeModelConfig(W, { hunt: "zai-coding-cn/glm-5.3-flash:high" });
  writeModelConfig(W, { verify: "zai-coding-cn/glm-5.3" });
  let cfg = readModelConfig(W);
  assert(cfg.hunt === "zai-coding-cn/glm-5.3-flash:high" && cfg.verify === "zai-coding-cn/glm-5.3", "合并写入");
  writeModelConfig(W, { hunt: "" });
  cfg = readModelConfig(W);
  assert(cfg.hunt === undefined && !!cfg.verify, "空串清除该项");
  rmSync(W, { recursive: true, force: true });
});

await t("effectiveModelSpec：池项 → global → undefined", async () => {
  const cfg = { global: "g/one", hunt: "h/two" };
  assert(effectiveModelSpec(cfg, "hunt") === "h/two", "池项优先");
  assert(effectiveModelSpec(cfg, "verify") === "g/one", "回落 global");
  assert(effectiveModelSpec({}, "init") === undefined, "空配置=undefined（走 settings 默认）");
});

await t("seedModelConfigFromParams：只写显式项，不动已有项", async () => {
  const W = mk();
  seedModelConfigFromParams(W, {});
  assert(Object.keys(readModelConfig(W)).length === 0, "空参数不动文件");
  seedModelConfigFromParams(W, { model_hunt: "a/one", model: "g/two" });
  const cfg = readModelConfig(W);
  assert(cfg.hunt === "a/one" && cfg.global === "g/two", "参数并入");
  seedModelConfigFromParams(W, { model_verify: "v/three" });
  const cfg2 = readModelConfig(W);
  assert(cfg2.hunt === "a/one" && cfg2.verify === "v/three", "再次 seed 保留已有");
  rmSync(W, { recursive: true, force: true });
});

await t("live 热切换：变更→按池应用、不重复、可注销", async () => {
  const W = mk();
  writeModelConfig(W, { hunt: "a/h1" });
  const calls = [];
  const fake = (id) => ({ id, setModel: async (s) => { calls.push([id, s]); } });
  const sw = createLiveModelSwitch({ read: () => readModelConfig(W) });
  const h1 = fake("h1"), h2 = fake("h2");
  const un1 = sw.register(h1, () => "hunt", "a/h1");
  const un2 = sw.register(h2, () => "verify", undefined);
  await sw.apply();
  assert(calls.length === 0, "无变更不动");
  writeModelConfig(W, { verify: "b/v1" });
  await sw.apply();
  assert(calls.length === 1 && calls[0][0] === "h2" && calls[0][1] === "b/v1", `仅 h2 切换，实际 ${JSON.stringify(calls)}`);
  writeModelConfig(W, { hunt: "a/h2x" });
  await sw.apply();
  assert(calls.length === 2 && calls[1][0] === "h1" && calls[1][1] === "a/h2x", "h1 切换");
  await sw.apply();
  assert(calls.length === 2, "无重复应用");
  un1(); un2();
  assert(sw.size() === 0, "注销后清空");
  rmSync(W, { recursive: true, force: true });
});

await t("文件监听：变更触发、释放停止", async () => {
  const W = mk();
  writeModelConfig(W, { global: "a/b" });
  let fired = 0;
  const w = createModelFileWatch({ workdir: W, onChanged: () => { fired++; }, intervalMs: 50 });
  const release = w.acquire();
  await sleep(130);
  assert(fired === 0, `未变更不触发（实际 ${fired}）`);
  writeModelConfig(W, { global: "c/d" });
  await sleep(220);
  assert(fired >= 1, `变更触发（实际 ${fired}）`);
  release();
  const before = fired;
  writeModelConfig(W, { global: "e/f" });
  await sleep(220);
  assert(fired === before, "释放后停止");
  rmSync(W, { recursive: true, force: true });
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
