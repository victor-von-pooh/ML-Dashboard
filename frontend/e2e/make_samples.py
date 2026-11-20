"""
画面の通しのテスト用に, 確かめ用のプロジェクトの実験へ ML-Found の
save_sample で領域と点群の見本を書くスクリプト

使い方: python make_samples.py <確かめ用のプロジェクトのディレクトリ>
"""
import json
import sys
from pathlib import Path

import numpy as np
from ml_found import save_sample

# 見本を書く 2 つの実験 (今の版の一覧と, 新しい版にする一覧)
CURRENT_RUN = "outputs/shapes/2026-11-21/10-00-00"
NEWER_RUN = "outputs/shapes/2026-11-21/11-00-00"

# 点群の正規化の値の決まり (元の座標 = 値 × scale - shift. x は 8 から 12)
CONVENTION = {"units": "m", "scale": 2.0, "shift": [-10.0, 0.0, 0.0]}


def cloud_points() -> np.ndarray:
    """
    正規化した点群 (-1 から 1 の正方形の縁の点) を作る関数

    Parameters
    ----------
    None

    Returns
    ----------
    points: np.ndarray
        (点の数, 3) の座標
    """
    # 4 つの辺に 25 点ずつ
    line = np.linspace(-1.0, 1.0, 25)
    ones = np.ones_like(line)
    zeros = np.zeros_like(line)
    points = np.concatenate([
        np.stack([line, -ones, zeros], axis=1),
        np.stack([line, ones, zeros], axis=1),
        np.stack([-ones, line, zeros], axis=1),
        np.stack([ones, line, zeros], axis=1)
    ])

    return points


def mask_ids() -> np.ndarray:
    """
    背景 (0) の中に 2 つの領域 (1 と 2) を持つ番号の配列を作る関数

    Parameters
    ----------
    None

    Returns
    ----------
    mask: np.ndarray
        (16, 16) の番号
    """
    mask = np.zeros((16, 16), dtype=np.int64)
    mask[2:8, 2:8] = 1
    mask[9:14, 6:15] = 2

    return mask


def main(project: Path) -> None:
    """
    2 つの実験に見本を書き, 片方の一覧を新しい版にする関数

    Parameters
    ----------
    project: Path
        確かめ用のプロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 名前のある領域, 名前の無い領域, 正規化した点群
    current = project / CURRENT_RUN
    save_sample(current, "segment", mask_ids(), epoch=2, kind="mask",
                split="valid", classes={0: "background", 1: "road"})
    save_sample(current, "segment_plain", mask_ids(), kind="mask")
    save_sample(current, "shape", cloud_points(), kind="point_cloud",
                split="valid", convention=CONVENTION)

    # 新しい ML-Found が書いた一覧 (版を上げただけで中身は同じ)
    newer = project / NEWER_RUN
    save_sample(newer, "shape", cloud_points(), kind="point_cloud",
                convention=CONVENTION)
    index = newer / "samples" / "index.json"
    data = json.loads(index.read_text(encoding="utf-8"))
    data["format_version"] = data["format_version"] + 1
    index.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
