"""
画面の通しのテスト用に, 効果を見積もるの確かめ用のプロジェクトの 2 つの実験
(学習率を変えたもの) へ, ML-Quest の効果の見積もりの骨組みと同じ形の評価
(分割ごとの Qini の係数と上位 K 割の効果の差の表, Qini の曲線) を ML-Found
の save_evaluation で書くスクリプト

使い方: python make_uplift.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
from pathlib import Path

from ml_found import save_evaluation

# 骨組みの上位の割合 K と配る数の上限 (config の uplift.k と uplift.budget と
# 同じ値)
K = 0.3
BUDGET = 500

# 骨組みの結果の種類の名前 (ML-Quest の OUTCOME_NAMES の binary)
OUTCOME = "起きたか (買ったかの 0 と 1. 効果は確率の差)"

# 骨組みの評価の向き
BETTER = {"qini": "higher", "uplift_at_k": "higher"}

# 分割の名前と, 骨組みの評価の説明に入る分割の日本語の名前
SPLITS = {"valid": "検証用", "test": "テスト用"}

# 曲線の点の数 (骨組みは 101 を目安に間引く. ここは確かめ用の少ない点数)
POINTS = 21

# 実験ごとの (評価した重み, エポック, 分割ごとの (行の数, 処置の群の行の数,
# Qini の係数, 上位 K 割の効果の差, 分割の全ての行の結果の平均の差,
# 効果の見積もりの平均, 全ての行での Qini の値))
RUNS = {
    "outputs/purchased_uplift/2026-11-25/11-00-00": (
        "最良のモデル (エポック 3)", 3,
        {"valid": (400, 200, 0.1947, 0.118, 0.052, 0.049, 20.8),
         "test": (400, 201, 0.2103, 0.124, 0.048, 0.051, 19.3)},
    ),
    "outputs/purchased_uplift/2026-11-25/11-10-00": (
        "最良のモデル (エポック 2)", 2,
        {"valid": (400, 200, 0.1611, 0.097, 0.052, 0.061, 20.8),
         "test": (400, 201, 0.1534, 0.089, 0.048, 0.058, 19.3)},
    ),
}


def curve_rows(rows: int, qini: float, end: float) -> dict[str, list]:
    """
    ML-Found の qini_curve と同じ列 (rows, fraction, qini, random) の曲線を
    作る関数

    Parameters
    ----------
    rows: int
        分割の行の数
    qini: float
        Qini の係数 (でたらめに配る線から上への膨らみの大きさに使う)
    end: float
        全ての行での Qini の値

    Returns
    ----------
    curve: dict[str, list]
        先頭は 0 行で, 上位の行の割合の等しい刻みの点
    """
    fractions = [step / (POINTS - 1) for step in range(POINTS)]
    curve = {
        "rows": [round(rows * f) for f in fractions],
        "fraction": fractions,
        "qini": [round(end * f + 4 * qini * end * f * (1 - f), 4)
                 for f in fractions],
        "random": [round(end * f, 4) for f in fractions],
    }

    return curve


def main(project: Path) -> None:
    """
    実験ごとに効果を見積もるの評価を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 説明の文は骨組みの説明と同じ形
    for run, (weights, epoch, splits) in RUNS.items():
        for split, values in splits.items():
            rows, treated, qini, lift, effect, estimated, end = values
            title = SPLITS[split]
            save_evaluation(
                project / run, f"uplift_{split}",
                {"rows": rows, "treated": treated,
                 "control": rows - treated, "k": K, "qini": qini,
                 "uplift_at_k": lift, "effect": effect,
                 "estimated": estimated},
                split,
                description=(
                    f"{title}の行 ({rows} 行. 処置の群 {treated} 行, 対照の"
                    f"群 {rows - treated} 行) の効果の見積もり ({OUTCOME}) "
                    f"の, Qini の係数 qini と上位 {K * 100:g} % (K = {K}) の"
                    "処置の群と対照の群の結果の平均の差 uplift_at_k ("
                    f"{weights}). 大きいほど良い. effect は分割の全ての行の"
                    "結果の平均の差 (無作為に配った場合), estimated は見積もり"
                    f"の平均. 配る数の上限は {BUDGET}"
                ),
                epoch=epoch, better=BETTER
            )
            save_evaluation(
                project / run, f"qini_curve_{split}",
                curve_rows(rows, qini, end), split,
                description=(
                    f"{title}の行の Qini の曲線 (fraction は効果の見積もりの"
                    "高い順の上位の行の割合, qini は処置で増えた結果 (対照の"
                    "群の数を処置の群に合わせた結果の和の差), random は無作為"
                    f"に配った場合の直線. {weights})"
                ),
                kind="curve", x="fraction", epoch=epoch
            )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
