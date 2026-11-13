from pathlib import Path

from ml_dashboard.core.runs import read_lr_steps


def test_read_lr_steps_thins_out(tmp_path: Path) -> None:
    """
    更新ごとの学習率が多い場合に, 等間隔に間引いて最後の点を残すことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    path = tmp_path / "lr_steps.csv"
    rows = "".join(f"{step},1,{step / 100}\n" for step in range(1, 102))
    path.write_text("step,epoch,lr\n" + rows)

    steps = read_lr_steps(path, limit=10)
    numbers = [item.step for item in steps]
    assert numbers[0] == 1 and numbers[-1] == 101
    assert len(steps) <= 11
    assert numbers == sorted(numbers)

    # 上限以下ならそのまま
    assert len(read_lr_steps(path, limit=200)) == 101
