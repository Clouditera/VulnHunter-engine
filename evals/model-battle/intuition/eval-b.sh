#!/bin/bash
# 直觉评测矩阵：每（项目,模型）一个容器；容器内按 scope 会话并发 2 跑
# 用法：ZAI_CODING_CN_API_KEY=xxx CLOUDROUTER_API_KEY=yyy bash eval-b.sh [并行数=6] [模型过滤子串]
set -u
PARALLEL=${1:-6}
FILTER=${2:-}
ENGINE=~/vulnforge-eval/engine-frozen
OUT=~/vulnforge-eval/out/intuition
MODELS=(glm-5.2 glm-5.3 glm-5.3-flash deepseek-v4-flash)
# 项目→镜像（与 intuition-set.json 一致）
PROJ_IMG=(
  "redis|vulnforge-target:redis-8.2.1"
  "gogs|vulnforge-target:gogs-0.14.2"
  "vm2|vulnforge-target:vm2-3.10.3"
  "mruby|vulnforge-target:mruby-3.3.0"
)
# 项目→会话数（skip 判定用：全部会话目录都有 _meta.json 才算完成）
declare -A PROJ_SESSIONS=( [redis]="R6-lparser-uaf R7-llex-oob R8-luaunpack-int R9-scriptlua-confusion" [gogs]="G2-org-traversal G3-upload-symlink G4-smarthttp-confusion G5-lfs-dedupe G6-api-privesc G7-ssh-slowloris" [vm2]="J2-bridge-jstag J3-setupsandbox" [mruby]="M1-array M2-codegen M3-vm" )

running() { docker ps --format '{{.Names}}' | grep -c '^eval-b-' || true; }

for entry in "${PROJ_IMG[@]}"; do
  IFS='|' read -r proj img <<< "$entry"
  for model in "${MODELS[@]}"; do
    [ -n "$FILTER" ] && [[ "$model" != *"$FILTER"* ]] && continue
    # 跳过已完成：所有会话都有 _meta.json
    skip=1
    for sn in ${PROJ_SESSIONS[$proj]}; do
      [ -f "$OUT/$model/$sn/_meta.json" ] || skip=0
    done
    [ $skip -eq 1 ] && { echo "[跳过] $model @ $proj（已有结果）"; continue; }
    while [ "$(running)" -ge "$PARALLEL" ]; do sleep 30; done
    cname="eval-b-${proj}-${model}"
    docker rm -f "$cname" >/dev/null 2>&1
    echo "[启动] $cname"
    docker run -d --name "$cname" \
      -e ZAI_CODING_CN_API_KEY="$ZAI_CODING_CN_API_KEY" -e CLOUDROUTER_API_KEY="$CLOUDROUTER_API_KEY" \
      -e EVAL_MODEL="$model" -e EVAL_PROJECT="$proj" \
      -v "$ENGINE/.dist:/opt/vulnforge/.dist:ro" \
      -v "$ENGINE/models.json:/opt/vulnforge/models.json:ro" \
      -v "$ENGINE/tasks/hunt-intuition.md:/opt/vulnforge/tasks/hunt-intuition.md:ro" \
      -v "$ENGINE/evals/model-battle/intuition:/opt/vulnforge/evals/model-battle/intuition:ro" \
      -v "$OUT/$model:/out" \
      --entrypoint node "$img" /opt/vulnforge/evals/model-battle/intuition/eval-intuition.mjs >/dev/null
  done
done
while [ "$(running)" -gt 0 ]; do sleep 60; done
echo "=== 直觉评测矩阵全部结束 ==="
