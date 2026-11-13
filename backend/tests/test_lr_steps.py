import math
from pathlib import Path

from ml_dashboard.core.runs import read_lr_steps, thin_indices


def write_steps(path: Path, rows: list[tuple[int, int, float]]) -> None:
    """
    lr_steps.csv を書く関数

    Parameters
    ----------
    path: Path
        書き出す先
    rows: list[tuple[int, int, float]]
        更新ごとの番号, エポック, 学習率

    Returns
    ----------
    None
    """
    lines = "".join(f"{step},{epoch},{lr}\n" for step, epoch, lr in rows)
    path.write_text("\ufeffstep,epoch,lr\n" + lines, encoding="utf-8")


def test_positions_follow_epochs(tmp_path: Path) -> None:
    """
    エポックごとの記録の数で位置を決め, エポックが飛んでもずれないことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # エポック 1 は 4 回, 2 は記録無し (エポックごとに変えて再開), 3 は 2 回
    path = tmp_path / "lr_steps.csv"
    write_steps(path, [
        (1, 1, 0.1), (2, 1, 0.2), (3, 1, 0.3), (4, 1, 0.4),
        (9, 3, 0.5), (10, 3, 0.6)
    ])
    points = read_lr_steps(path)
    assert [point.x for point in points] == [1, 1.25, 1.5, 1.75, 3, 3.5]
    assert [point.lr for point in points] == [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]

    # 見出しに必要な列が無い場合は空
    (tmp_path / "broken.csv").write_text("a,b\n1,2\n")
    assert read_lr_steps(tmp_path / "broken.csv") == []


def test_thinning_keeps_peaks(tmp_path: Path) -> None:
    """
    間引いても上限を超えず, 最初と最後と短い周期の山と谷を残すことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 周期 7 の三角波 (間引きの間隔と合わない周期)
    values = [float(step % 7) for step in range(10_001)]
    indices = thin_indices(values, 100)
    assert len(indices) <= 100
    assert indices[0] == 0 and indices[-1] == 10_000
    assert indices == sorted(set(indices))
    kept = [values[index] for index in indices]
    assert min(kept) == 0.0 and max(kept) == 6.0

    # NaN だけの区間でも点を残し, 上限以下ならそのまま
    assert thin_indices([math.nan] * 10, 4) != []
    assert thin_indices([1.0, 2.0], 10) == [0, 1]

    # ファイルからも上限まで間引き, 同じファイルは再利用
    path = tmp_path / "lr_steps.csv"
    write_steps(path, [(step, 1 + step // 100, 0.1) for step in range(1000)])
    points = read_lr_steps(path, limit=50)
    assert len(points) <= 50
    assert read_lr_steps(path, limit=50) is points
