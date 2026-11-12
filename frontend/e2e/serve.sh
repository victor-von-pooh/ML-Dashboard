#!/usr/bin/env bash
# 画面の通しのテスト (Playwright) 用に, デモのプロジェクトで実験を 2 つ作ってから
# ダッシュボードを起動する. 画面は pnpm build で作っておく
set -euo pipefail

cd "$(dirname "$0")"
WORK="$PWD/.work"
PORT="${E2E_PORT:-8791}"

# 前回の結果を消し, デモのプロジェクトを作業用のディレクトリに写す
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --exclude outputs ../../demo/ "$WORK/demo/"

# config の違う 2 つの実験 (どちらも 3 エポック)
cd ../../backend
# 学習の出力は残し, 失敗した場合は表示してから止める
for config in quick.yaml quick_sgd.yaml; do
  log="$WORK/train-${config%.yaml}.log"
  if ! uv run python "$WORK/demo/train.py" \
    --experiment "configs/experiment/examples/$config" > "$log" 2>&1; then
    cat "$log"
    exit 1
  fi
done

# データの置き場も作業用のディレクトリにし, 決まったトークンで起動
ML_DASHBOARD_HOME="$WORK/home" ML_DASHBOARD_TOKEN=e2e-token \
  exec uv run ml-dashboard --port "$PORT"
