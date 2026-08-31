/**
 * 节点定义表（NodeSpec）——pi-subagents frontmatter 的代码化替代。
 * agents/<name>.md 是纯散文任务书；机制配置全部在这里。
 */

import type { FnKind } from "./workspace-tools.ts";

export interface NodeSpec {
  /** pi 内建工具白名单 */
  tools: string[];
  /** 挂载的技能（engineDir/skills/ 下名称） */
  skills?: string[];
  /** 挂载的扩展（裸名 → engineDir/extensions/<name>） */
  extensions?: string[];
  /** 产物函数授权（精确到函数；线别在 FnKind 里） */
  fns: FnKind[];
  /** 超时（ms） */
  timeoutMs: number;
}

const T30 = 30 * 60_000;

export const NODES: Record<string, NodeSpec> = {
  onboard: {
    tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    skills: ["project-profiler", "threat-modeling", "wiki-maintainer"],
    fns: ["update_profiler", "update_build_state", "emit_lead"],
    timeoutMs: T30,
  },
  research: {
    tools: ["read", "grep", "find", "ls", "write", "edit"],
    extensions: ["pi-web-access"],
    fns: ["emit_adv_s", "emit_lead"],
    timeoutMs: T30,
  },
  cognize: {
    tools: ["read", "grep", "find", "ls", "write", "edit"],
    skills: ["wiki-maintainer"],
    extensions: ["code-coverage"],   // coverage 查询工具（记录侧由 hunt 独占）
    fns: ["emit_adv_c", "emit_lead"],
    timeoutMs: T30,
  },
  hunt: {
    tools: ["read", "grep", "find", "ls"],
    fns: ["emit_hyp", "emit_lead"],
    timeoutMs: T30,
  },
  verify: {
    tools: ["read", "grep", "find", "ls", "edit"],   // edit 用于往 HYP 正文追加研判
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],                    // 政策核验的在线查证
    fns: ["emit_finding", "emit_lead"],
    timeoutMs: T30,
  },
  "poc-verify": {
    tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    skills: ["bug-report"],
    fns: ["update_finding", "emit_lead"],
    timeoutMs: 60 * 60_000,
  },
  "ev-assess": {
    tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    skills: ["bug-report"],
    fns: ["update_finding", "emit_lead"],
    timeoutMs: T30,
  },
  "exp-build": {
    tools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    fns: ["update_finding", "emit_lead"],
    timeoutMs: 90 * 60_000,
  },
};
