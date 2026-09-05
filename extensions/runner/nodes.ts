/**
 * 节点定义表（NodeSpec）——pi-subagents frontmatter 的代码化替代。
 * agents/<name>.md 是纯散文任务书；机制配置全部在这里。
 */

import type { FnKind } from "./workspace-tools.ts";

export interface NodeSpec {
  /** pi 内建工具白名单；省略=默认集（read/bash/edit/write + 注入的函数与扩展工具） */
  tools?: string[];
  /** 挂载的技能（engineDir/skills/ 下名称） */
  skills?: string[];
  /** 挂载的扩展（裸名 → engineDir/extensions/<name>） */
  extensions?: string[];
  /** 产物函数授权（精确到函数；线别在 FnKind 里） */
  fns: FnKind[];
}

/** 初始化节点（onboard/research）统一配置（fish 09-05 裁定 #4：同一份，消除差异）
 *  同会话连续执行：函数取两阶段并集，扩展同挂 pi-web-access。 */
const INIT_NODE: NodeSpec = {
  skills: ["project-profiler", "threat-modeling", "wiki-maintainer", "audit-chain"],
  extensions: ["pi-web-access"],
  fns: ["update_profiler", "update_build_state", "emit_adv_s", "emit_lead"],
};

export const NODES: Record<string, NodeSpec> = {
  onboard: INIT_NODE,
  research: INIT_NODE,
  /** init-session 宿主（onboard/research 同会话 + hunt 多轮也在这个会话里跑，fish 09-05 #6）：
   *  函数 = init 并集 + hunt 的 emit_hyp */
  "init-host": {
    skills: ["project-profiler", "threat-modeling", "wiki-maintainer", "audit-chain"],
    extensions: ["pi-web-access"],
    fns: ["update_profiler", "update_build_state", "emit_adv_s", "emit_lead", "emit_hyp"],
  },
  cognize: {
    skills: ["wiki-maintainer", "audit-chain"],
    extensions: ["code-coverage"],   // coverage 查询工具（记录侧由 hunt 独占）
    fns: ["emit_adv_c"],
  },
  hunt: {
    fns: ["emit_hyp", "emit_lead"],
  },
  verify: {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],                    // 政策核验的在线查证
    fns: ["emit_finding", "emit_lead"],
  },
  /** HYP 链节点（verify→poc-verify→ev-assess 同会话）：函数取三阶段并集（fish 09-05 最简 run） */
  "hyp-chain": {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],
    fns: ["emit_finding", "update_finding", "emit_lead"],
  },
  "poc-verify": {
    skills: ["bug-report"],
    fns: ["update_finding", "emit_lead"],
  },
  "ev-assess": {
    skills: ["bug-report"],
    fns: ["update_finding", "emit_lead"],
  },
  "exp-build": {
    fns: ["update_finding", "emit_lead"],
  },
};
