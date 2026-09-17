/**
 * resolveProvider key 解析链测试（V2 阻断件修复，Leo 09-17）：
 * models.json 内联 → `$VAR` env → auth.json[provider].key；全无时报错列明尝试来源。
 * 运行：node tests/branch-summary-key.spec.mjs（先构建 .dist）
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider } from "../.dist/src/branch-summary.js";

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assert failed"); };
async function t(name, fn) {
  try { await fn(); console.log("PASS", name); pass++; }
  catch (e) { console.log("FAIL", name, "-", e?.message ?? e); fail++; }
}

const mkEngine = ({ apiKey, auth }) => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-provider-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    providers: { "cred-x": { baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey } },
  }));
  if (auth !== undefined) writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
};

await t("① models.json 内联 key：直接命中", async () => {
  const dir = mkEngine({ apiKey: "sk-inline" });
  const c = resolveProvider(dir, "cred-x", "m1");
  assert(c.apiKey === "sk-inline", JSON.stringify(c));
  assert(c.baseUrl === "https://gw.example/v1" && c.modelId === "m1", JSON.stringify(c));
});

await t("② $VAR env 有值：env 命中（优先于 auth.json）", async () => {
  const dir = mkEngine({ apiKey: "$SPEC_TEST_KEY", auth: { "cred-x": { type: "api_key", key: "sk-auth" } } });
  process.env.SPEC_TEST_KEY = "sk-env";
  try { assert(resolveProvider(dir, "cred-x", "m1").apiKey === "sk-env"); }
  finally { delete process.env.SPEC_TEST_KEY; }
});

await t("③ $VAR env 未设置：回退 auth.json（容器实况；修复前必抛）", async () => {
  const dir = mkEngine({ apiKey: "$SPEC_MISSING_KEY", auth: { "cred-x": { type: "api_key", key: "sk-auth" } } });
  delete process.env.SPEC_MISSING_KEY;
  assert(resolveProvider(dir, "cred-x", "m1").apiKey === "sk-auth");
});

await t("④ auth.json 存在但无该 provider：报错列明来源（env 名 + auth.json）", async () => {
  const dir = mkEngine({ apiKey: "$SPEC_MISSING_KEY", auth: { "cred-other": { type: "api_key", key: "sk-other" } } });
  delete process.env.SPEC_MISSING_KEY;
  try { resolveProvider(dir, "cred-x", "m1"); throw new Error("应当抛错"); }
  catch (e) {
    assert(/key 解析失败/.test(e.message), e.message);
    assert(e.message.includes("env SPEC_MISSING_KEY 未设置"), e.message);
    assert(e.message.includes("auth.json[cred-x] 无 key"), e.message);
  }
});

await t("⑤ 全无（无 auth.json）：报错列明尝试来源", async () => {
  const dir = mkEngine({ apiKey: "$SPEC_MISSING_KEY" });
  delete process.env.SPEC_MISSING_KEY;
  try { resolveProvider(dir, "cred-x", "m1"); throw new Error("应当抛错"); }
  catch (e) {
    assert(/key 解析失败/.test(e.message), e.message);
    assert(e.message.includes("env SPEC_MISSING_KEY 未设置"), e.message);
    assert(e.message.includes("auth.json[cred-x] 不可读"), e.message);
  }
});

await t("⑥ provider 不在 models.json：原错误保留", async () => {
  const dir = mkEngine({ apiKey: "x" });
  try { resolveProvider(dir, "nope", "m1"); throw new Error("应当抛错"); }
  catch (e) { assert(/找不到 provider nope/.test(e.message), e.message); }
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
