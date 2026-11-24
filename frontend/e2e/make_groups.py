"""
画面の通しのテスト用に, 群分けの確かめ用のプロジェクトの 2 つの実験 (群の数
3 と 4) へ, ML-Quest の群分けの骨組みと同じ形の群の安定性 (列の特徴をそのまま
分けた群との差) と群の要約を ML-Found の save_evaluation で書くスクリプト

使い方: python make_groups.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
from pathlib import Path

from ml_found import save_evaluation

# 骨組みの比べる相手の名前と, 指標の列 (どれも大きいほど良い)
BASELINE = "列の特徴をそのまま k-means で分けた群"
METRICS = ("ari", "ari_min", "silhouette")

# 実験ごとの群の数, 指標ごとの (モデルの値, そのままの値) と, 群ごとの
# (行の数, 安定性, 使う額の平均, 来た回数の平均, 最も多い地域). 群の数 3 の
# シルエット係数だけがそのままより悪い
RUNS = {
    "outputs/group_3/2026-11-24/10-00-00": (
        3,
        {"ari": (1.0, 1.0), "ari_min": (1.0, 1.0),
         "silhouette": (0.7102, 0.7206)},
        [(80, 1.0, 3006.9, 12.93, "east (100 %)"),
         (80, 1.0, 1000.4, 2.14, "north (100 %)"),
         (80, 1.0, 1991.9, 8.21, "south (100 %)")],
    ),
    "outputs/group_3/2026-11-24/10-10-00": (
        4,
        {"ari": (0.9, 0.9442), "ari_min": (0.8, 0.9442),
         "silhouette": (0.6652, 0.6679)},
        [(45, 0.82, 1991.3, 10.31, "south (100 %)"),
         (80, 1.0, 1000.4, 2.14, "north (100 %)"),
         (80, 1.0, 3006.9, 12.93, "east (100 %)"),
         (35, 0.74, 1992.6, 5.51, "south (100 %)")],
    ),
}


def stability_row(k: int, values: dict) -> dict:
    """
    骨組みの群の安定性と同じ形の 1 行を作る関数

    Parameters
    ----------
    k: int
        群の数
    values: dict
        指標の名前から (モデルの値, そのままの値)

    Returns
    ----------
    row: dict
        k, method, repeats と, 指標ごとの値, _baseline, _diff (モデル −
        そのまま)
    """
    row: dict = {"k": k, "method": "seed", "repeats": 3}
    for metric in METRICS:
        model, baseline = values[metric]
        row[metric] = model
        row[f"{metric}_baseline"] = baseline
        row[f"{metric}_diff"] = model - baseline

    return row


def summary_rows(groups: list) -> list[dict]:
    """
    骨組みの群の要約と同じ形の行 (群ごとと, 最後に全体) を作る関数

    Parameters
    ----------
    groups: list
        群ごとの (行の数, 安定性, 使う額の平均, 来た回数の平均, 最も多い
        地域)

    Returns
    ----------
    rows: list[dict]
        group, rows, share, stability と群を作った列の要約
    """
    total = sum(group[0] for group in groups)
    rows = [
        {"group": number, "rows": count, "share": count / total,
         "stability": stability, "spend": spend, "visits": visits,
         "region": region}
        for number, (count, stability, spend, visits, region)
        in enumerate(groups)
    ]
    rows.append({"group": "全体", "rows": total, "share": 1.0,
                 "stability": None, "spend": 2003.9, "visits": 7.76,
                 "region": "south (33 %)"})

    return rows


def main(project: Path) -> None:
    """
    実験ごとに群の安定性と群の要約を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 向きは指標と同じ指標の _baseline と _diff の列に広がる
    better = {metric: "higher" for metric in METRICS}
    for run, (k, values, groups) in RUNS.items():
        save_evaluation(
            project / run, "group_stability", [stability_row(k, values)],
            "all",
            description="全ての行の群と, 学習用の行で作り直した群の一致と, "
            "全ての行のシルエット係数",
            epoch=3, baseline=BASELINE, better=better
        )
        save_evaluation(
            project / run, "group_summary", summary_rows(groups), "all",
            description="群ごとの行の数, 割合, 作り直したときの群の一致と, "
            "群を作った列の要約 (最後の行は全ての行)",
            epoch=3, better={"stability": "higher"}
        )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
