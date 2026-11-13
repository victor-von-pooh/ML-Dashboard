from pathlib import Path

from ml_dashboard.core.runs import read_model_summary


def test_read_model_summary(tmp_path: Path) -> None:
    """
    model_summary.csv を読み, 上限を超える行は数だけ返すことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 無いファイルは None
    path = tmp_path / "model_summary.csv"
    assert read_model_summary(path) == (None, None)

    # ML-Found が書く形の 3 行 (共有した名前とバッファを含む)
    path.write_text(
        "name,kind,module,shape,dtype,numel,requires_grad,same_as\n"
        "0.weight,parameter,Linear,4x3,float32,12,True,\n"
        "2.weight,parameter,Linear,4x3,float32,12,True,0.weight\n"
        "1.num_batches_tracked,buffer,BatchNorm1d,,int64,1,False,\n",
        encoding="utf-8"
    )
    rows, total = read_model_summary(path)
    assert total == 3
    assert rows is not None
    assert rows[0].requires_grad is True
    assert rows[1].same_as == "0.weight"
    assert rows[2].shape == ""
    assert rows[2].requires_grad is False

    # 上限を超える分は返さず, 全体の行数だけ返却
    rows, total = read_model_summary(path, limit=1)
    assert rows is not None and len(rows) == 1
    assert total == 3

    # 列の足りない壊れたファイルは None
    path.write_text("name,kind\nx,parameter\n", encoding="utf-8")
    assert read_model_summary(path) == (None, None)
