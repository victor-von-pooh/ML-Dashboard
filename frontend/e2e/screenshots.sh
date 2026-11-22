#!/usr/bin/env bash
# README と操作ガイドの画面の図 (docs/images の README の 7 枚と,
# docs/images/guide/runs.jpg) を撮り直す. make demo と同じ 4 つの実験と,
# 画面の通しのテストの強化学習の実験を作業用のディレクトリに置き,
# ダッシュボードを起動して e2e/screenshots.ts で撮る. 画面は pnpm build で作っておく
set -euo pipefail

cd "$(dirname "$0")"
# 画面の通しのテスト (e2e/.work) と同時に動かしても消し合わない場所
WORK="$PWD/.work-shots"
PORT="${SHOTS_PORT:-8792}"
URL="http://127.0.0.1:$PORT"

# 他のものが待ち受けているポートでは起動しない (別のものを撮らないため)
if curl -s -o /dev/null "$URL"; then
  echo "ポート $PORT は使われています. SHOTS_PORT=... で変えてください" >&2
  exit 1
fi

# 前回の結果を消し, デモのプロジェクトを作業用のディレクトリに写す
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --exclude outputs ../../demo/ "$WORK/demo/"
# 方策と追加の依存の図に使う強化学習の実験 (学習せずに置いたもの)
rsync -a fixtures/rl/ "$WORK/rl/"

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

# データの置き場も作業用のディレクトリにして起動する. uv run を挟むと止めても
# 中の Python が残りうるので, 環境の ml-dashboard を直に起動する
ML_DASHBOARD_HOME="$WORK/home" ML_DASHBOARD_TOKEN=shots-token \
  .venv/bin/ml-dashboard --port "$PORT" > "$WORK/server.log" 2>&1 &
SERVER=$!
stop() {
  kill "$SERVER" 2> /dev/null || true
  wait "$SERVER" 2> /dev/null || true
}
trap stop EXIT

# 起動を待つ. 途中で止まるか, 待ちきれなければログを出して止める
ready=0
for _ in $(seq 60); do
  if ! kill -0 "$SERVER" 2> /dev/null; then
    break
  fi
  if curl -sf -H 'x-dashboard-token: shots-token' "$URL/api/projects" > /dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  cat "$WORK/server.log"
  exit 1
fi

cd ../frontend
SHOTS_URL="$URL" SHOTS_TOKEN=shots-token SHOTS_DEMO="$WORK/demo" \
  SHOTS_RL="$WORK/rl" node e2e/screenshots.ts

# 止めた後にポートが空いたことを確かめる
stop
trap - EXIT
if curl -s -o /dev/null "$URL"; then
  echo "ダッシュボードが止まっていません (ポート $PORT)" >&2
  exit 1
fi
