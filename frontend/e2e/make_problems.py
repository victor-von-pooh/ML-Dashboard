"""
画面の通しのテスト用に, ML-Pathfinder の置き場へ ML-Quest で問題の設定を
書くスクリプト (学習で監視する指標と向きを受け取る確かめ用)

使い方: python make_problems.py <置き場の problems> <記録するプロジェクト>
"""
import sys
from pathlib import Path

import ml_quest


def main() -> None:
    """
    記録のある問題の設定, 記録の無い問題の設定, 既製のモデルの問題の設定を
    書く関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 記録したプロジェクトは, 監視する指標を書かない default の config を持つ
    root, project = Path(sys.argv[1]), Path(sys.argv[2])
    sales = ml_quest.example_problem("総菜の作る量")
    sales["name"] = "e2e の売上"
    sales["project"] = {"path": str(project)}
    ml_quest.save_problem(sales, root / "sales")

    # 記録の無いもの (大きいほど良い指標) と, 学習しないもの
    churn = ml_quest.example_problem("解約の引き止め")
    churn = ml_quest.answer(
        churn, f"{ml_quest.PART}.evaluation.metric", "accuracy"
    )
    churn["name"] = "e2e の解約"
    ml_quest.save_problem(churn, root / "churn")
    photo = ml_quest.example_problem("写真の仕分け (既製のモデル)")
    photo["name"] = "e2e の写真"
    ml_quest.save_problem(photo, root / "photo")


if __name__ == "__main__":
    main()
