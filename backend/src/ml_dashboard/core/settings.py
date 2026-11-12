import os
from pathlib import Path

# ダッシュボードのデータの置き場を変える環境変数
HOME_ENV = "ML_DASHBOARD_HOME"


def get_data_dir() -> Path:
    """
    ダッシュボード自身のデータを置くディレクトリを取得する関数

    Parameters
    ----------
    None

    Returns
    ----------
    data_dir: Path
        登録したプロジェクトやジョブの記録を置くディレクトリ
    """
    # 環境変数があればそれを使い, 無ければホームディレクトリの下に設定
    value = os.environ.get(HOME_ENV)
    if value:
        data_dir = Path(value).expanduser().resolve()
    else:
        data_dir = Path.home() / ".ml-dashboard"

    # 無ければ作成
    data_dir.mkdir(parents=True, exist_ok=True)

    return data_dir
