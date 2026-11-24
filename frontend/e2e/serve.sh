#!/usr/bin/env bash
# 画面の通しのテスト (Playwright) 用に, デモのプロジェクトで実験を 2 つ作り,
# 強化学習, 見本, 表を作る課題, 推薦, 群分けの確かめ用のプロジェクトを写してから
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
# 領域と点群の見本の確かめ用のプロジェクト (見本は下で ML-Found の save_sample で書く)
rsync -a fixtures/samples/ "$WORK/samples/"
# 表を作る課題の確かめ用のプロジェクト (評価と見本は下で ML-Found の
# save_evaluation と save_sample で書く)
rsync -a fixtures/tables/ "$WORK/tables/"
# 推薦 (並べる課題) の確かめ用のプロジェクト (評価は下で ML-Found の
# save_evaluation で書く)
rsync -a fixtures/ranking/ "$WORK/ranking/"
# 群分け (まとめる課題) の確かめ用のプロジェクト (評価は下で ML-Found の
# save_evaluation で書く)
rsync -a fixtures/groups/ "$WORK/groups/"

# 書き出したプロジェクトの一覧の確かめ用に, ML-Pathfinder の置き場と, そこに
# 記録した (まだ登録していない) 学習のプロジェクトと, 記録の無い問題の設定.
# 監視する指標を受け取る確かめ用に, どちらのプロジェクトも default の config
# に trainer.monitor を書かない (own は問題の設定に記録の無い骨組みの外のもの).
# ML-Quest の骨組み (make_project) は default に trainer.monitor を書き, 欄が
# 働かないので, default は手で書く
for name in exported own; do
  mkdir -p "$WORK/$name/configs/default" "$WORK/$name/configs/experiment"
  printf 'experiment:\n  name: %s\n  output_dir: outputs\n' "$name" \
    > "$WORK/$name/configs/default/train.yaml"
  printf '{}\n' > "$WORK/$name/configs/experiment/train.yaml"
  printf 'print("train")\n' > "$WORK/$name/train.py"
done
mkdir -p "$WORK/pathfinder/problems/draft"
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

# 領域と点群の見本 (新しい版の一覧の見本も)
uv run python "$WORK/../make_samples.py" "$WORK/samples"

# 表を作る課題の列ごとの分布の近さの評価と, 作った表と本物の表の CSV の見本
uv run python "$WORK/../make_tables.py" "$WORK/tables"

# 推薦の Recall@K と NDCG の, 人気順との差の評価
uv run python "$WORK/../make_ranking.py" "$WORK/ranking"

# 群分けの群の数 3 と 4 の実験の, 群の安定性と群の要約の評価
uv run python "$WORK/../make_groups.py" "$WORK/groups"

# ML-Quest で書く問題の設定 (exported を記録した e2e の売上, 記録の無い
# e2e の解約, 学習しない e2e の写真)
uv run python "$WORK/../make_problems.py" "$WORK/pathfinder/problems" \
  "$WORK/exported"

# データの置き場と ML-Pathfinder の置き場も作業用のディレクトリにし,
# 決まったトークンで起動
ML_DASHBOARD_HOME="$WORK/home" ML_DASHBOARD_TOKEN=e2e-token \
  ML_PATHFINDER_HOME="$WORK/pathfinder" exec uv run ml-dashboard --port "$PORT"
