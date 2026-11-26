"""
画面の通しのテスト用に, 値段を変える判断の確かめ用のプロジェクトの 2 つの実験
(学習率を変えたもの) へ, ML-Quest の値段を変える判断の骨組みと同じ形の評価
(分割ごとの売れた数の予測の誤差, 弾力性, 見込みの利益の比べの表) を ML-Found
の save_evaluation で書くスクリプト

使い方: python make_price.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
from pathlib import Path

from ml_found import save_evaluation

# 骨組みの値段の候補と変える幅の上限 (config の price.candidates と
# price.max_change と同じ値)
CANDIDATES = [-0.1, -0.05, 0, 0.05, 0.1]
MAX_CHANGE = 0.1

# 骨組みの評価の説明 (ML-Quest の EVALUATION_TEXT と同じ形)
TEXT = (
    "{split}の行 ({rows} 行. 商品 {products}) の, 記録の値段での売れた数の"
    "予測の誤差 (mae, rmse. 小さいほど良い) と, 商品ごとの今の値段 (商品"
    "ごとの記録の値段の中央値) で 1 % 上げたときに予測した数が何 % 変わるか"
    "の平均 (elasticity), 値段の候補 {candidates} の中で変える幅の上限 "
    "{max_change} を超えない, 見込みの利益が最も大きい値段を選んだときの見込み"
    "の利益 (商品ごとの 1 行あたりの売れた数の予測から数えた, 1 行あたりの"
    "利益) の和 (profit) と, 今の値段での和 (current_profit), その差 "
    "(profit_gain) と比 (profit_ratio. 大きいほど良い. 今の利益の和が 0 以下"
    "なら空). changed は値段を変える商品の数 ({weights})"
)

# 骨組みの評価の向き
BETTER = {"mae": "lower", "rmse": "lower", "profit_gain": "higher",
          "profit_ratio": "higher"}

# 分割の名前と, 骨組みの評価の説明に入る分割の日本語の名前
SPLITS = {"valid": "検証用", "test": "テスト用"}

# 実験ごとの (評価した重み, エポック, 分割ごとの (行の数, 商品の数, mae,
# rmse, 弾力性の平均, 今の値段での見込みの利益, 見込みの利益の差, 値段を
# 変える商品の数))
RUNS = {
    "outputs/units_price/2026-11-26/11-00-00": (
        "最良のモデル (エポック 3)", 3,
        {"valid": (600, 40, 1.31, 1.78, -1.58, 5203.7, 168.9, 26),
         "test": (600, 40, 1.284, 1.731, -1.62, 5144.2, 176.3, 27)},
    ),
    "outputs/units_price/2026-11-26/11-10-00": (
        "最良のモデル (エポック 2)", 2,
        {"valid": (600, 40, 1.48, 2.01, -1.91, 5203.7, 230.4, 31),
         "test": (600, 40, 1.512, 2.046, -1.97, 5144.2, 241.8, 33)},
    ),
}


def main(project: Path) -> None:
    """
    実験ごとに値段を変える判断の評価を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    for run, (weights, epoch, splits) in RUNS.items():
        for split, values in splits.items():
            rows, products, mae, rmse, elasticity, current, gain, changed = (
                values
            )
            save_evaluation(
                project / run, f"price_{split}",
                {"rows": rows, "products": products, "mae": mae,
                 "rmse": rmse, "elasticity": elasticity,
                 "elasticity_counted": products,
                 "profit": round(current + gain, 4),
                 "current_profit": current, "profit_gain": gain,
                 "profit_ratio": round((current + gain) / current, 6),
                 "changed": changed, "max_change": MAX_CHANGE},
                split,
                description=TEXT.format(
                    split=SPLITS[split], rows=rows, products=products,
                    candidates=CANDIDATES, max_change=MAX_CHANGE,
                    weights=weights
                ),
                epoch=epoch, better=BETTER
            )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
