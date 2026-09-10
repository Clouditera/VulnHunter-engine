#!/bin/bash
# pi 本地补丁（两个，pi 升级会冲掉，升级后重跑本脚本）：
#   补丁1：zai thinkingFormat 恒 enabled——glm-5.2-highspeed 遇 thinking:disabled 必 500（pi 分支摘要不传 thinkingLevel）
#   补丁2：分支摘要 maxTokens 4096→32768——补丁1开启 thinking 后，4096 会被推理 token 吃光导致摘要必失败
# 验证：grep -c VULNFORGE-PATCH 两个目标文件应各为 1
set -e
AI="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
CORE="$(npm root -g)/@earendil-works/pi-coding-agent/dist/core/compaction/branch-summarization.js"

python3 - "$AI" "$CORE" <<'PY'
import pathlib,sys
jobs=[(sys.argv[1],
       'zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };',
       'zaiParams.thinking = { type: "enabled", clear_thinking: false }; // VULNFORGE-PATCH1'),
      (sys.argv[2],
       'const maxTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);',
       'const maxTokens = Math.min(32768, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY); // VULNFORGE-PATCH2')]
for f,old,new in jobs:
    p=pathlib.Path(f); t=p.read_text()
    if new.split(' // ')[0] in t: print("已打过：",f); continue
    assert old in t, f"锚点没找到（pi 版本变了？人工核对）：{f}"
    p.write_text(t.replace(old,new)); print("patched:",f)
PY
