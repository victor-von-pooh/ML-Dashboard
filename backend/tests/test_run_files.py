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
