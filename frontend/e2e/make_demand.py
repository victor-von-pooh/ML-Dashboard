"""
画面の通しのテスト用に, 時間をまたぐ量の判断の確かめ用のプロジェクトの 2 つの
実験 (学習率を変えたもの) へ, ML-Quest の時間をまたぐ量の判断の骨組みと同じ形の
評価 (分割ごとの需要の誤差と発注の数の損の比べの表と, 水準ごとの分位点の損失の
表) を ML-Found の save_evaluation で書き, 商品ごとの発注の数の表
(demand_orders.csv) を書くスクリプト

使い方: python make_demand.py <確かめ用のプロジェクトのディレクトリ>
"""
import csv
import sys
from pathlib import Path

from ml_found import save_evaluation

# 骨組みの学ぶ水準, 発注に使う水準 τ (4 / (4 + 1)), 発注の数の上限 (config の
# demand.levels, order と同じ値)
LEVELS = [0.1, 0.5, 0.8, 0.9]
TAU = 0.8
MAX_ORDER = 60.0

# 骨組みの評価の説明 (ML-Quest の EVALUATION_TEXT と LEVELS_TEXT と同じ形)
TEXT = (
    "{split}の発注を決める日の行 ({rows} 行. 商品 {products}) の, 先の 7 日"
    "の需要の 0.5 の分位点の平均絶対誤差 (mae), 学んだ水準 {levels} の分位点"
    "の損失の平均 (pinball_loss) と, 水準 τ = {level} の分位点から在庫の数を"
    "引き, 0 から上限 {max_order} の間の整数にした発注の数での実際の損の和 "
    "(order_cost. 品切れの損 4 × 足りない数 + 売れ残りの損 1 × 余った数. "
    "売れる数は在庫の数 + 発注の数) と, 前の期間と同じ数を発注したときの損の"
    "和 (baseline_cost), その差 (order_cost_saving. 大きいほど良い) と比 "
    "(order_cost_ratio. 小さいほど良い. 前の期間の損が 0 なら空). capped は"
    "上限で切った行の数 ({weights})"
)
LEVELS_TEXT = ("{split}の発注を決める日の行の, 学んだ水準ごとの分位点の損失 "
               "(小さいほど良い. {weights})")

# 骨組みの評価の向き
BETTER = {"mae": "lower", "pinball_loss": "lower", "order_cost": "lower",
          "baseline_cost": "lower", "order_cost_saving": "higher",
          "order_cost_ratio": "lower"}

# 分割の名前と, 骨組みの評価の説明に入る分割の日本語の名前
SPLITS = {"valid": "検証用", "test": "テスト用"}

# 実験ごとの (評価した重み, エポック, 分割ごとの (行の数, 商品の数, mae,
# 水準ごとの分位点の損失, 選んだ発注の数での損, 前の期間と同じ数の発注での
# 損, 上限で切った行の数))
RUNS = {
    "outputs/weekly_demand/2026-11-26/09-00-00": (
        "最良のモデル", 3,
        {"valid": (480, 24, 3.38, [0.82, 1.69, 1.47, 1.34], 934.0, 1201.0, 2),
         "test": (480, 24, 3.421, [0.79, 1.72, 1.43, 1.31], 912.5, 1188.0,
                  3)},
    ),
    "outputs/weekly_demand/2026-11-26/09-10-00": (
        "最良のモデル", 2,
        {"valid": (480, 24, 4.02, [1.04, 2.05, 1.72, 1.63], 1041.0, 1201.0, 5),
         "test": (480, 24, 4.087, [1.07, 2.11, 1.76, 1.66], 1019.0, 1188.0,
                  6)},
    ),
}

# 商品ごとの発注の数の表の行 (ML-Inference の需要の一式の実験の成果物の列.
# 商品の id の列は item, 日付の列は date)
ORDERS = [
    ("item", "date", "split", "stock", "quantile", "order", "previous",
     "demand"),
    ("A", "2026-03-01", "test", 2, 13.6, 12, 11, 14),
    ("B", "2026-03-01", "test", 0, 71.3, 60, 58, 66),
    ("C", "2026-03-01", "test", 5, 7.2, 2, 6, ""),
]


def main(project: Path) -> None:
    """
    実験ごとに時間をまたぐ量の判断の評価と発注の数の表を書く関数

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
            rows, products, mae, losses, cost, baseline, capped = values
            names = {"split": SPLITS[split], "rows": rows,
                     "products": products, "levels": LEVELS, "level": TAU,
                     "max_order": MAX_ORDER, "weights": weights}
            save_evaluation(
                project / run, f"demand_{split}",
                {"rows": rows, "products": products, "mae": mae,
                 "pinball_loss": round(sum(losses) / len(losses), 6),
                 "order_cost": cost, "baseline_cost": baseline,
                 "order_cost_saving": round(baseline - cost, 6),
                 "order_cost_ratio": round(cost / baseline, 6),
                 "capped": capped, "level": TAU, "max_order": MAX_ORDER},
                split, description=TEXT.format(**names), epoch=epoch,
                better=BETTER
            )
            save_evaluation(
                project / run, f"demand_levels_{split}",
                {"level": LEVELS, "loss": losses}, split,
                description=LEVELS_TEXT.format(**names), epoch=epoch,
                better={"loss": "lower"}
            )
        with open(project / run / "demand_orders.csv", "w",
                  newline="") as file:
            csv.writer(file).writerows(ORDERS)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
