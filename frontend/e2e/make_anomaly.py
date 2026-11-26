"""
画面の通しのテスト用に, 異常の検知の確かめ用のプロジェクトの 3 つの実験
(自己符号化器と, 学習するパラメータの無い距離に基づく度合いの 2 つの形.
ML-Found の fit で残した形と, run.json と history.csv の無い形) へ, ML-Quest の異常の検知の
骨組みと同じ形の評価 (異常の行のある分割の上位 K 件の適合率と PR-AUC,
異常の正解の無い分割の度合いの分布と上位の行の要約) を ML-Found の
save_evaluation で書くスクリプト

使い方: python make_anomaly.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
from pathlib import Path

from ml_found import save_evaluation

# 骨組みの K と人が 1 回に確かめる件数の上限 (config の anomaly.k と
# anomaly.capacity と同じ値)
K = 10
CAPACITY = 20

# 骨組みの評価の向き
BETTER = {"precision_at_k": "higher", "average_precision": "higher"}

# 分割の名前と, 骨組みの評価の説明に入る分割の日本語の名前
SPLITS = {"valid": "検証用", "test": "テスト用"}
UNLABELED = ("unlabeled", "正解の欠けた")

# 実験ごとの (度合いの決め方, 評価した重み, エポック, 分割ごとの (行の数,
# 異常の行の数, 上位 K 件の適合率, PR-AUC), 正解の欠けた行の度合いの最も
# 大きい値). run.json の無い形の距離に基づく度合いは, エポックが無い
RUNS = {
    "outputs/anomaly_autoencoder/2026-11-25/10-00-00": (
        "自己符号化器の再構成の誤差", "最良のモデル (エポック 3)", 3,
        {"valid": (200, 8, 0.8, 0.8125), "test": (200, 9, 0.6, 0.6640)},
        4.8,
    ),
    "outputs/anomaly_distance/2026-11-25/10-10-00": (
        "学習用の正常の行の中心からの距離", "学習用の正常の行の中心と精度行列",
        None,
        {"valid": (200, 8, 0.7, 0.7302), "test": (200, 9, 0.7, 0.7410)},
        6.2,
    ),
    "outputs/anomaly_distance/2026-11-25/10-20-00": (
        "学習用の正常の行の中心からの距離",
        "学習用の正常の行の中心と精度行列 (最良のモデル, エポック 1)", 1,
        {"valid": (200, 8, 0.7, 0.7302), "test": (200, 9, 0.7, 0.7410)},
        6.2,
    ),
}

# 上位の行の要約の, 行の id の列と最も外れた列の候補
ID_COLUMN = "sensor_id"
FEATURES = ("temperature", "pressure", "vibration")


def distribution_rows(top: float) -> list[dict]:
    """
    骨組みの度合いの分布と同じ形の行 (0 から 1 の 0.05 刻みの分位点) を作る
    関数

    Parameters
    ----------
    top: float
        度合いの最も大きい値

    Returns
    ----------
    rows: list[dict]
        quantile と score の行 (上の分位ほど急に大きくなる)
    """
    rows = [{"quantile": round(step * 0.05, 2),
             "score": round(0.2 + (step * 0.05) ** 6 * (top - 0.2), 4)}
            for step in range(21)]

    return rows


def top_rows(top: float) -> list[dict]:
    """
    骨組みの上位の行の要約と同じ形の K 行を作る関数

    Parameters
    ----------
    top: float
        度合いの最も大きい値

    Returns
    ----------
    rows: list[dict]
        rank, 行の id, score, column, column_share
    """
    rows = [{"rank": rank, ID_COLUMN: f"s-{100 + rank * 7}",
             "score": round(top * 0.9 ** (rank - 1), 4),
             "column": FEATURES[rank % len(FEATURES)],
             "column_share": round(0.92 - rank * 0.04, 2)}
            for rank in range(1, K + 1)]

    return rows


def main(project: Path) -> None:
    """
    実験ごとに異常の検知の評価を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 説明の文は骨組みの説明と同じ形
    for run, (score, weights, epoch, splits, top) in RUNS.items():
        for split, (rows, anomalies, precision, ap) in splits.items():
            save_evaluation(
                project / run, f"anomaly_{split}",
                {"rows": rows, "anomalies": anomalies, "k": K,
                 "precision_at_k": precision, "average_precision": ap},
                split,
                description=(
                    f"{SPLITS[split]}の行 ({rows} 行, 異常 {anomalies} 行) "
                    f"の度合い ({score}) の, 上位 K 件 (K = {K}. 人が 1 回に"
                    f"確かめる件数の上限は {CAPACITY}) の適合率 "
                    f"precision_at_k と PR-AUC average_precision "
                    f"({weights}). 大きいほど良い. 異常の割合が小さいと上位 "
                    "K 件の適合率は低く出る"
                ),
                epoch=epoch, better=BETTER
            )
        split, title = UNLABELED
        save_evaluation(
            project / run, f"anomaly_scores_{split}", distribution_rows(top),
            split,
            description=(
                f"{title}の行 (300 行. 異常の正解が無い) の度合い ({score}) "
                f"の分布 (quantile の分位点の度合い score. {weights})"
            ),
            kind="curve", x="quantile", epoch=epoch
        )
        save_evaluation(
            project / run, f"anomaly_top_{split}", top_rows(top), split,
            description=(
                f"{title}の行 (異常の正解が無い) の, 度合い ({score}) の高い"
                f"順の上位 {K} 行 (人が 1 回に確かめる件数の上限は "
                f"{CAPACITY}). column は度合いのうち最も大きい分の列, "
                f"column_share はその割合 ({weights})"
            ),
            epoch=epoch
        )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
