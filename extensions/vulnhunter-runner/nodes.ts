/**
 * 节点定义表（NodeSpec）——pi-subagents frontmatter 的代码化替代。
 * agents/<name>.md 是纯散文任务书；机制配置全部在这里。
 */


export interface NodeSpec {
  /** pi 内建工具白名单；省略=默认集（read/bash/edit/write + 注入的函数与扩展工具） */
  tools?: string[];
  /** 挂载的技能（扩展内 skills/ 下名称） */
  skills?: string[];
  /** 挂载的扩展（裸名 → engineDir/extensions/<name>） */
  extensions?: string[];
}

/** 初始化节点（onboard/research）统一配置（fish 09-05 裁定 #4：同一份，消除差异）
 *  同会话连续执行：函数取两阶段并集，扩展同挂 pi-web-access。 */
const INIT_NODE: NodeSpec = {
  skills: ["project-profiler", "threat-modeling", "wiki-maintainer", "audit-chain"],
  extensions: ["pi-web-access"],
};

export const NODES: Record<string, NodeSpec> = {
  onboard: INIT_NODE,
  research: INIT_NODE,
  /** build：理解构建/部署 + 按需实际执行（fish 09-08；onboard 之后固定环节） */
  build: {},
  /** init-session 宿主（onboard/research 同会话 + hunt 多轮也在这个会话里跑，fish 09-05 #6）：
   *  函数 = init 并集 + hunt 的 emit_hyp */
  "init-host": {
    skills: ["project-profiler", "threat-modeling", "wiki-maintainer", "audit-chain"],
    extensions: ["pi-web-access"],
  },
  cognize: {
    skills: ["wiki-maintainer", "audit-chain"],
    extensions: ["code-coverage"],   // coverage 查询工具（记录侧由 hunt 独占）
  },
  hunt: {
  },
  /** 直觉评测专用：静态局部审计，只产 HYP（无 lead/无沙箱） */
  "hunt-intuition": {
  },
  verify: {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],                    // 政策核验的在线查证
  },
  /** static-verify：无沙箱时的纯静态裁决（fish 09-10） */
  "static-verify": {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],
  },
  /** dynamic-verify：有沙箱时研判+复现合并（fish 09-10） */
  "dynamic-verify": {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],
  },
  /** HYP 链节点（verify→poc-verify→ev-assess 同会话）：函数取三阶段并集（fish 09-05 最简 run） */
  "hyp-chain": {
    skills: ["bug-report", "wiki-maintainer"],
    extensions: ["pi-web-access"],
  },
  "poc-verify": {
    skills: ["bug-report"],
  },
  "ev-assess": {
    skills: ["bug-report"],
  },
  "exp-build": {
  },
};
