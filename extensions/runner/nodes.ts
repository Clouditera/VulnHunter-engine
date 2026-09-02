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

export const NODES: Record<string, NodeSpec> = {
  onboard: {
    skills: ["project-profiler", "threat-modeling", "wiki-maintainer"],
    fns: ["update_profiler", "update_build_state"],
  },
  research: {
    skills: ["audit-chain"],
    extensions: ["pi-web-access"],
    fns: ["emit_adv_s", "emit_lead"],
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
