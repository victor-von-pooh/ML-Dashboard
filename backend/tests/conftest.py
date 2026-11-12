from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.app import create_app

# ML-Found が書く train.log の例
LOG_TEXT = """\
2026-11-08 22:00:01,255 - ml_found - INFO - 保存先: /tmp/run
2026-11-08 22:00:01,256 - ml_found - INFO - 乱数シード: 42
2026-11-08 22:00:01,256 - ml_found - INFO - OS の情報:

\tOS: Darwin 27.2.0
\tPython Version: 3.13.16

2026-11-08 22:00:01,256 - ml_found - INFO - パッケージ一覧:

\ttorch==2.15.0
\tnumpy==2.3.0

2026-11-08 22:00:01,256 - ml_found - INFO - デバイス: cpu
2026-11-08 22:00:01,637 - ml_found - INFO - パラメータ数: 131
2026-11-08 22:00:01,650 - ml_found - WARNING - 再開時の注意
2026-11-08 22:00:01,897 - ml_found - INFO - Early Stopping (エポック 3)
2026-11-08 22:00:02,185 - ml_found - INFO - 学習完了
2026-11-08 22:00:02,185 - ml_found - INFO - ベストモデルのエポック: 2
2026-11-08 22:00:02,185 - ml_found - INFO - 学習時間: 0.26 秒
"""

HISTORY_TEXT = """\
epoch,train/loss,valid/loss,valid/acc,lr
1,0.9,0.8,0.5,0.01
2,0.5,0.4,0.9,0.01
3,0.3,0.45,0.9,nan
"""


def write_run(
    project_dir: Path, time: str, log: str = LOG_TEXT,
    history: str = HISTORY_TEXT
) -> Path:
    """
    ML-Found の実験のディレクトリを作る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    time: str
        時刻のディレクトリ名
    log: str = LOG_TEXT
        train.log の中身
    history: str = HISTORY_TEXT
        history.csv の中身

    Returns
    ----------
    run_dir: Path
        作った実験のディレクトリ
    """
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / time
    run_dir.mkdir(parents=True)
    (run_dir / "config.yaml").write_text(
        "experiment:\n  name: demo\ntrainer:\n  epochs: 10\n"
        "  monitor: valid/acc\n  mode: max\n"
    )
    (run_dir / "diff.yaml").write_text(
        "trainer.epochs:\n  default: 100\n  experiment: 10\n"
    )
    (run_dir / "history.csv").write_text(history)
    (run_dir / "train.log").write_text(log)
    (run_dir / "loss_curve.png").write_bytes(b"\x89PNG")

    return run_dir


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    """
    実験を 2 つ持つ ML-Found のプロジェクトを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    project: Path
        プロジェクトのディレクトリ
    """
    project = tmp_path / "workspace" / "demo_task"
    (project / "configs" / "default").mkdir(parents=True)
    (project / "configs" / "experiment" / "examples").mkdir(parents=True)
    (project / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
    )
    (project / "configs" / "experiment" / "train.yaml").write_text("{}\n")
    (project / "configs" / "experiment" / "examples" / "a.yaml").write_text(
        "{}\n"
    )
    (project / "train.py").write_text("print('train')\n")
    write_run(project, "10-00-00")
    write_run(project, "11-00-00", log="", history="epoch,train/loss\n")

    return project


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    """
    一時ディレクトリをデータの置き場にしたアプリのクライアントを作る関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    test_client: TestClient
        API を呼ぶクライアント
    """
    test_client = TestClient(create_app(tmp_path / "home"))

    return test_client
