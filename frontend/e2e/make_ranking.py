"""
画面の通しのテスト用に, 推薦の確かめ用のプロジェクトの実験へ, ML-Quest の
並べるの骨組みと同じ形の評価 (人気順との差) を ML-Found の save_evaluation
で書くスクリプト

使い方: python make_ranking.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
from pathlib import Path

from ml_found import save_evaluation

# 評価を書く実験
RUN = "outputs/ranking/2026-11-24/10-00-00"

# 骨組みの比べる相手の名前と, 指標の列 (どれも大きいほど良い)
BASELINE = "人気順 (学習用の反応の多い順)"
METRICS = ("recall_at_k", "ndcg")

# 分割ごとの利用者の数, モデルの値と人気順の値 (検証用の NDCG だけ人気順
# より悪い)
SPLITS = {
    "valid": (31, {"recall_at_k": (0.5161, 0.3548), "ndcg": (0.17, 0.18)}),
    "test": (27, {"recall_at_k": (0.5679, 0.4383), "ndcg": (0.4465, 0.2009)}),
}


def ranking_row(users: int, values: dict) -> dict:
    """
    骨組みの評価と同じ形の 1 行を作る関数

    Parameters
    ----------
    users: int
        数えた利用者の数
    values: dict
        指標の名前から (モデルの値, 人気順の値)

    Returns
    ----------
    row: dict
        users, k と, 指標ごとの値, _baseline, _diff (モデル − 人気順)
    """
    row: dict = {"users": users, "k": 10}
    for metric in METRICS:
        model, baseline = values[metric]
        row[metric] = model
        row[f"{metric}_baseline"] = baseline
        row[f"{metric}_diff"] = model - baseline

    return row


def main(project: Path) -> None:
    """
    検証用とテスト用の Recall@K と NDCG の評価を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 向きは指標と同じ指標の _baseline と _diff の列に広がる
    run = project / RUN
    better = {metric: "higher" for metric in METRICS}
    for split, (users, values) in SPLITS.items():
        save_evaluation(
            run, f"ranking_{split}", [ranking_row(users, values)], split,
            description=f"{split} の反応で数えた上位 10 件の Recall@K と NDCG",
            epoch=3, baseline=BASELINE, better=better
        )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
