import subprocess
import sys
from pathlib import Path

# 新しい Python で, 複数のスレッドから ML-Found の違うモジュールを同時に
# 初めて読み込む (import_ml_found を先に呼ぶ, ダッシュボードの API と同じ形)
CHILD = """
import sys, threading
from ml_dashboard.core.loader import import_ml_found
assert "ml_found" not in sys.modules
targets = [
    "ml_found.experiment.setup", "ml_found.training.registry",
    "ml_found.config", "ml_found.training.optim",
] * 2
barrier = threading.Barrier(len(targets))
errors = []
def work(name):
    barrier.wait()
    try:
        import_ml_found()
        __import__(name)
    except Exception as error:
        errors.append(f"{name}: {type(error).__name__}: {error}")
threads = [threading.Thread(target=work, args=(n,)) for n in targets]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(120)
print("ERR " + " | ".join(errors) if errors else "OK")
"""


def test_concurrent_first_import() -> None:
    """
    同時の要求で ML-Found を初めて読み込んでも止まらないことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # ロックが無い場合はほぼ毎回 _DeadlockError になる状況を 3 回試行
    for _ in range(3):
        result = subprocess.run(
            [sys.executable, "-c", CHILD], capture_output=True, text=True,
            timeout=300
        )
        assert result.stdout.strip().splitlines()[-1:] == ["OK"], (
            result.stdout + result.stderr
        )


def test_startup_does_not_import_torch(tmp_path: Path) -> None:
    """
    アプリを作るだけでは ML-Found と PyTorch を読み込まないことを確かめる
    関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 方策の見積もりなど ML-Found を使う API も, 初めて使うときに読み込む
    code = (
        "import sys; from pathlib import Path; "
        "from ml_dashboard.app import create_app; "
        f"create_app(Path({str(tmp_path)!r}), token='t'); "
        "print('torch' in sys.modules, 'ml_found' in sys.modules)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True,
        timeout=120
    )
    assert result.stdout.strip().splitlines()[-1:] == ["False False"], (
        result.stdout + result.stderr
    )
