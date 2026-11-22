import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_jobs import FAKE_TRAIN, wait_for

from ml_dashboard.core import logs, run_files, runs
from ml_dashboard.core.jobs import output_tail
from ml_dashboard.core.logs import parse_log
from ml_dashboard.core.runs import (
    cached_log,
    load_yaml,
    lr_step_columns,
    read_history,
    read_json,
    read_lr_steps,
    read_model_summary,
    read_progress,
)

from test_api import register

# 実験の外に置く, 読まれても書き換えられてもいけない中身
OUTSIDE = {
    "run.json": json.dumps({"status": "completed", "seed": 7}),
    "progress.json": json.dumps({
        "phase": "train", "epoch": 1, "total_epochs": 2, "batch": 1,
        "total_batches": 2, "elapsed_sec": 1.0,
        "updated_at": "2026-11-08T10:00:00+09:00"
    }),
    "model_summary.csv": (
        "name,kind,module,shape,dtype,numel,requires_grad\n"
        "secret,parameter,m,[1],float32,1,True\n"
    ),
    "history.csv": "epoch,secret\n1,0.5\n",
    "lr_steps.csv": "step,epoch,lr,lr_secret\n0,1,0.1,0.2\n",
    "config.yaml": "secret: 1\n",
    "source.yaml": "secret: 1\n",
    "diff.yaml": "secret: 1\n",
    "train.log": "secret line\n",
    "output.log": "secret line\n",
}


def read_any(name: str, path: Path) -> Any:
    """
    実験のディレクトリのファイルを, 画面と同じ関数で読む関数

    Parameters
    ----------
    name: str
        ファイルの名前
    path: Path
        ファイルのパス

    Returns
    ----------
    result: Any
        読んだ結果 (読まなかった場合は空のもの)
    """
    readers: dict[str, Callable[[], Any]] = {
        "run.json": lambda: read_json(path),
        "progress.json": lambda: read_progress(path.parent),
        "model_summary.csv": lambda: read_model_summary(path)[0],
        "history.csv": lambda: read_history(path.parent, []).columns,
        "lr_steps.csv": lambda: (
            read_lr_steps(path), lr_step_columns(path)
        ),
        "config.yaml": lambda: load_yaml(path),
        "source.yaml": lambda: load_yaml(path),
        "diff.yaml": lambda: load_yaml(path),
        "train.log": lambda: (
            parse_log(path), cached_log(path, logs.DEFAULT_FORMAT)
        ),
        "output.log": lambda: output_tail(path),
    }
    result = readers[name]()

    return result


def is_empty(result: Any) -> bool:
    """
    読んだ結果が空 (読まなかった) かを判定する関数

    Parameters
    ----------
    result: Any
        read_any の結果

    Returns
    ----------
    empty: bool
        中身が無いか
    """
    if isinstance(result, tuple):
        return all(is_empty(item) for item in result)
    empty = not result

    return empty


@pytest.mark.parametrize("name", list(OUTSIDE))
def test_links_and_fifos_are_not_read(tmp_path: Path, name: str) -> None:
    """
    実験のファイルのリンクは外の中身を返さず, FIFO で止まらないことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    name: str
        確かめるファイルの名前

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    outside = tmp_path / "outside" / name
    outside.parent.mkdir()
    outside.write_text(OUTSIDE[name], encoding="utf-8")
    path = run_dir / name

    # 普通のファイルなら読める (確かめの中身が正しいこと)
    path.write_text(OUTSIDE[name], encoding="utf-8")
    assert not is_empty(read_any(name, path))
    runs.SUMMARY_CACHE.clear()
    runs.LR_CACHE.clear()
    runs.LOG_CACHE.clear()

    # リンクは外の中身を返さない
    path.unlink()
    path.symlink_to(outside)
    assert is_empty(read_any(name, path))

    # FIFO は開いても待たずに読まない
    path.unlink()
    os.mkfifo(path)
    assert is_empty(read_any(name, path))


@pytest.mark.parametrize("name", list(OUTSIDE))
def test_large_files_are_not_read(
    tmp_path: Path, name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    上限を超える実験のファイルは読まないことを確かめる関数 (末尾だけを
    読む output.log は除く)

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    name: str
        確かめるファイルの名前
    monkeypatch: pytest.MonkeyPatch
        上限を小さくするのに使う

    Returns
    ----------
    None
    """
    if name == "output.log":
        return
    for module in (runs, logs, run_files):
        for limit in (
            "MAX_JSON_BYTES", "MAX_YAML_BYTES", "MAX_CSV_BYTES",
            "MAX_LOG_BYTES"
        ):
            if hasattr(module, limit):
                monkeypatch.setattr(module, limit, 8)
    path = tmp_path / name
    path.write_text(OUTSIDE[name], encoding="utf-8")
    assert is_empty(read_any(name, path))


@pytest.mark.parametrize("now", [False, True])
@pytest.mark.parametrize("obstacle", ["link", "fifo"])
def test_stop_replaces_links_and_fifos(
    client: TestClient, project_dir: Path, tmp_path: Path, now: bool,
    obstacle: str
) -> None:
    """
    先にリンクか FIFO の STOP がある場合も, 外を書き換えずに新しい普通の
    ファイルとして STOP を作り, 学習が止まることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    now: bool
        エポックの途中で止める要求か
    obstacle: str
        先に置くもの (link は外のファイルへのリンク, fifo は FIFO)

    Returns
    ----------
    None
    """
    # 普通のファイルの STOP だけを要求と読む偽の学習
    (project_dir / "train.py").write_text(
        FAKE_TRAIN.replace(
            'if (run / "STOP").exists():',
            'if (run / "STOP").is_file() and '
            'not (run / "STOP").is_symlink():'
        )
    )
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    run_id = wait_for(client, job_id, "run_id", ...)["run_id"]

    # 外のファイルへのリンク (外は書き換えてはいけない) か FIFO を先に置く
    stop = project_dir / "outputs" / run_id / "STOP"
    outside = tmp_path / "outside.txt"
    outside.write_text("keep\n", encoding="utf-8")
    if obstacle == "link":
        stop.symlink_to(outside)
    else:
        os.mkfifo(stop)

    stopped = client.post(
        f"/api/jobs/{job_id}/stop", json={"force": False, "now": now}
    )
    assert stopped.status_code == 200
    assert outside.read_text(encoding="utf-8") == "keep\n"
    assert stop.is_file() and not stop.is_symlink()
    assert stop.read_text(encoding="utf-8") == ("now\n" if now else "")
    job = wait_for(client, job_id, "status", "finished")
    assert job["run"]["status"] == "stopped"
    assert outside.read_text(encoding="utf-8") == "keep\n"


def test_csv_is_streamed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    model_summary.csv と lr_steps.csv を 1 つの文字列にせずに流して読み,
    開いた後に上限を超えて伸びたファイルも読むのを止めることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        全てを読む関数を差し替えるのに使う

    Returns
    ----------
    None
    """
    def refuse(*args: Any, **kwargs: Any) -> Any:
        """
        全てを 1 つの文字列にして読む関数の代わり (呼ばれたら誤り)

        Parameters
        ----------
        *args: Any
            引数
        **kwargs: Any
            名前付きの引数

        Returns
        ----------
        None
        """
        raise AssertionError("中身を 1 つの文字列にして読んだ")

    monkeypatch.setattr(runs, "read_plain_text", refuse)
    monkeypatch.setattr(run_files, "read_plain", refuse)
    summary = tmp_path / "model_summary.csv"
    summary.write_text(OUTSIDE["model_summary.csv"], encoding="utf-8")
    rows, total = read_model_summary(summary)
    assert rows is not None and total == 1
    steps = tmp_path / "lr_steps.csv"
    steps.write_text(OUTSIDE["lr_steps.csv"], encoding="utf-8")
    assert [point.lr for point in read_lr_steps(steps)] == [0.1]

    # 開いた後に上限を超えて伸びたファイルは, 読む途中で止める
    grown = tmp_path / "grown.csv"
    grown.write_text("a\n", encoding="utf-8")
    with pytest.raises(run_files.RunFileError):
        with run_files.open_plain_text(grown, 16) as file:
            with grown.open("a", encoding="utf-8") as writer:
                writer.write("b\n" * 64)
            file.read()


def test_stop_is_written_before_it_appears(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    STOP を一時ファイルに書き終えてから置き換え, 読む側が空の STOP を
    見る間が無く, ハードリンクで共有した外の中身も書き換えないことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        置き換えの瞬間を見るのに使う

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    stop = run_dir / "STOP"
    outside = tmp_path / "outside.txt"
    outside.write_text("keep\n", encoding="utf-8")
    os.link(outside, stop)

    # 置き換える時には, 一時ファイルに中身を書き終え, STOP は前のまま
    seen: list[tuple[str, str]] = []
    original = os.replace

    def watch(source: Any, target: Any) -> None:
        """
        置き換える前の一時ファイルと STOP の中身を記録する関数

        Parameters
        ----------
        source: Any
            一時ファイル
        target: Any
            置き換える先

        Returns
        ----------
        None
        """
        seen.append((
            Path(source).read_text(encoding="utf-8"),
            Path(target).read_text(encoding="utf-8")
        ))
        original(source, target)

    monkeypatch.setattr(run_files.os, "replace", watch)
    run_files.replace_with_plain(stop, b"now\n")
    assert seen == [("now\n", "keep\n")]
    assert stop.read_text(encoding="utf-8") == "now\n"
    assert outside.read_text(encoding="utf-8") == "keep\n"
    # 一時ファイルは残らない
    assert sorted(path.name for path in run_dir.iterdir()) == ["STOP"]

    # ディレクトリの STOP は置けず, 一時ファイルも残さない
    stop.unlink()
    stop.mkdir()
    with pytest.raises(OSError):
        run_files.replace_with_plain(stop, b"")
    assert sorted(path.name for path in run_dir.iterdir()) == ["STOP"]
