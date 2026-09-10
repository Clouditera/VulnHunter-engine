#!/bin/bash
# pi 本地补丁：zai thinkingFormat 恒 enabled（glm-5.2-highspeed 对 thinking:disabled 必返 500）
# 根因：pi 分支摘要（navigateTree/generateBranchSummary）不传 thinkingLevel → zai 序列化为 disabled → highspeed 500
# pi 升级会冲掉本补丁，升级后重跑此脚本。验证：grep -c VULNFORGE-PATCH <目标文件>
set -e
F="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
[ -f "$F" ] || F="$HOME/.nvm/versions/node/$(node -v)/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
grep -q VULNFORGE-PATCH "$F" && { echo "已打过"; exit 0; }
python3 - "$F" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); t=p.read_text()
old='zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };'
new='zaiParams.thinking = { type: "enabled", clear_thinking: false }; // VULNFORGE-PATCH: glm-5.2-highspeed rejects thinking:disabled with 500'
assert old in t, "补丁锚点没找到（pi 版本变了？人工核对后再打）"
p.write_text(t.replace(old,new)); print("patched:", p)
PY
