/**
 * workflow 静态注册表（HALL-47 / GH#4 定稿方案 A）：
 *
 * 原发现机制是对本目录做 Node 原生 ESM 动态 import，绕过了 pi 宿主的 jiti 加载器，
 * 导致两件事同时发生（同一问题的两面）：
 *   1. Node 22 strip-only 不支持参数属性等 TS 语法 → ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；
 *   2. bare import（@earendil-works/*）按裸 node_modules 规则解析 → ERR_MODULE_NOT_FOUND。
 * 且即使修通（issue 作者本地 symlink 验证过 import 本身可通），staged workflow 的默认导出
 * 是 StagedWorkflow（只有 stages()，无 run），旧代码的形态校验 `typeof w.run === "function"`
 * 依然会把它静默丢掉——第三层根因，本注册表用 staged() 适配一并修掉。
 *
 * 现改为静态 import 经本注册表汇入 index.ts，全程走 jiti——与扩展本体同一加载机制，
 * 加载失败 = 扩展加载失败，启动即报错，不会被 catch 静默吞掉。
 *
 * 新增 workflow = 在此加一行（docs/workflow-authoring.md 已同步）。
 * `_retired/` 下的退役 workflow 不进注册表。
 */
import { runStages, type StagedWorkflow, type Workflow } from "../runtime.ts";
import auditLite from "./audit-lite.ts";

/** StagedWorkflow → Workflow 适配：run 交给 runStages 驱动（断点续跑/单步重试语义保留） */
function staged(w: StagedWorkflow): Workflow {
  return {
    name: w.name,
    description: w.description,
    run: (ctx, opts) => runStages(w, ctx, opts),
  };
}

/** workflow 注册表：新增 workflow = 在此加一行。 */
export const WORKFLOWS: Workflow[] = [staged(auditLite)];
