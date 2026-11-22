from pathlib import Path

from ml_dashboard.core.models import LogEntry
from ml_dashboard.core.runs import read_history


def test_x_columns_from_history_csv(tmp_path: Path) -> None:
    """
    history.csv の列から, エポックごとに増え続ける step の extra の列だけを
    横軸の候補にすることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # env_steps と samples は増え続ける. beta は途中で同じ値, lr は変わらず,
    # train/steps は指標, gap は値の欠けたエポックがある
    (tmp_path / "history.csv").write_text(
        "epoch,train/loss,env_steps,beta,lr,train/steps,gap,samples\n"
        "1,0.9,200,0.1,0.01,1,1,32\n"
        "2,0.5,450,0.2,0.01,2,,64\n"
        "3,0.3,700,0.2,0.01,3,3,96\n"
    )
    history = read_history(tmp_path, [])
    assert history.x_columns == ["epoch", "env_steps", "samples"]

    # 減る列も対象外
    (tmp_path / "history.csv").write_text(
        "epoch,env_steps,episodes\n1,200,3\n2,450,2\n"
    )
    assert read_history(tmp_path, []).x_columns == ["epoch", "env_steps"]

    # 1 エポックだけでは, 増え続けるか分からないので epoch だけ
    (tmp_path / "history.csv").write_text("epoch,env_steps\n1,200\n")
    assert read_history(tmp_path, []).x_columns == ["epoch"]

    # 記録が 0 件でも epoch は候補 (見出しだけの history.csv)
    (tmp_path / "history.csv").write_text("epoch,train/loss\n")
    assert read_history(tmp_path, []).x_columns == ["epoch"]


def test_x_columns_from_log(tmp_path: Path) -> None:
    """
    history.csv の無い学習中の実験でも, ログのエポックごとの記録から横軸の
    候補を選ぶことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    entries = [
        LogEntry(
            time=None, level="INFO",
            message=f"エポック {epoch}: train/loss={1 / epoch}, "
            f"env_steps={epoch * 100}",
        )
        for epoch in (1, 2)
    ]
    history = read_history(tmp_path, entries)
    assert history.x_columns == ["epoch", "env_steps"]
