/**
 * 准入闸 admit() 去重粒度修复单测（HALL-72；规格 GitHub issue #8）。
 * 运行：node tests/admit-granularity.spec.mjs（先构建 .dist）
 *
 * 覆盖：
 *  1. 同文件 ±15 行内 + 同类 + med → REJECT_DUP；行号差 15 判重 / 16 放行（边界）
 *  2. 同文件不同行（>15）+ 同类 → ADMIT
 *  3. 仅函数名交集 + 同类、无 file:line 锚点 → ADMIT（kilo #94 / chibicc 误拒核心回归）
 *  4. 判重命中 + high + novelty_basis 非空 → ADMIT_VARIANT；占位 novelty → REJECT_DUP
 *  5. low + 空 novelty_basis → REJECT_LOW_QUALITY（回归不破）
 *  6. similarity() 打分矩阵回归（5 行各至少一例）
 *  7. 回放 fixture：kilo #94 场景 + chibicc 风格 11 条同函数/同 CWE 不同行案例 → 全部放行
 */
import { admit, similarity, sameTarget, LINE_WINDOW, DUP_THRESHOLD } from "../.dist/src/tools/hyp.js";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { console.log("PASS", name); pass++; }
  else { console.log("FAIL", name); fail++; }
}
function eq(actual, expected, name) {
  if (Object.is(actual, expected)) { console.log("PASS", name); pass++; }
  else { console.log(`FAIL ${name}：期望 ${expected}，实得 ${actual}`); fail++; }
}

// ---- 常量自检 ----
eq(LINE_WINDOW, 15, "LINE_WINDOW=15");
eq(DUP_THRESHOLD, 0.8, "DUP_THRESHOLD=0.8");

// 公共模板：同文件 src/x.c 不同行号的 CWE-787 缓冲区溢出假设
const base = (line, fn = "read_config") => ({
  body: `## 漏洞主张\n缓冲区溢出（CWE-787），memcpy 未校验长度。\n**代码锚点**：src/x.c:${line}\n涉及函数 ${fn}(src) 调用链。`,
});
const newHyp = (line, extra = {}) => ({
  body: `## 漏洞主张\n另一处缓冲区溢出（CWE-787），snprintf 长度误算。\n**代码锚点**：src/x.c:${line}\n涉及函数 ${extra.fn ?? "write_config"}(dst) 调用链。`,
  confidence: extra.confidence ?? "med",
  novelty_basis: extra.novelty_basis ?? "与已有 HYP 不同：snprintf 长度误算路径，非 memcpy",
});

// ---- 1. 同文件 ±15 行内 + 同类 + med → REJECT_DUP；边界 15 / 16 ----
eq(admit(newHyp(110), [base(100)]), "REJECT_DUP", "行号差 10 + 同类 → REJECT_DUP");
eq(admit(newHyp(115), [base(100)]), "REJECT_DUP", "行号差恰好 15 → 判重（REJECT_DUP）");
eq(admit(newHyp(85), [base(100)]), "REJECT_DUP", "反向行号差 15 → 判重（REJECT_DUP）");
eq(admit(newHyp(116), [base(100)]), "ADMIT", "行号差恰好 16 → 放行（ADMIT）");

// ---- 2. 同文件不同行（>15）+ 同类 → ADMIT ----
eq(admit(newHyp(200), [base(100)]), "ADMIT", "同文件行号差 100 + 同类 → ADMIT");

// ---- 3. 仅函数名交集 + 同类、无 file:line 锚点 → ADMIT（误拒核心回归）----
{
  const ex = { body: "越界读（CWE-125）：equal() 解析输入时未校验下标。" };
  const nh = { body: "另一处越界读（CWE-125）：equal() 在另一调用点边界判断错误。", confidence: "med", novelty_basis: "不同调用点，独立缺陷" };
  eq(admit(nh, [ex]), "ADMIT", "仅函数名交集 + 同类、无锚点 → ADMIT");
  eq(similarity(nh, ex), 0.4, "仅函数名+同类 similarity=0.4（< 0.8 不判重）");
}

// ---- 4. 判重命中 + high + novelty_basis 非空 → ADMIT_VARIANT；占位 → REJECT_DUP ----
{
  const highHyp = { ...newHyp(110), confidence: "high", novelty_basis: "与 HYP-1 不同：另一输入入口，独立触发路径" };
  eq(admit(highHyp, [base(100)]), "ADMIT_VARIANT", "判重命中 + high + 有效 novelty_basis → ADMIT_VARIANT");
  const highTodo = { ...newHyp(110), confidence: "high", novelty_basis: "TODO" };
  eq(admit(highTodo, [base(100)]), "REJECT_DUP", "high + 占位 novelty_basis(TODO) → 仍 REJECT_DUP");
  const highNone = { ...newHyp(110), confidence: "high", novelty_basis: "无" };
  eq(admit(highNone, [base(100)]), "REJECT_DUP", "high + 占位 novelty_basis(无) → 仍 REJECT_DUP");
  const medVariant = { ...newHyp(110), confidence: "med" };
  eq(admit(medVariant, [base(100)]), "REJECT_DUP", "med 即使 novelty 非空 → REJECT_DUP（不逃逸）");
}

// ---- 5. low + 空 novelty_basis → REJECT_LOW_QUALITY（回归不破）----
eq(admit({ body: "全新假设 main() 空指针解引用（CWE-476）。", confidence: "low" }, []), "REJECT_LOW_QUALITY", "low + novelty 缺失 → REJECT_LOW_QUALITY");
eq(admit({ body: "全新假设 main() 空指针解引用（CWE-476）。", confidence: "low", novelty_basis: "首个空指针假设" }, []), "ADMIT", "low + 有 novelty_basis → ADMIT");

// ---- 6. similarity() 打分矩阵 ----
{
  // 强靶点 + 同类 = 1.0
  eq(similarity(base(100), newHyp(105)), 1.0, "sim：强靶点+同类 = 1.0");
  // 仅强靶点 = 0.7（CWE 不同类）
  const diffClass = { body: "## 路径穿越（CWE-22），fopen 未过滤 ..。\n**代码锚点**：src/x.c:104" };
  eq(similarity(base(100), diffClass), 0.7, "sim：仅强靶点 = 0.7");
  // 仅弱靶点（函数名）+ 同类 = 0.4（上方已验，此处补显式锚点不同文件场景）
  const fnOnly = { body: "CWE-787 缓冲区溢出：write_config(dst) 长度越界。", };
  eq(similarity(fnOnly, { body: "CWE-787 缓冲区溢出：write_config(src) 复用未释放。" }), 0.4, "sim：仅弱靶点+同类 = 0.4");
  // 仅同类 = 0.2
  eq(similarity(base(100), { body: "CWE-787：util/helper.c:500 堆溢出，alloc_buf() 申请过小。" }), 0.2, "sim：仅同类 = 0.2");
  // 其他 = 0
  eq(similarity(base(100), { body: "SQL 注入（CWE-89）：db/query.c:7 拼接语句，exec() 直查。" }), 0, "sim：无关 = 0");
}

// ---- 6b. sameTarget 语义：强靶点=同文件±15行；弱信号（函数名）不单独构成同靶点 ----
ok(sameTarget(base(100), newHyp(110)) === true, "sameTarget：同文件 ±15 行 → true");
ok(sameTarget(base(100), newHyp(116)) === false, "sameTarget：同文件差 16 行 → false");
ok(sameTarget(base(100), { body: "read_config() 完全不同的逻辑说明，无锚点。" }) === false, "sameTarget：仅函数名交集 → false");

// ---- 7. 回放 fixture（GitHub issue #8 场景合成；原 .vulnforge/rejected_hyps.log 不在仓库内）----
// kilo #94：editorUpdateSyntax 转义分支跳过 NUL 越界（CWE-787），与已有 HYP 同函数不同行
{
  const existing = [
    { body: "## 漏洞主张\nkilo：editorUpdateSyntax() 字符串收尾未补 NUL，越界写（CWE-787）。\n**代码锚点**：kilo.c:452" },
  ];
  const n94 = {
    body: "## 漏洞主张\nkilo #94：editorUpdateSyntax() 转义分支跳过 NUL，越界（CWE-787）。\n**代码锚点**：kilo.c:488",
    confidence: "high",
    novelty_basis: "与既有 HYP 不同：转义分支读取路径，非写入收尾",
  };
  const v = admit(n94, existing);
  ok(v === "ADMIT" || v === "ADMIT_VARIANT", `回放 kilo #94 同函数不同行 → 放行（实得 ${v}）`);
}
// chibicc 风格 11 条：同函数名 / 同 CWE 不同行号，全部应放行
{
  const existing = [
    { body: "chibicc：parse.c 整数溢出（CWE-190），equal() 长度比较绕过。\n**代码锚点**：parse.c:120" },
    { body: "chibicc：tokenize.c 越界读（CWE-125），starts_with() 前缀误判。\n**代码锚点**：tokenize.c:55" },
  ];
  const cases = [];
  for (let i = 1; i <= 6; i++) {
    cases.push({
      name: `chibicc parse.c 同函数同 CWE 不同行 #${i}`,
      hyp: { body: `chibicc：parse.c 整数溢出（CWE-190），equal() 边界 #${i}。\n**代码锚点**：parse.c:${200 + i * 40}`, confidence: "med", novelty_basis: `独立缺陷 #${i}` },
    });
  }
  for (let i = 1; i <= 5; i++) {
    cases.push({
      name: `chibicc tokenize.c 同函数同 CWE 不同行 #${i}`,
      hyp: { body: `chibicc：tokenize.c 越界读（CWE-125），starts_with() 边界 #${i}。\n**代码锚点**：tokenize.c:${120 + i * 37}`, confidence: "med", novelty_basis: `独立缺陷 t#${i}` },
    });
  }
  ok(cases.length === 11, "回放 fixture 共 11 条 chibicc 风格案例");
  let rejected = 0;
  for (const c of cases) {
    const v = admit(c.hyp, existing);
    if (v === "REJECT_DUP" || v === "REJECT_LOW_QUALITY") rejected++;
    ok(v === "ADMIT" || v === "ADMIT_VARIANT", `回放 ${c.name} → 放行（实得 ${v}）`);
  }
  eq(rejected, 0, "回放 chibicc 11 条全部被拒数为 0");
}

console.log(`\n=== admit-granularity：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
