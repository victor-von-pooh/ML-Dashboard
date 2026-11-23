"""
画面の通しのテスト用に, 表を作る課題の確かめ用のプロジェクトの実験へ,
ML-Quest の表の生成の骨組みと同じ形の評価と見本を ML-Found の
save_evaluation と save_sample で書くスクリプト

使い方: python make_tables.py <確かめ用のプロジェクトのディレクトリ>
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from ml_found import save_evaluation, save_sample

# 評価と見本を書く実験
RUN = "outputs/table/2026-11-22/10-00-00"

# 見本の行の数 (骨組みと同じ)
SAMPLES = 100

# 骨組みの評価の向きと, 全ての列の平均の行の名前
BETTER = {"distance": "lower", "wasserstein": "lower"}
MEAN_ROW = "(全ての列の平均)"


def make_table(seed: int, rows: int) -> pd.DataFrame:
    """
    数の列 2 つと種類の列 1 つの表を作る関数

    Parameters
    ----------
    seed: int
        乱数の種
    rows: int
        行の数

    Returns
    ----------
    table: pd.DataFrame
        age (整数), income (小数), city (種類) の表
    """
    generator = np.random.default_rng(seed)
    table = pd.DataFrame({
        "age": generator.integers(20, 70, rows),
        "income": np.round(generator.normal(400.0, 80.0, rows), 2),
        "city": generator.choice(["tokyo", "osaka", "nagoya"], rows),
    })

    return table


def distance_rows(split: str) -> list[dict]:
    """
    骨組みの evaluate_split と同じ形の列ごとの近さの行を作る関数

    Parameters
    ----------
    split: str
        分割の名前 (valid か test)

    Returns
    ----------
    rows: list[dict]
        列ごとの column, type, distance, wasserstein, train_distance と,
        最後に全ての列の平均の行
    """
    # テスト用は少しだけ値をずらす
    shift = 0.0 if split == "valid" else 0.02
    rows: list[dict] = [
        {"column": "age", "type": "number", "distance": 0.16 + shift,
         "wasserstein": 0.21 + shift, "train_distance": 0.08},
        {"column": "income", "type": "number", "distance": 0.2 + shift,
         "wasserstein": 0.27 + shift, "train_distance": 0.07},
        {"column": "city", "type": "category", "distance": 0.18 + shift,
         "wasserstein": None, "train_distance": 0.05},
    ]
    mean = float(np.mean([row["distance"] for row in rows]))
    reference = float(np.mean([row["train_distance"] for row in rows]))
    rows.append({"column": MEAN_ROW, "type": None, "distance": mean,
                 "wasserstein": None, "train_distance": reference})

    return rows


def main(project: Path) -> None:
    """
    検証用とテスト用の列ごとの評価と, 作った表と本物の表の見本を書く関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 検証用とテスト用の列ごとの分布の近さ (最良のエポック 2 の重み)
    run = project / RUN
    for split in ("valid", "test"):
        save_evaluation(
            run, f"column_distance_{split}", distance_rows(split), split,
            description="作った表と本物の表の列ごとの分布の近さ",
            epoch=2, better=BETTER
        )

    # 作った表と, 見比べる検証用の本物の表 (どちらも CSV のファイル)
    with tempfile.TemporaryDirectory() as folder:
        generated = Path(folder) / "generated.csv"
        make_table(0, SAMPLES).to_csv(generated, index=False)
        save_sample(run, "generated", generated, kind="file",
                    caption=f"作った表 {SAMPLES} 行 (種 0)")
        real = Path(folder) / "valid_real.csv"
        make_table(1, SAMPLES).to_csv(real, index=False)
        save_sample(run, "valid_real", real, kind="file", split="valid",
                    caption=f"見比べる検証用の本物の表 (先頭 {SAMPLES} 行)")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
