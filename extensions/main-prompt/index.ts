/**
 * main-prompt 注入扩展
 *
 * 效果：把仓库根的 main-prompt.md 作为主会话 system prompt，
 * 无需 --system-prompt 参数；每次 turn 前重新读文件（改提示词即时生效）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  // 兜底：从扩展文件位置推（<repo>/extensions/main-prompt/index.ts → <repo>）
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

const DECIDE_SKILLS = ["threat-modeling", "wiki-maintainer"];

export default function (pi: ExtensionAPI) {
  // decide 的技能绑定（对齐 youngflow flow.audit.yaml decide 阶段）：
  // 以扩展贡献方式注册，--no-skills 屏蔽外部发现时仍可用
  pi.on("resources_discover", () => ({
    skillPaths: DECIDE_SKILLS.map((s) => join(agentDir(), "skills", s)),
  }));

  pi.on("before_agent_start", () => {
    const dir = agentDir();
    const promptPath = join(dir, "main-prompt.md");
    if (!existsSync(promptPath)) return undefined;
    // main-prompt（decide 专属）+ AGENTS.md（共享基底）。
    // 返回的是全量替换，project_context 会被覆盖，故在此显式拼接。
    let prompt = readFileSync(promptPath, "utf-8");
    const agentsPath = join(dir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      prompt += `\n\n<project_context>\n\n${readFileSync(agentsPath, "utf-8")}\n</project_context>\n`;
    }
    return { systemPrompt: prompt };
  });
}
