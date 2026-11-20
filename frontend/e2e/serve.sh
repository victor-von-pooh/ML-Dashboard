#!/usr/bin/env bash
# 画面の通しのテスト (Playwright) 用に, デモのプロジェクトで実験を 2 つ作り,
# 強化学習の確かめ用のプロジェクトを写してから
# ダッシュボードを起動する. 画面は pnpm build で作っておく
set -euo pipefail

cd "$(dirname "$0")"
WORK="$PWD/.work"
PORT="${E2E_PORT:-8791}"

# 前回の結果を消し, デモのプロジェクトを作業用のディレクトリに写す
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --exclude outputs ../../demo/ "$WORK/demo/"
# 強化学習の実験 (Gymnasium を入れずに方策の一式を見るため, 学習せずに置いたもの)
rsync -a fixtures/rl/ "$WORK/rl/"

# 書き出したプロジェクトの一覧の確かめ用に, ML-Pathfinder の置き場と, そこに
# 記録した (まだ登録していない) 学習のプロジェクトと, 記録の無い問題の設定
mkdir -p "$WORK/exported/configs/default" "$WORK/pathfinder/problems/sales" \
  "$WORK/pathfinder/problems/draft"
printf 'experiment:\n  name: exported\n  output_dir: outputs\n' \
  > "$WORK/exported/configs/default/train.yaml"
printf 'format_version: 2\nname: e2e の売上\nproject:\n  path: %s\n' \
  "$WORK/exported" > "$WORK/pathfinder/problems/sales/problem.yaml"
printf 'format_version: 2\nname: e2e の下書き\n' \
  > "$WORK/pathfinder/problems/draft/problem.yaml"

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

# データの置き場と ML-Pathfinder の置き場も作業用のディレクトリにし,
# 決まったトークンで起動
ML_DASHBOARD_HOME="$WORK/home" ML_DASHBOARD_TOKEN=e2e-token \
  ML_PATHFINDER_HOME="$WORK/pathfinder" exec uv run ml-dashboard --port "$PORT"
