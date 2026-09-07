#!/usr/bin/env bash
# 单个版本组重跑：run-group.sh <镜像> <版本> <模型> <用例JSON>
set -uo pipefail
IMAGE=$1; VER=$2; MODEL=$3; CASES=$4
OUT=~/vulnforge-eval/out/phase-a/$MODEL
ENGINE=~/vulnforge-eval/engine
NAME="eval-a-${VER}-${MODEL}-$(date +%H%M)"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" \
  -e ZAI_CODING_CN_API_KEY="$ZAI_CODING_CN_API_KEY" -e CLOUDROUTER_API_KEY="$CLOUDROUTER_API_KEY" \
  -e EVAL_MODEL="$MODEL" -e EVAL_CASES="$CASES" \
  -v "$OUT":/out \
  -v "$ENGINE/evals/model-battle/infra/eval-phase-a.mjs:/opt/vulnforge/evals/model-battle/infra/eval-phase-a.mjs:ro" \
  -v "$ENGINE/.dist:/opt/vulnforge/.dist:ro" \
  --entrypoint node "$IMAGE" /opt/vulnforge/evals/model-battle/infra/eval-phase-a.mjs >/dev/null
echo "启动 $NAME"
