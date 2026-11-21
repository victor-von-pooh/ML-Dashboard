#!/usr/bin/env bash
# README と操作ガイドの画面の図 (実験の一覧と比較) を撮り直す. make demo と同じ
# 4 つの実験を作業用のディレクトリに作り, ダッシュボードを起動して
# e2e/screenshots.ts で撮る. 画面は pnpm build で作っておく
set -euo pipefail

cd "$(dirname "$0")"
WORK="$PWD/.work/shots"
PORT="${SHOTS_PORT:-8792}"

# 前回の結果を消し, デモのプロジェクトを作業用のディレクトリに写す
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --exclude outputs ../../demo/ "$WORK/demo/"

# make demo と同じ 4 つの実験
cd ../../backend
for config in train.yaml examples/sgd.yaml examples/small.yaml examples/eval_train.yaml; do
  log="$WORK/train.log"
  if ! uv run python "$WORK/demo/train.py" \
    --experiment "configs/experiment/$config" > "$log" 2>&1; then
    cat "$log"
    exit 1
  fi
done

# データの置き場も作業用のディレクトリにして起動し, 終わったら止める
ML_DASHBOARD_HOME="$WORK/home" ML_DASHBOARD_TOKEN=shots-token \
  uv run ml-dashboard --port "$PORT" > "$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2> /dev/null || true' EXIT
for _ in $(seq 60); do
  if curl -sf -H 'x-dashboard-token: shots-token' \
    "http://127.0.0.1:$PORT/api/projects" > /dev/null; then
    break
  fi
  sleep 1
done

cd ../frontend
SHOTS_URL="http://127.0.0.1:$PORT" SHOTS_TOKEN=shots-token SHOTS_DEMO="$WORK/demo" \
  node e2e/screenshots.ts
