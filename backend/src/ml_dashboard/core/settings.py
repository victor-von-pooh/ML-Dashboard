import os
from pathlib import Path

# ダッシュボードのデータの置き場を変える環境変数
HOME_ENV = "ML_DASHBOARD_HOME"

# ML-Pathfinder の置き場を変える環境変数 (ML-Pathfinder と同じ名前)
PATHFINDER_HOME_ENV = "ML_PATHFINDER_HOME"


def get_data_dir() -> Path:
    """
    ダッシュボード自身のデータを置くディレクトリを取得する関数

    Parameters
    ----------
    None

    Returns
    ----------
    data_dir: Path
        登録したプロジェクトやジョブの記録を置く場所, 書き込むときに作成
    """
    # 環境変数があればそれを使い, 無ければホームディレクトリの下に設定
    value = os.environ.get(HOME_ENV)
    if value:
        data_dir = Path(value).expanduser().resolve()
    else:
        data_dir = Path.home() / ".ml-dashboard"

    return data_dir


def get_problems_dir() -> Path:
    """
    ML-Pathfinder が問題の設定を保存するディレクトリを取得する関数

    Parameters
    ----------
    None

    Returns
    ----------
    problems_dir: Path
        ML-Pathfinder の置き場の problems (無いこともある)
    """
    # ML-Pathfinder と同じ決め方 (環境変数か, ホームの下)
    value = os.environ.get(PATHFINDER_HOME_ENV)
    if value:
        home = Path(value).expanduser().resolve()
    else:
        home = Path.home() / ".ml-pathfinder"
    problems_dir = home / "problems"

    return problems_dir
