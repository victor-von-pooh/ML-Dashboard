import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient
from omegaconf import OmegaConf

from ml_dashboard.api import check_process, jobs
from ml_dashboard.api.check_process import (
    describe_exception,
    rebuild_exception,
)
from ml_dashboard.api.jobs import (
    describe,
    describe_missing_path,
    uses_custom_classes,
)
from ml_dashboard.app import cookie_name, create_app
from ml_dashboard.core import jobs as core_jobs
from ml_dashboard.core.model_spec import find_model_spec_copy, run_of_copy
from ml_dashboard.core.models import RunModelSpec

from conftest import api_app
from test_api import register, wait_started

# ML-Found の学習の代わりに, 状態のファイルを書いて STOP を待つスクリプト
FAKE_TRAIN = '''\
import argparse, json, os, time
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--experiment")
args = parser.parse_args()
print("experiment", Path(args.experiment).name, flush=True)

now = datetime.now()
day, clock = now.strftime("%Y-%m-%d"), now.strftime("%H-%M-%S")
run = Path("outputs/demo") / day / clock
run.mkdir(parents=True)
(run / "config.yaml").write_text("experiment:\\n  name: demo\\n")
status = {"status": "running", "pid": os.getpid(), "planned_epochs": 100}
(run / "run.json").write_text(json.dumps(status))
(run / "progress.json").write_text(json.dumps({
    "phase": "train", "epoch": 1, "total_epochs": 100, "batch": 3,
    "total_batches": 10, "elapsed_sec": 0.5, "updated_at": now.isoformat()
}))
for _ in range(200):
    if (run / "STOP").exists():
        status["status"] = "stopped"
        break
    time.sleep(0.05)
else:
    status["status"] = "completed"
(run / "run.json").write_text(json.dumps(status))
(run / "progress.json").unlink()
stop = run / "STOP"
kind = stop.read_text().strip() if stop.exists() else ""
print("done", status["status"], kind or "epoch", flush=True)
'''


# fit の終わりに完了を書き, その後に評価と推論の一式を書き出すスクリプト.
# 一式の書き出しは, テストが置く GO を待ってから (最大 60 秒)
BUNDLE_TRAIN = '''\
import json, os, socket, time
from datetime import datetime
from pathlib import Path

now = datetime.now()
day, clock = now.strftime("%Y-%m-%d"), now.strftime("%H-%M-%S")
run = Path("outputs/demo") / day / clock
run.mkdir(parents=True)
(run / "config.yaml").write_text("experiment:\\n  name: demo\\n")
status = {
    "status": "completed", "pid": os.getpid(),
    "hostname": socket.gethostname(), "planned_epochs": 1
}
(run / "run.json").write_text(json.dumps(status))
for _ in range(1200):
    if Path("GO").exists():
        break
    time.sleep(0.05)
(run / "evaluations").mkdir()
(run / "inference").mkdir()
(run / "inference" / "inference.yaml").write_text("model: {}\\n")
'''


def wait_for(client: TestClient, job_id: str, key: str, value: object) -> dict:
    """
    ジョブの項目が指定した値になるまで待つ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    job_id: str
        ジョブの ID
    key: str
        確かめる項目
    value: object
        待つ値, None 以外になるのを待つ場合は ...

    Returns
    ----------
    job: dict
        条件を満たしたジョブの情報
    """
    # 最大 10 秒まで, 0.05 秒ごとに確認
    for _ in range(200):
        job: dict = client.get(f"/api/jobs/{job_id}").json()
        current = job[key]
        if (value is ... and current is not None) or current == value:
            return job
        time.sleep(0.05)

    raise AssertionError(f"{key} が {value} になりませんでした: {job}")


def test_validate_config(client: TestClient, project_dir: Path) -> None:
    """
    ML-Found で config を確かめられることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    ok = client.post(url, json={"text": "trainer:\n  epochs: 3\n"}).json()
    assert ok["ok"] is True
    assert ok["diff"]["trainer.epochs"]["experiment"] == 3

    typo = client.post(url, json={"text": "trainer:\n  epoch: 3\n"}).json()
    assert typo["ok"] is False
    assert "epoch" in typo["error"]

    config = client.get(
        f"/api/projects/{project_id}/configs/configs/experiment/train.yaml"
    )
    assert config.json()["text"] == "{}\n"
    outside = client.get(
        f"/api/projects/{project_id}/configs/configs/default/train.yaml"
    )
    assert outside.status_code == 404


def test_job_lifecycle(client: TestClient, project_dir: Path) -> None:
    """
    学習の起動, 実験との結び付け, 進み具合, 中断, 出力を確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text(FAKE_TRAIN)
    project_id = register(client, project_dir)

    # 存在しないスクリプトと, 誤りのある config は起動前に拒否
    bad_script = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "other.py"}
    )
    assert bad_script.status_code == 400
    bad_config = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epoch: 1\n"}
    )
    assert bad_config.status_code == 400

    # 書き換えた config で起動
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epochs: 5\n"}
    )
    assert created.status_code == 201
    job_id = created.json()["id"]

    # 実験が作られると結び付き, 進み具合が読める
    job = wait_for(client, job_id, "run_id", ...)
    assert job["run"]["status"] == "running"
    assert job["progress"]["batch"] == 3
    # 段階を書かない前の版の progress.json は, バッチを回している間と読む
    assert job["progress"]["stage"] == "batches"
    assert job["project_name"] == "demo_task"

    # 中断の要求で止まり, 実験は中断として残る
    stopped = client.post(f"/api/jobs/{job_id}/stop", json={"force": False})
    assert stopped.json()["stop_requested"] is True
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] == 0
    assert job["run"]["status"] == "stopped"

    output = client.get(f"/api/jobs/{job_id}/output").json()["text"]
    assert "experiment experiment.yaml" in output
    assert "done stopped" in output

    jobs = client.get("/api/jobs").json()
    assert [item["id"] for item in jobs] == [job_id]


def test_job_running_after_fit(
    client: TestClient, project_dir: Path
) -> None:
    """
    fit の後の推論の一式の書き出しの間, ジョブが動いたままであることを
    確かめる関数

    画面はジョブの status と実験の状態を合わせて, この間を「後の処理中」
    とし, プロセスが終わるまで「完了」を出さない

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text(BUNDLE_TRAIN)
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    assert created.status_code == 201
    job_id = created.json()["id"]

    # 実験は完了でも, 一式を書き出すまでプロセスは動いたまま
    job = wait_for(client, job_id, "run_id", ...)
    for _ in range(10):
        job = client.get(f"/api/jobs/{job_id}").json()
        assert job["run"]["status"] == "completed"
        assert job["status"] == "running"
        time.sleep(0.02)
    run_dir = project_dir / "outputs" / job["run_id"]
    assert not (run_dir / "inference" / "inference.yaml").exists()

    # 一式の書き出しとプロセスの終わり
    (project_dir / "GO").touch()
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] == 0
    assert job["run"]["status"] == "completed"
    assert (run_dir / "inference" / "inference.yaml").is_file()


def test_force_stop_after_fit_restarted(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後は, 後の処理の途中のジョブに, 同じプロセスと確かめられた
    場合だけ割り込むことを確かめる関数

    run.json が完了の後は run.json だけでは pid の使い回しと見分けられない
    ので, プロセスの起動の時刻を確かめられない場合はシグナルを送らず,
    画面がすぐに止めるを止める値 (attached が偽) を返す

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ (client のデータの置き場の親)
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text(BUNDLE_TRAIN)
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    job = wait_for(client, job_id, "run_id", ...)
    assert job["run"]["status"] == "completed"
    # 起動したアプリからは割り込める
    assert job["attached"] is True

    # 同じ置き場の新しいアプリ (起動したプロセスを持たない)
    restarted = TestClient(
        create_app(
            tmp_path / "home", token="test-token",
            allowed_hosts=["testserver"]
        ),
        cookies={cookie_name("test-token"): "test-token"}
    )

    # 起動の時刻を読めない環境では, 動いたままで割り込まない
    # (強制の中断でもシグナルを送らず, 送った場合だけ数える回数が 0)
    with monkeypatch.context() as patch:
        patch.setattr(core_jobs, "process_started", lambda pid: None)
        job = restarted.get(f"/api/jobs/{job_id}").json()
        assert job["status"] == "running"
        assert job["attached"] is False
        stopped = restarted.post(
            f"/api/jobs/{job_id}/stop", json={"force": True}
        ).json()
        assert stopped["force_count"] == 0
        time.sleep(0.2)
        job = restarted.get(f"/api/jobs/{job_id}").json()
        assert job["status"] == "running"

    if core_jobs.process_started(os.getpid()) is None:
        (project_dir / "GO").touch()
        wait_for(client, job_id, "status", "finished")
        pytest.skip("ps でプロセスの起動の時刻を読めない環境")

    # 同じプロセスと確かめられれば, 起動し直した後でも割り込める
    job = restarted.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "running"
    assert job["attached"] is True
    stopped = restarted.post(
        f"/api/jobs/{job_id}/stop", json={"force": True}
    ).json()
    assert stopped["force_count"] == 1

    # 一式を書かずに止まる (終わりは起動した側のアプリで回収)
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] != 0
    run_dir = project_dir / "outputs" / job["run_id"]
    assert not (run_dir / "inference" / "inference.yaml").exists()


def test_reused_pid_after_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後, 記録の pid を別のプロセスが使い回していれば, ジョブを
    終わったものにし, 本物のジョブは動いたままにすることを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    # ジョブの開始の時刻を取ってから起動したプロセス (本物のジョブ)
    created_at = core_jobs.now_iso()
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=True
    )
    try:
        if core_jobs.process_started(process.pid) is None:
            pytest.skip("ps でプロセスの起動の時刻を読めない環境")
        (run_dir / "run.json").write_text(json.dumps({
            "status": "completed", "pid": process.pid,
            "hostname": socket.gethostname()
        }))

        def job_at(created: str) -> core_jobs.Job:
            # 起動し直した後の記録 (このアプリが起動したプロセスを持たない)
            return core_jobs.Job(
                id="0123456789ab", project_id="p", script="train.py",
                config="c.yaml", created_at=created, pid=process.pid,
                status="running", return_code=None, run_id=None,
                finished_at=None, stop_requested=False
            )

        manager = core_jobs.JobManager(tmp_path)
        job = job_at(created_at)
        assert core_jobs.same_process(job) is True
        assert manager.poll(job) == (False, None)
        assert manager.owns(job, run_dir)

        # プロセスがジョブより後に始まった (終わった後に pid を使い回した)
        earlier = datetime.fromisoformat(created_at) - timedelta(hours=1)
        reused = job_at(earlier.isoformat(timespec="seconds"))
        assert core_jobs.same_process(reused) is False
        assert manager.poll(reused, run_dir) == (True, None)
        assert manager.poll(reused) == (True, None)
        assert not manager.owns(reused, run_dir)

        # プロセスがジョブより前に始まったと読める場合は同じとみなす
        # (本物の pid は本物が終わった後にしか使い回されず, 時刻の読み違い
        # で本物のジョブを終わったものにしないため)
        later = datetime.fromisoformat(created_at) + timedelta(hours=1)
        ahead = job_at(later.isoformat(timespec="seconds"))
        assert core_jobs.same_process(ahead) is True
        assert manager.poll(ahead, run_dir) == (False, None)

        # 幅の境目 (開始の時刻から 59 秒は同じ, 61 秒は別)
        start = datetime.fromisoformat(created_at)
        for gap, same in ((59, True), (61, False)):
            with monkeypatch.context() as patch:
                patch.setattr(
                    core_jobs, "process_started",
                    lambda pid, gap=gap: start + timedelta(seconds=gap)
                )
                assert core_jobs.same_process(job) is same

        # 確かめられない場合 (起動の時刻を読めない, 時刻の無い記録) は今の
        # 振る舞い. 実行中の run.json なら割り込み, 後の処理中なら割り込まない
        # (一度も使い回しと読んでいないジョブ)
        monkeypatch.setattr(core_jobs, "process_started", lambda pid: None)
        unknown = job_at(earlier.isoformat(timespec="seconds"))
        assert core_jobs.same_process(unknown) is None
        assert manager.poll(unknown) == (False, None)
        assert not manager.owns(unknown, run_dir)
        (run_dir / "run.json").write_text(json.dumps({
            "status": "running", "pid": process.pid,
            "hostname": socket.gethostname()
        }))
        assert manager.owns(unknown, run_dir)
        assert not unknown.pid_reused
        # 前に使い回しと読んだジョブは, 確かめられなくても割り込まない
        assert reused.pid_reused
        assert not manager.owns(reused, run_dir)
        monkeypatch.undo()
        assert core_jobs.same_process(job_at("2026-11-01T00:00:00")) is None
        assert core_jobs.same_process(job_at("壊れた時刻")) is None

        # 実行中の run.json なら, 使い回しと読めても, 学習の記録が止まったと
        # 分かるまでは終わったものにしない (時計の合わせ直しで ps の時刻が
        # ずれた本物を戻せなくしないため). ただし割り込まない
        assert manager.poll(reused, run_dir) == (False, None)
        assert not manager.owns(reused, run_dir)
        assert manager.owns(job, run_dir)
    finally:
        process.kill()
        process.wait()


def test_stalled_run_with_reused_pid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後, run.json が実行中のまま pid を使い回したジョブを,
    学習の記録が変わらないまま JOB_STALL_SEC たてば終わったものにし,
    記録を書き続ける本物は動いたままにすることを確かめる関数

    本物 (時計の合わせ直しで ps の時刻がずれ, 使い回しと読めるもの) と
    死んだ学習は, ML-Found が学習中に書き直す記録が変わるかで見分ける.
    使い回しと読めないジョブは, 記録が止まっても終わったものにしない

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "outputs" / "demo" / "2026-11-01" / "00-00-00"
    run_dir.mkdir(parents=True)

    def write_live(epoch: int, batch: int) -> None:
        # ML-Found と同じく一時ファイルに書いてから置き換え
        for name, data in (
            ("run.json", {
                "status": "running", "pid": process.pid,
                "hostname": socket.gethostname()
            }),
            ("progress.json", {
                "phase": "train", "epoch": epoch, "batch": batch,
                "updated_at": "2026-11-01T00:00:00+09:00"
            })
        ):
            temp = run_dir / f".{name}.tmp"
            temp.write_text(json.dumps(data))
            os.replace(temp, run_dir / name)

    # 学習のプロセスが死んだ後に pid を使い回した (と読める) プロセス
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=True
    )
    try:
        write_live(1, 1)
        (run_dir / "train.log").write_text("epoch 1\n")
        created_at = core_jobs.now_iso()
        start = datetime.fromisoformat(created_at)

        def job_of(job_id: str) -> core_jobs.Job:
            # 起動し直した後の記録 (このアプリが起動したプロセスを持たない)
            return core_jobs.Job(
                id=job_id, project_id="p", script="train.py",
                config="c.yaml", created_at=created_at, pid=process.pid,
                status="running", return_code=None, run_id=None,
                finished_at=None, stop_requested=False
            )

        # 時計はテストで進める単調な時計に差し替え
        manager = core_jobs.JobManager(tmp_path)
        now = [1000.0]
        manager.clock = lambda: now[0]
        stall = core_jobs.JOB_STALL_SEC
        gap = core_jobs.JOB_STALL_GAP_SEC

        def keep_reading(job: core_jobs.Job, seconds: float) -> list[bool]:
            # 画面が読み直し続ける間 (1 分ごと) の, 終わったと読んだか
            results = []
            for _ in range(int(seconds // 60)):
                now[0] += 60
                results.append(manager.poll(job, run_dir)[0])
            return results

        # pid のプロセスはジョブの開始の 1 時間後に始まったと読む
        monkeypatch.setattr(
            core_jobs, "process_started",
            lambda pid: start + timedelta(hours=1)
        )

        # 記録を書き続ける本物は, 何時間たっても動いたまま
        real = job_of("0123456789ab")
        assert core_jobs.same_process(real) is False
        assert manager.poll(real, run_dir) == (False, None)
        for step in range(1, 5):
            assert not any(keep_reading(real, stall - 60))
            write_live(1, step + 1)
            assert manager.poll(real, run_dir) == (False, None)
        # 書き直した後は, そこから数え直す
        assert not any(keep_reading(real, stall - 60))
        assert keep_reading(real, 60) == [True]

        # train.log に書き足しただけ (i-node が同じ) でも数え直す
        with open(run_dir / "train.log", "a") as log:
            log.write("epoch 2\n")
        assert manager.poll(real, run_dir) == (False, None)
        assert not any(keep_reading(real, stall - 60))

        # 死んだ学習 (記録が変わらない) は, 読み直し続けて 1 時間で終わる
        dead = job_of("123456789abc")
        assert manager.poll(dead, run_dir) == (False, None)
        assert not any(keep_reading(dead, stall - 60))
        assert keep_reading(dead, 60) == [True]
        # 終わったものにしても割り込まない
        assert not manager.owns(dead, run_dir)

        # 読み直しの間が空いた場合は, 再開して最初に読んだ 1 回で決めず
        # 数え直す (一時停止から再開した本物が記録を書く間を残すため)
        paused = job_of("456789abcdef")
        assert manager.poll(paused, run_dir) == (False, None)
        now[0] += stall * 3
        assert manager.poll(paused, run_dir) == (False, None)
        assert not any(keep_reading(paused, gap))
        assert not any(keep_reading(paused, stall / 2))
        now[0] += gap
        assert manager.poll(paused, run_dir) == (False, None)
        assert not any(keep_reading(paused, stall - 60))
        assert keep_reading(paused, 60) == [True]
        # 幅のちょうど手前の間なら数え続ける
        edge = job_of("56789abcdef0")
        assert manager.poll(edge, run_dir) == (False, None)
        results = []
        while now[0] < 1e9 and not any(results):
            now[0] += gap - 1
            results.append(manager.poll(edge, run_dir)[0])
        assert len(results) == -(-stall // (gap - 1))

        # 使い回しと読めない (同じプロセスと読む, 起動の時刻を読めない)
        # ジョブは, 記録が止まっても終わったものにしない
        for started in (start, None):
            with monkeypatch.context() as patch:
                patch.setattr(
                    core_jobs, "process_started",
                    lambda pid, started=started: started
                )
                job = job_of("23456789abcd")
                assert manager.poll(job, run_dir) == (False, None)
                assert not any(keep_reading(job, stall * 2))

        # 一覧の読み直しでも終わったものにし, 終了コードは分からないまま
        # (プロセスにはシグナルを送らない)
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        project = core_jobs.Project(
            id="p", name="p", path=str(project_dir),
            python=sys.executable, created_at=created_at
        )
        stored = job_of("3456789abcde")
        manager.job_dir(stored.id).mkdir(parents=True)
        manager.save(stored)
        monkeypatch.setattr(
            manager, "find_run", lambda job, project: run_dir
        )
        assert manager.get(stored.id, {"p": project}).status == "running"
        # 数えている間の強制の中断でもシグナルを送らない
        for _ in range(3):
            stopping = manager.stop(stored.id, {"p": project}, force=True)
            assert stopping is not None
            assert stopping.status == "running"
            assert stopping.force_count == 0
        assert process.poll() is None
        for _ in range(int(stall // 60)):
            now[0] += 60
            refreshed = manager.get(stored.id, {"p": project})
            assert refreshed is not None
            if refreshed.status == "finished":
                break
        assert refreshed is not None
        assert refreshed.status == "finished"
        assert refreshed.return_code is None
        assert stored.id not in manager.stalls
        stopped = manager.stop(stored.id, {"p": project}, force=True)
        assert stopped is not None and stopped.force_count == 0
        assert process.poll() is None
    finally:
        process.kill()
        process.wait()


# ML-Found の本物の心拍 (PostHeartbeat) を書く学習の後の処理の代わりの
# スクリプト. 引数は実験のディレクトリ, 書き直す間隔, 心拍の扱い (none は
# 書かない, end は書いてすぐ終える, それ以外は書き続ける)
POST_HEARTBEAT = '''\
import sys, time
from pathlib import Path
from ml_found.training.heartbeat import PostHeartbeat

if sys.argv[3] != "none":
    heartbeat = PostHeartbeat(Path(sys.argv[1]), interval=float(sys.argv[2]))
    heartbeat.start()
    if sys.argv[3] == "end":
        heartbeat.end()
time.sleep(60)
'''


def read_beat(run_dir: Path, state: str, after: int = 0) -> int:
    """
    心拍のファイルが指定した状態で, 連番が指定した値より大きくなるまで
    待つ関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    state: str
        待つ状態 (running か ended)
    after: int = 0
        この値より大きい連番を待つ

    Returns
    ----------
    beat: int
        読んだ連番
    """
    # 最大 20 秒まで, 0.05 秒ごとに確認 (書きかけは一時ファイルなので読まない)
    heartbeat: dict = {}
    for _ in range(400):
        try:
            heartbeat = json.loads((run_dir / "heartbeat.json").read_text())
        except (OSError, ValueError):
            heartbeat = {}
        if heartbeat.get("state") == state and heartbeat["beat"] > after:
            return int(heartbeat["beat"])
        time.sleep(0.05)

    raise AssertionError(f"心拍が {state} になりませんでした: {heartbeat}")


def test_post_heartbeat_without_start_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後, 起動の時刻を読めない学習の後の処理中 (run.json が完了)
    のジョブを, ML-Found の心拍が止まるか終えたときに終わったものにし,
    心拍が続くジョブと心拍の無いジョブは動いたままにし, どの場合も
    シグナルを送らないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    created_at = core_jobs.now_iso()
    project = core_jobs.Project(
        id="p", name="p", path=str(project_dir),
        python=sys.executable, created_at=created_at
    )
    script = tmp_path / "post.py"
    script.write_text(POST_HEARTBEAT)

    # 送ったシグナルを記録 (実際には送らない)
    sent: list[tuple[int, int]] = []
    monkeypatch.setattr(
        core_jobs.os, "killpg",
        lambda pid, number: sent.append((pid, number))
    )

    # 起動の時刻を読めない環境. 時計はテストで進める単調な時計に差し替え
    monkeypatch.setattr(core_jobs, "process_started", lambda pid: None)
    manager = core_jobs.JobManager(tmp_path)
    now = [1000.0]
    manager.clock = lambda: now[0]
    gap = core_jobs.JOB_STALL_GAP_SEC

    # 実験は 1 つの出力先に, 作った順に新しい時刻の名前で置く
    outputs = tmp_path / "outputs"
    monkeypatch.setattr(manager, "output_dirs", lambda job, project: [outputs])
    made = [0]

    def make_run() -> Path:
        # ML-Found の形の実験のディレクトリ (前に作ったものより新しい)
        made[0] += 1
        run_dir = outputs / "demo" / "2026-11-01" / f"00-00-{made[0]:02d}"
        run_dir.mkdir(parents=True)
        (run_dir / "config.yaml").write_text("experiment:\n  name: demo\n")
        return run_dir

    processes: list[subprocess.Popen[bytes]] = []

    def post(name: str, mode: str, state: str = "completed") -> tuple[
        core_jobs.Job, Path
    ]:
        # 心拍を書く後の処理のプロセスと, その実験と, 起動し直した後の記録
        run_dir = make_run()
        process = subprocess.Popen(
            [sys.executable, str(script), str(run_dir), "0.2", mode],
            start_new_session=True
        )
        processes.append(process)
        (run_dir / "run.json").write_text(json.dumps({
            "status": state, "pid": process.pid,
            "hostname": socket.gethostname()
        }))
        job = core_jobs.Job(
            id=hashlib.sha256(name.encode()).hexdigest()[:12],
            project_id="p", script="train.py", config="c.yaml",
            created_at=created_at, pid=process.pid, status="running",
            return_code=None, run_id=None, finished_at=None,
            stop_requested=False
        )
        return job, run_dir

    try:
        # 心拍のファイルが無ければ今のまま (何時間たっても動いたまま)
        legacy, legacy_dir = post("legacy", "none")
        for _ in range(5):
            now[0] += 60
            assert manager.poll(legacy, legacy_dir, project) == (False, None)
        assert legacy.id not in manager.beats

        # 終えた心拍 (ended) は, 後の処理を終えたので終わったものにする
        ended, ended_dir = post("ended", "end")
        read_beat(ended_dir, "ended")
        assert manager.poll(ended, ended_dir, project) == (True, None)
        # ただし pid かホスト名が違う心拍と, 実験が実行中の場合は使わない
        heartbeat = json.loads((ended_dir / "heartbeat.json").read_text())
        for changed in ({}, {"pid": legacy.pid, "hostname": "other"}):
            (legacy_dir / "heartbeat.json").write_text(
                json.dumps({**heartbeat, **changed})
            )
            assert manager.poll(legacy, legacy_dir, project) == (False, None)
        running = json.loads((ended_dir / "run.json").read_text())
        (ended_dir / "run.json").write_text(
            json.dumps({**running, "status": "running"})
        )
        assert manager.poll(ended, ended_dir, project) == (False, None)
        (ended_dir / "run.json").write_text(json.dumps(running))
        assert manager.poll(ended, ended_dir, project) == (True, None)
        # プロジェクトが分からない (出力先を確かめられない) 場合は使わない
        assert manager.poll(ended, ended_dir) == (False, None)

        # 同じプロセスが次の実験を始めた (前の心拍が ended になる) 場合は,
        # 新しい実験が学習中か後の処理中の間は動いたまま
        following = make_run()
        same_host = {"pid": ended.pid, "hostname": socket.gethostname()}
        (following / "run.json").write_text(
            json.dumps({**same_host, "status": "running"})
        )
        assert manager.poll(ended, ended_dir, project) == (False, None)
        (following / "run.json").write_text(
            json.dumps({**same_host, "status": "completed"})
        )
        (following / "heartbeat.json").write_text(json.dumps({
            **heartbeat, **same_host, "state": "running"
        }))
        assert manager.poll(ended, ended_dir, project) == (False, None)
        # 別のホストや別の pid の新しい実験は見ない
        for other in ({"hostname": "other"}, {"pid": legacy.pid}):
            for name in ("run.json", "heartbeat.json"):
                data = json.loads((following / name).read_text())
                (following / name).write_text(json.dumps({**data, **other}))
            assert manager.poll(ended, ended_dir, project) == (True, None)
            for name in ("run.json", "heartbeat.json"):
                data = json.loads((following / name).read_text())
                (following / name).write_text(
                    json.dumps({**data, **same_host})
                )
        # 新しい実験も後の処理を終えれば終わったものにする
        (following / "heartbeat.json").write_text(json.dumps({
            **heartbeat, **same_host, "state": "ended"
        }))
        assert manager.poll(ended, ended_dir, project) == (True, None)
        shutil.rmtree(following)

        # ML-Found が次の実験のディレクトリと config.yaml を作り, run.json を
        # 書く前 (データの読み込みなどの準備中) も動いたまま. 準備中とみなす
        # のは, 名前の時刻がジョブの実験の心拍の ended_at 以降のものだけ
        assert core_jobs.post_end(ended_dir) == datetime.fromisoformat(
            heartbeat["ended_at"]
        ).replace(tzinfo=None)
        stale = make_run()
        assert manager.poll(ended, ended_dir, project) == (True, None)
        moment = datetime.now() + timedelta(seconds=1)
        preparing = (
            outputs / "demo" / moment.strftime("%Y-%m-%d")
            / moment.strftime("%H-%M-%S")
        )
        preparing.mkdir(parents=True)
        (preparing / "config.yaml").write_text("experiment:\n  name: demo\n")
        assert manager.poll(ended, ended_dir, project) == (False, None)
        # run.json を書けば, その中身で決める (別のプロセスの完了なら終える)
        (preparing / "run.json").write_text(json.dumps({
            "status": "completed", "pid": legacy.pid,
            "hostname": socket.gethostname()
        }))
        assert manager.poll(ended, ended_dir, project) == (True, None)
        shutil.rmtree(preparing)
        # 心拍の ended_at が無ければ run.json の finished_at を使い, どちらも
        # 無ければ None (ジョブの実験より新しい準備中の実験を全て見る)
        assert core_jobs.post_end(stale) is None
        (stale / "run.json").write_text(
            json.dumps({"finished_at": "2026-11-01T00:00:30+00:00"})
        )
        assert core_jobs.post_end(stale) == datetime(2026, 11, 1, 0, 0, 30)
        shutil.rmtree(stale)

        # 学習のプロセスの時刻帯 (UTC) がダッシュボード (東京) と違っても,
        # 名前と ended_at を学習のプロセスの壁時計のまま比べて動いたまま
        utc = datetime.now(timezone.utc).replace(microsecond=0)
        (ended_dir / "heartbeat.json").write_text(json.dumps({
            **heartbeat, "ended_at": utc.isoformat()
        }))
        moment = utc.replace(tzinfo=None) + timedelta(seconds=1)
        preparing = (
            outputs / "demo" / moment.strftime("%Y-%m-%d")
            / moment.strftime("%H-%M-%S")
        )
        preparing.mkdir(parents=True)
        (preparing / "config.yaml").write_text("experiment:\n  name: demo\n")
        try:
            with monkeypatch.context() as patch:
                patch.setenv("TZ", "Asia/Tokyo")
                time.tzset()
                assert manager.poll(ended, ended_dir, project) == (
                    False, None
                )
        finally:
            time.tzset()
        shutil.rmtree(preparing)
        (ended_dir / "heartbeat.json").write_text(json.dumps(heartbeat))
        assert manager.poll(ended, ended_dir, project) == (True, None)

        # 同じプロセスと確かめられたジョブは, プロセスが終わるまで待つ
        (ended_dir / "run.json").write_text(json.dumps(running))
        with monkeypatch.context() as patch:
            patch.setattr(
                core_jobs, "process_started",
                lambda pid: datetime.fromisoformat(created_at)
            )
            assert manager.poll(ended, ended_dir, project) == (False, None)

        # 心拍が続く後の処理は, 単調な時計で何時間たっても動いたまま
        # (読み直すたびに連番が変わる)
        live, live_dir = post("live", "run")
        read_beat(live_dir, "running")
        for _ in range(5):
            assert manager.poll(live, live_dir, project) == (False, None)
            # 読み直しの後に読んだ連番より新しい心拍を待つ (読み直しの前に
            # 書かれた心拍を待つと, 同じ連番を 2 回読みうるため)
            read_beat(live_dir, "running", manager.beats[live.id][0])
            now[0] += 60
        assert manager.poll(live, live_dir, project) == (False, None)

        # 中断の状態で fit を終えた実験も同じく心拍で決める
        stopped, stopped_dir = post("stopped", "end", "stopped")
        read_beat(stopped_dir, "ended")
        assert manager.poll(stopped, stopped_dir, project) == (True, None)

        # 一覧の読み直しの形 (保存したジョブ) で, 心拍が止まった後の処理
        stored, stored_dir = post("stored", "run")
        manager.job_dir(stored.id).mkdir(parents=True)
        manager.save(stored)
        monkeypatch.setattr(
            manager, "find_run", lambda job, project: stored_dir
        )
        read_beat(stored_dir, "running")
        assert manager.get(stored.id, {"p": project}).status == "running"

        # 書き手のプロセスを一時停止して心拍を止める (強制終了された後に
        # pid を使い回したプロセスと同じ見え方. プロセスは動いている)
        os.kill(stored.pid or 0, signal.SIGSTOP)
        time.sleep(0.5)
        # 0.2 秒の間隔は下限の HEARTBEAT_MIN_INTERVAL に上げて数える
        limit = (
            core_jobs.HEARTBEAT_MIN_INTERVAL
            * core_jobs.HEARTBEAT_STALL_FACTOR
        )
        assert manager.get(stored.id, {"p": project}).status == "running"
        # 数えている間の強制の中断でもシグナルを送らない
        for _ in range(3):
            stopping = manager.stop(stored.id, {"p": project}, force=True)
            assert stopping is not None
            assert stopping.status == "running"
            assert stopping.force_count == 0
        # 読み直しの間が空いた場合は, 最初の 1 回で決めずに数え直す
        now[0] += gap
        assert manager.get(stored.id, {"p": project}).status == "running"
        # 目安の手前では動いたまま, 目安を超えると終わったものにする
        now[0] += limit - 0.1
        assert manager.get(stored.id, {"p": project}).status == "running"
        now[0] += 0.2
        refreshed = manager.get(stored.id, {"p": project})
        assert refreshed is not None
        assert refreshed.status == "finished"
        assert refreshed.return_code is None
        assert stored.id not in manager.beats
        # 終わったものにした後も, 強制の中断でシグナルを送らない
        after = manager.stop(stored.id, {"p": project}, force=True)
        assert after is not None and after.force_count == 0
        assert sent == []
        assert all(process.poll() is None for process in processes)
    finally:
        for process in processes:
            process.kill()
            process.wait()


def test_force_stop_reused_pid(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後, 完了の run.json と使い回しの pid のジョブに強制の中断を
    送っても, シグナルを送らずに終わったものにすることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ (client のデータの置き場の親)
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text(BUNDLE_TRAIN)
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    job = wait_for(client, job_id, "run_id", ...)
    assert job["run"]["status"] == "completed"

    # 同じ置き場の新しいアプリで, pid のプロセスが 1 時間後に始まったと読む
    restarted = TestClient(
        create_app(
            tmp_path / "home", token="test-token",
            allowed_hosts=["testserver"]
        ),
        cookies={cookie_name("test-token"): "test-token"}
    )
    start = datetime.fromisoformat(job["created_at"])
    process = api_app(client).state.jobs.processes[job_id]
    try:
        with monkeypatch.context() as patch:
            patch.setattr(
                core_jobs, "process_started",
                lambda pid: start + timedelta(hours=1)
            )
            stopped = restarted.post(
                f"/api/jobs/{job_id}/stop", json={"force": True}
            ).json()
        assert stopped["status"] == "finished"
        assert stopped["return_code"] is None
        assert stopped["force_count"] == 0
        # 本物のプロセスはシグナルを受けずに動いたまま
        assert process.poll() is None
    finally:
        (project_dir / "GO").touch()
        process.wait(timeout=30)
    assert process.returncode == 0


def test_force_stop_once_reused_pid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    起動し直した後, 前に pid の使い回しと読んだ学習中のジョブは, 次に
    起動の時刻を読めなかったときに強制の中断を押してもシグナルを送らず,
    一度も使い回しと読んでいないジョブには今と同じく送ることを確かめる関数

    使い回しと読んだ印はジョブの記録に残るので, もう一度起動し直した後
    (新しい JobManager) でも送らない

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "outputs" / "demo" / "2026-11-01" / "00-00-00"
    run_dir.mkdir(parents=True)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    created_at = core_jobs.now_iso()
    start = datetime.fromisoformat(created_at)
    project = core_jobs.Project(
        id="p", name="p", path=str(project_dir),
        python=sys.executable, created_at=created_at
    )

    # 送ったシグナルを記録 (実際には送らない)
    sent: list[tuple[int, int]] = []
    monkeypatch.setattr(
        core_jobs.os, "killpg",
        lambda pid, number: sent.append((pid, number))
    )

    # 学習中の run.json と同じ pid のプロセス
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=True
    )
    try:
        (run_dir / "run.json").write_text(json.dumps({
            "status": "running", "pid": process.pid,
            "hostname": socket.gethostname()
        }))

        def stored(job_id: str) -> None:
            # 起動し直した後の記録 (このアプリが起動したプロセスを持たない)
            job = core_jobs.Job(
                id=job_id, project_id="p", script="train.py",
                config="c.yaml", created_at=created_at, pid=process.pid,
                status="running", return_code=None,
                run_id="demo/2026-11-01/00-00-00",
                finished_at=None, stop_requested=False
            )
            manager.job_dir(job_id).mkdir(parents=True)
            manager.save(job)

        def restart() -> core_jobs.JobManager:
            # 同じ置き場の新しい JobManager (メモリに覚えたものは無い)
            fresh = core_jobs.JobManager(tmp_path)
            monkeypatch.setattr(
                fresh, "find_run", lambda job, project: run_dir
            )
            return fresh

        manager = restart()
        reused_id, real_id = "0123456789ab", "123456789abc"
        stored(reused_id)
        stored(real_id)

        # pid のプロセスがジョブの開始の 1 時間後に始まったと一度読む
        with monkeypatch.context() as patch:
            patch.setattr(
                core_jobs, "process_started",
                lambda pid: start + timedelta(hours=1)
            )
            job = manager.get(reused_id, {"p": project})
            assert job is not None and job.status == "running"
            assert job.pid_reused
        loaded = manager.load(reused_id)
        assert loaded is not None and loaded.pid_reused

        # 画面の割り込めるか (attached) は, ロックの外で印を書き換えず,
        # 保存した印と今の起動の時刻の読みから owns と同じ結論を出す
        for name, value in (
            ("resolve_run_dir", lambda dirs, run_id: run_dir),
            ("summarize_run", lambda root, path: None),
            ("read_progress", lambda path: None)
        ):
            monkeypatch.setattr(jobs, name, value)
        monkeypatch.setattr(
            core_jobs.JobManager, "output_dirs",
            lambda self, job, project: [run_dir.parents[2]]
        )
        readings: tuple[tuple[Optional[datetime], bool, bool], ...] = (
            (start, True, True),
            (start + timedelta(hours=1), False, False),
            (None, False, True)
        )
        for started, reused_owned, real_owned in readings:
            with monkeypatch.context() as patch:
                patch.setattr(
                    core_jobs, "process_started",
                    lambda pid, started=started: started
                )
                for current in (manager, restart()):
                    for job_id, owned in (
                        (reused_id, reused_owned), (real_id, real_owned)
                    ):
                        job = current.load(job_id)
                        assert job is not None
                        before = job.pid_reused
                        info = jobs.to_job_info(current, job, project)
                        assert info.attached is owned
                        assert current.owns(job, run_dir) is owned
                        assert job.pid_reused is before
            real = manager.load(real_id)
            assert real is not None and not real.pid_reused

        # 次は起動の時刻を読めない. 使い回しと読んだジョブには送らず,
        # 一度も使い回しと読んでいないジョブには今と同じく送る
        monkeypatch.setattr(core_jobs, "process_started", lambda pid: None)
        for current in (manager, restart()):
            for _ in range(3):
                stopping = current.stop(reused_id, {"p": project}, force=True)
                assert stopping is not None
                assert stopping.status == "running"
                assert stopping.force_count == 0
                assert stopping.pid_reused
        assert sent == []
        stopping = restart().stop(real_id, {"p": project}, force=True)
        assert stopping is not None
        assert stopping.force_count == 1
        assert not stopping.pid_reused
        assert sent == [(process.pid, core_jobs.FORCE_SIGNALS[0])]
        assert process.poll() is None
    finally:
        process.kill()
        process.wait()


def test_permission_denied_force_stop(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    別のユーザーのプロセスでシグナルを送れない場合は, 理由を 409 で返す
    ことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text(BUNDLE_TRAIN)
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    wait_for(client, job_id, "run_id", ...)

    def denied(pid: int, number: int) -> None:
        raise PermissionError("Operation not permitted")

    try:
        with monkeypatch.context() as patch:
            patch.setattr(core_jobs.os, "killpg", denied)
            response = client.post(
                f"/api/jobs/{job_id}/stop", json={"force": True}
            )
        assert response.status_code == 409
        assert "権限がありません" in response.json()["detail"]
        assert client.get(f"/api/jobs/{job_id}").json()["force_count"] == 0
    finally:
        (project_dir / "GO").touch()
        wait_for(client, job_id, "status", "finished")


def test_stop_within_epoch(client: TestClient, project_dir: Path) -> None:
    """
    エポックの途中で止める要求が, STOP に now と書くことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 中身が now になるまで止まらない偽の学習 (区切りの要求では止まらない)
    (project_dir / "train.py").write_text(
        FAKE_TRAIN.replace(
            'if (run / "STOP").exists():',
            'if (run / "STOP").exists() and '
            '(run / "STOP").read_text().strip() == "now":'
        )
    )
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    run_id = wait_for(client, job_id, "run_id", ...)["run_id"]

    # エポックの区切りで止める要求の後でも, 途中で止める要求に切り替えられる
    client.post(f"/api/jobs/{job_id}/stop", json={"force": False})
    stopped = client.post(
        f"/api/jobs/{job_id}/stop", json={"force": False, "now": True}
    )
    assert stopped.json()["stop_requested"] is True
    stop_file = project_dir / "outputs" / run_id / "STOP"
    assert stop_file.read_text(encoding="utf-8") == "now\n"
    job = wait_for(client, job_id, "status", "finished")
    assert job["run"]["status"] == "stopped"
    output = client.get(f"/api/jobs/{job_id}/output").json()["text"]
    assert "done stopped now" in output


def test_force_stop(client: TestClient, project_dir: Path) -> None:
    """
    強制の中断で割り込みを送れることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 短い眠りを繰り返す学習の代わり. 1 回の長い time.sleep は, 眠りに入る
    # 直前に届いた割り込みを眠りの終わりまで扱わないため
    (project_dir / "train.py").write_text(
        "import time\nfrom pathlib import Path\n"
        "Path('started').touch()\nprint('start', flush=True)\n"
        "for _ in range(600):\n    time.sleep(0.05)\n"
    )
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    wait_started(project_dir / "started")

    # 実験が無くても, Ctrl-C と同じ割り込みで止まる
    client.post(f"/api/jobs/{job_id}/stop", json={"force": True})
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] != 0
    assert job["run_id"] is None

    missing = client.get("/api/jobs/zzzz")
    assert missing.status_code == 404
    traversal = client.get("/api/jobs/..%2F..")
    assert traversal.status_code == 404


def test_rejected_launch_leaves_nothing(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    受け付けなかった起動がジョブのディレクトリを残さないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/jobs"

    # 誤った config, 辞書でない config, パスと中身の両方の指定
    typo = client.post(
        url, json={"script": "train.py", "config_text": "trainer:\n  e: 1\n"}
    )
    assert typo.status_code == 400
    listed = client.post(
        url, json={"script": "train.py", "config_text": "- 1\n"}
    )
    assert listed.status_code == 400
    assert "項目: 値" in listed.json()["detail"]
    assert "/tmp" not in listed.json()["detail"]
    moved = client.post(url, json={
        "script": "train.py",
        "config_text": "experiment:\n  output_dir: elsewhere\n"
    })
    assert moved.status_code == 400
    assert "output_dir" in moved.json()["detail"]
    both = client.post(url, json={
        "script": "train.py", "config_text": "{}\n",
        "config_path": "configs/experiment/train.yaml"
    })
    assert both.status_code == 422

    jobs_dir = tmp_path / "home" / "jobs"
    assert not jobs_dir.exists() or list(jobs_dir.iterdir()) == []


def test_edited_config_text(client: TestClient, project_dir: Path) -> None:
    """
    画面で書き換えた config の中身をジョブの情報で返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "train.py").write_text("print('done')\n")
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epochs: 4\n"}
    ).json()
    assert created["config_text"] == "trainer:\n  epochs: 4\n"
    job = wait_for(client, created["id"], "status", "finished")
    assert job["return_code"] == 0

    # プロジェクトの config で起動した場合は中身を返さない
    plain = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    ).json()
    assert plain["config_text"] is None
    wait_for(client, plain["id"], "status", "finished")

    # 同じ設定でもう一度: 書き換えた config は中身を, プロジェクトの config は
    # 同じファイルを使う
    again = client.post(f"/api/jobs/{created['id']}/rerun")
    assert again.status_code == 201
    assert again.json()["config_text"] == "trainer:\n  epochs: 4\n"
    assert again.json()["id"] != created["id"]
    wait_for(client, again.json()["id"], "status", "finished")
    plain_again = client.post(f"/api/jobs/{plain['id']}/rerun").json()
    assert plain_again["config_text"] is None
    assert plain_again["config"] == plain["config"]
    wait_for(client, plain_again["id"], "status", "finished")
    assert client.post("/api/jobs/missing/rerun").status_code == 404


def test_registry_and_required_params(
    client: TestClient, project_dir: Path
) -> None:
    """
    登録簿と, 必須の引数の不足を注意として返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    registry = client.get("/api/registry").json()
    adam = next(
        item for item in registry["optimizers"] if item["name"] == "Adam"
    )
    assert any(param["name"] == "lr" for param in adam["params"])

    # スクリプトが補う可能性がある必須の引数の不足は注意, 名前の誤りはエラー
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    missing = client.post(
        url, json={"text": "scheduler:\n  name: StepLR\n  params: {}\n"}
    ).json()
    assert missing["ok"] is True
    assert "step_size" in missing["warnings"][0]
    assert missing["config"]["scheduler"]["name"] == "StepLR"
    typo = client.post(
        url, json={"text": "optimizer:\n  params:\n    lerning_rate: 1\n"}
    ).json()
    assert typo["ok"] is False
    assert "lerning_rate" in typo["error"]


def test_validate_custom_optimizer(
    client: TestClient, project_dir: Path
) -> None:
    """
    プロジェクトの中の自作の Optimizer を確かめられることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "my_optim_for_test.py").write_text(
        "from torch import optim\n\n\nclass Mine(optim.SGD):\n    pass\n"
    )
    project_id = register(client, project_dir)
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: my_optim_for_test.Mine\n"}
    ).json()
    assert result["ok"] is True, result["error"]


# 同じ名前のモジュールを持つプロジェクトの自作の Optimizer (lr の下限は
# 同じ名前の別のモジュールから読み込み)
SAME_OPTIM = '''\
from torch import optim

from same_helper import LR_FLOOR


class Mine(optim.SGD):
    def __init__(self, params, lr=0.1):
        if lr < LR_FLOOR:
            raise ValueError(f"lr は {LR_FLOOR} 以上にしてください")
        super(Mine, self).__init__(params, lr=lr)


class Sched(optim.lr_scheduler.StepLR):
    def __init__(self, optimizer, step_size=1, gamma=0.5):
        if gamma < LR_FLOOR:
            raise ValueError(f"gamma は {LR_FLOOR} 以上にしてください")
        super(Sched, self).__init__(optimizer, step_size, gamma)
'''


def write_same_modules(project: Path, floor: float) -> None:
    """
    同じ名前の自作の Optimizer のモジュールをプロジェクトに書く関数

    Parameters
    ----------
    project: Path
        プロジェクトのディレクトリ
    floor: float
        Optimizer が受け付ける lr の下限

    Returns
    ----------
    None
    """
    (project / "same_optim.py").write_text(SAME_OPTIM)
    (project / "same_helper.py").write_text(f"LR_FLOOR = {floor}\n")


def test_validate_same_module_names(
    client: TestClient, project_dir: Path
) -> None:
    """
    同じ名前のモジュールを持つ 2 つのプロジェクトを順に確かめると, それぞれの
    モジュールを読むことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    other_dir = project_dir.parent / "other_task"
    shutil.copytree(project_dir, other_dir)
    write_same_modules(project_dir, 0.5)
    write_same_modules(other_dir, 0.0)
    strict_id = register(client, project_dir)
    loose_id = register(client, other_dir)
    text = "optimizer:\n  name: same_optim.Mine\n  params:\n    lr: 0.2\n"

    # 下限の違いで, どちらのプロジェクトのモジュールを読んだかを判定
    # (順を入れ替えても前に読んだものを使わないことも確認)
    for project_id, ok in [
        (strict_id, False), (loose_id, True), (strict_id, False)
    ]:
        result = client.post(
            f"/api/projects/{project_id}/validate", json={"text": text}
        ).json()
        assert result["ok"] is ok, result
        if not ok:
            assert "lr は 0.5 以上" in result["error"]

    # 見つからないクラスの誤りは, 書いた名前のまま表示
    missing = client.post(
        f"/api/projects/{loose_id}/validate",
        json={"text": "optimizer:\n  name: same_optim.Missing\n"}
    ).json()
    assert missing["ok"] is False
    assert "same_optim.Missing が見つかりません" in missing["error"]


def test_validate_keeps_import_state(
    client: TestClient, project_dir: Path
) -> None:
    """
    確かめの後に sys.path と sys.modules が元のままであることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    write_same_modules(project_dir, 0.0)
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = "optimizer:\n  name: same_optim.Mine\n  params:\n    lr: 0.2\n"

    # 初めの確かめで ML-Found と PyTorch を読んでから, 前後を比較
    assert client.post(url, json={"text": text}).json()["ok"] is True
    path, modules = list(sys.path), set(sys.modules)
    finders = list(sys.meta_path)
    assert client.post(url, json={"text": text}).json()["ok"] is True
    assert sys.path == path
    assert set(sys.modules) == modules
    assert sys.meta_path == finders
    assert "same_optim" not in sys.modules
    assert "same_helper" not in sys.modules


def test_validate_custom_scheduler_and_named(
    client: TestClient, project_dir: Path
) -> None:
    """
    自作の Scheduler と名前付きの Optimizer の自作のクラスも, プロジェクトの
    モジュールで確かめ, 誤りに書いた名前と Optimizer の名前を付けることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    write_same_modules(project_dir, 0.5)
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 自作の Scheduler の値の誤り (下限はプロジェクトのモジュールのもの)
    text = (
        "scheduler:\n  name: same_optim.Sched\n  params:\n"
        "    gamma: 0.1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "gamma は 0.5 以上" in result["error"]
    ok = text.replace("0.1", "0.9")
    assert client.post(url, json={"text": ok}).json()["ok"] is True

    # 名前付きの Optimizer は, 名前を付けた誤り
    with (project_dir / "configs" / "default" / "train.yaml").open("a") as f:
        f.write("optimizers:\n  main:\n    name: Adam\n    modules: [net]\n")
    text = (
        "optimizers:\n  main:\n    name: same_optim.Mine\n"
        "    params:\n      lr: 0.2\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "lr は 0.5 以上" in result["error"]
    missing = text.replace("same_optim.Mine", "same_optim.Missing")
    result = client.post(url, json={"text": missing}).json()
    assert result["ok"] is False
    assert "optimizers.main" in result["error"]
    assert "same_optim.Missing が見つかりません" in result["error"]
    assert "same_optim" not in sys.modules


def test_validate_resolves_like_training(
    client: TestClient, project_dir: Path
) -> None:
    """
    自作のクラスのモジュールを, 学習と同じ探し方で読むことを確かめる関数

    名前空間のパッケージ, パッケージの中の相対 import, importlib で読む
    モジュールは読め, 最上位のモジュールの相対 import は学習と同じく誤り

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # __init__.py の無いディレクトリと, その中から読むモジュール
    (project_dir / "nspkg").mkdir()
    (project_dir / "lib").mkdir()
    (project_dir / "lib" / "h.py").write_text("FLOOR = 0.0\n")
    (project_dir / "hh.py").write_text("SCALE = 1.0\n")
    (project_dir / "nspkg" / "opt.py").write_text(
        "import importlib\n\nfrom torch import optim\n\n"
        "from lib.h import FLOOR\n\n"
        "SCALE = importlib.import_module('hh').SCALE\n\n\n"
        "class Mine(optim.SGD):\n    pass\n"
    )

    # パッケージの中の相対 import
    (project_dir / "pkgopt").mkdir()
    (project_dir / "pkgopt" / "__init__.py").write_text("")
    (project_dir / "pkgopt" / "base.py").write_text(
        "from torch import optim\n\n\nclass Base(optim.SGD):\n    pass\n"
    )
    (project_dir / "pkgopt" / "core.py").write_text(
        "from .base import Base\n\n\nclass Mine(Base):\n    pass\n"
    )

    # 最上位のモジュールの相対 import (学習でも読めない)
    (project_dir / "toprel.py").write_text(
        "from . import hh\n\n\nclass Mine:\n    pass\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    for name, ok in [
        ("nspkg.opt.Mine", True), ("pkgopt.core.Mine", True),
        ("toprel.Mine", False)
    ]:
        text = f"optimizer:\n  name: {name}\n"
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is ok, (name, result)
    for name in ["nspkg", "lib", "hh", "pkgopt", "toprel"]:
        assert name not in sys.modules


def test_validate_reports_import_error(
    client: TestClient, project_dir: Path
) -> None:
    """
    自作のモジュールの読み込みのエラーを, 種類を付けて返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "broken_optim.py").write_text("undefined_name\n")
    (project_dir / "exit_optim.py").write_text(
        "import sys\n\nsys.exit(3)\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    result = client.post(
        url, json={"text": "optimizer:\n  name: broken_optim.Mine\n"}
    ).json()
    assert result["ok"] is False
    assert "NameError" in result["error"]
    assert "undefined_name" in result["error"]
    assert "broken_optim" not in sys.modules

    # 結果を書かずに終わったプロセスは, 終了コードを添えた誤り
    result = client.post(
        url, json={"text": "optimizer:\n  name: exit_optim.Mine\n"}
    ).json()
    assert result["ok"] is False
    assert "終了コード 3" in result["error"]


def validate_ok(client: TestClient, project_id: str, text: str) -> bool:
    """
    config を確かめ, 起動できるかを返す関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_id: str
        プロジェクトの ID
    text: str
        experiment の config の中身

    Returns
    ----------
    ok: bool
        誤りが無ければ True
    """
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    ok: bool = result["ok"]

    return ok


class CustomCheckError(Exception):
    pass


def test_validate_concurrently(
    client: TestClient, project_dir: Path
) -> None:
    """
    同じ名前のモジュールを持つ 2 つのプロジェクトを同時に確かめても,
    それぞれのモジュールを読むことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    other_dir = project_dir.parent / "other_task"
    shutil.copytree(project_dir, other_dir)
    write_same_modules(project_dir, 0.5)
    write_same_modules(other_dir, 0.0)
    ids = [register(client, project_dir), register(client, other_dir)] * 2
    text = "optimizer:\n  name: same_optim.Mine\n  params:\n    lr: 0.2\n"

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(
            partial(validate_ok, client, text=text), ids
        ))
    assert results == [False, True, False, True]


def test_rebuilt_exception_keeps_message() -> None:
    """
    確かめのプロセスから受け取ったエラーの表示が, 元のエラーと同じになる
    ことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    try:
        try:
            raise ModuleNotFoundError("No module named 'x'")
        except ImportError as error:
            raise ValueError("x.Lion が見つかりません") from error
    except ValueError as error:
        chained = error
    errors: list[Exception] = [
        chained, CustomCheckError("自作の誤り"), KeyError("lr"),
        UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
    ]
    for error in errors:
        rebuilt = rebuild_exception(describe_exception(error))
        assert describe(rebuilt) == describe(error)
        assert str(rebuilt) == str(error)


# 孫のプロセスを起こし, その pid を書く自作の Optimizer のモジュール
# (標準エラー出力を受け継ぐ. 待つ秒数は後で埋める)
SPAWN_OPTIM = '''\
import subprocess
import time
from pathlib import Path

from torch import optim

child = subprocess.Popen(["sleep", "30"])
Path("grandchild.pid").write_text(str(child.pid))
time.sleep({wait})


class Mine(optim.SGD):
    pass
'''


def is_gone(pid: int) -> bool:
    """
    プロセスが 5 秒以内に無くなるかを返す関数

    Parameters
    ----------
    pid: int
        プロセスの ID

    Returns
    ----------
    gone: bool
        無くなった場合は True
    """
    gone = False
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except OSError:
            gone = True
            break
        time.sleep(0.1)

    return gone


def test_validate_with_grandchild(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    自作のモジュールが孫のプロセスを起こしても, 待ち切りを待たずに結果を
    受け取り, 孫のプロセスを止めることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        待ち切りの秒数の差し替えに使用

    Returns
    ----------
    None
    """
    monkeypatch.setattr(check_process, "CHECK_TIMEOUT", 20)
    (project_dir / "spawn_optim.py").write_text(SPAWN_OPTIM.format(wait=0))
    project_id = register(client, project_dir)

    started = time.monotonic()
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: spawn_optim.Mine\n"}
    ).json()
    assert result["ok"] is True, result
    assert time.monotonic() - started < 15
    pid = int((project_dir / "grandchild.pid").read_text())
    assert is_gone(pid)


def test_validate_timeout(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    終わらない確かめを待ち切りで誤りにし, 孫のプロセスごと止めることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        待ち切りの秒数の差し替えに使用

    Returns
    ----------
    None
    """
    monkeypatch.setattr(check_process, "CHECK_TIMEOUT", 10)
    (project_dir / "spawn_optim.py").write_text(SPAWN_OPTIM.format(wait=60))
    project_id = register(client, project_dir)

    started = time.monotonic()
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: spawn_optim.Mine\n"}
    ).json()
    assert result["ok"] is False
    assert "10 秒で終わりませんでした" in result["error"]
    assert time.monotonic() - started < 30
    pid = int((project_dir / "grandchild.pid").read_text())
    assert is_gone(pid)


def test_validate_ignores_prints(
    client: TestClient, project_dir: Path
) -> None:
    """
    自作のモジュールの print が確かめの結果を壊さないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "noisy_optim.py").write_text(
        "import sys\n\nfrom torch import optim\n\n"
        "print('{\"error\": 1}')\nprint('not json', file=sys.stderr)\n\n\n"
        "class Mine(optim.SGD):\n    pass\n"
    )
    project_id = register(client, project_dir)
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: noisy_optim.Mine\n"}
    ).json()
    assert result["ok"] is True, result


def test_uses_custom_classes() -> None:
    """
    別のプロセスで確かめる config の見分け方を確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    cases = [
        ({"optimizer": {"name": "Adam"}}, False),
        ({"optimizer": {"name": "torch.optim.AdamW"}}, False),
        ({"scheduler": {"name": "torch.optim.lr_scheduler.StepLR"}}, False),
        ({"optimizer": {"name": "custom_optim.Lion"}}, True),
        ({"scheduler": {"name": "my_sched.Warm"}}, True),
        ({"optimizers": {"main": {"name": "custom_optim.Lion"}}}, True),
        ({"optimizers": {"main": {"scheduler": {"name": "s.W"}}}}, True),
        # 値の参照を解決できない名前は, 読み込む場合に備えて別のプロセス
        ({"optimizer": {"name": "${missing.name}"}}, True)
    ]
    for content, custom in cases:
        cfg = OmegaConf.create(content)
        assert uses_custom_classes(cfg) is custom, content


def test_validate_torch_class_in_process(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    torch. で始まる名前は, 別のプロセスを使わずに確かめることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        別のプロセスの確かめの差し替えに使用

    Returns
    ----------
    None
    """
    monkeypatch.setattr(jobs, "run_check_process", fail_check_process)
    project_id = register(client, project_dir)
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: torch.optim.AdamW\n"}
    ).json()
    assert result["ok"] is True, result


def fail_check_process(*args: Any) -> None:
    """
    別のプロセスの確かめが呼ばれたらテストを失敗させる関数

    Parameters
    ----------
    *args: Any
        確かめの引数 (使わない)

    Returns
    ----------
    None
    """
    raise AssertionError("別のプロセスで確かめました")


def test_default_config_per_script(
    client: TestClient, project_dir: Path
) -> None:
    """
    学習のスクリプトごとに default の config を選ぶことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # train_hf.py は hf.yaml, train_big.py は対応が無いので train.yaml
    (project_dir / "configs" / "default" / "hf.yaml").write_text(
        "experiment:\n  name: demo_hf\n  output_dir: outputs_hf\n"
        "data:\n  n_train: 10\n"
    )
    (project_dir / "train_hf.py").write_text("print('hf')\n")
    (project_dir / "train_big.py").write_text("print('big')\n")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = "data:\n  n_train: 20\n"

    hf = client.post(url, json={"text": text, "script": "train_hf.py"}).json()
    assert hf["ok"] is True
    assert hf["default_config"] == "configs/default/hf.yaml"
    assert hf["diff"]["data.n_train"]["default"] == 10

    # train.yaml には data.n_train が無いのでエラー
    plain = client.post(url, json={"text": text, "script": "train.py"}).json()
    assert plain["ok"] is False
    assert "data" in plain["error"]
    assert plain["default_config"] == "configs/default/train.yaml"
    big = client.post(url, json={"text": "{}\n", "script": "train_big.py"})
    assert big.json()["default_config"] == "configs/default/train.yaml"

    # 一覧に無いスクリプトは受け付けない
    missing = client.post(url, json={"text": "{}\n", "script": "other.py"})
    assert missing.status_code == 400

    # 起動の前の確認も同じ default の config を使用
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train_hf.py", "config_text": text}
    )
    assert created.status_code == 201
    wait_for(client, created.json()["id"], "status", "finished")
    rejected = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": text}
    )
    assert rejected.status_code == 400

    # 別の default の config の出力先の実験も探す対象
    output_dirs = client.get(f"/api/projects/{project_id}").json()
    assert any(
        path.endswith("outputs_hf") for path in output_dirs["output_dirs"]
    )


def test_validate_param_ranges(client: TestClient, project_dir: Path) -> None:
    """
    範囲の外の引数が確認のエラーになり, 登録簿が端を含まない範囲を返すことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = (
        "scheduler:\n  name: ReduceLROnPlateau\n  params:\n    factor: 1.0\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "factor は 0.0 以上 1.0 未満" in result["error"]
    # フォームで直せるように, 読み込めた config も返却
    assert result["config"]["scheduler"]["params"]["factor"] == 1.0

    # 起動もエラー
    (project_dir / "train.py").write_text("print('train')\n")
    launched = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": text}
    )
    assert launched.status_code == 400
    assert "factor" in launched.json()["detail"]

    # 必須の引数の不足 (注意) があっても, 範囲の外の値はエラー
    text = (
        "scheduler:\n  name: StepLR\n  params:\n    gamma: -1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "gamma は 0.0 以上" in result["error"]

    # 範囲を持たない引数の組み合わせの誤りも, 作ってみて確認のエラー
    text = (
        "optimizer:\n  name: SGD\n  params:\n    lr: 0.1\n"
        "    nesterov: true\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "SGD を作れません: ValueError: Nesterov" in result["error"]
    assert result["error"].count("ValueError") == 1
    assert result["config"]["optimizer"]["params"]["nesterov"] is True

    # 使えないデバイスは, 必須の引数の不足 (注意) があっても値の誤り
    text = (
        "experiment:\n  device: gpu\n"
        "scheduler:\n  name: StepLR\n  params:\n    gamma: 0.5\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "experiment.device の誤り" in result["error"]

    registry = client.get("/api/registry").json()
    plateau = next(
        spec for spec in registry["schedulers"]
        if spec["name"] == "ReduceLROnPlateau"
    )
    factor = next(
        param for param in plateau["params"] if param["name"] == "factor"
    )
    assert factor["exclusive_maximum"] is True
    assert factor["exclusive_minimum"] is False


def test_validate_precision_and_accumulation(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    計算の精度, 勾配の蓄積, 始める前に読む重みを ML-Found で確かめることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        bf16 を使えないデバイスの代わりに確かめの関数を差し替えるのに使用

    Returns
    ----------
    None
    """
    import ml_found.experiment
    import torch

    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 既定は fp32 で毎バッチ更新, cpu では bf16 も使える
    result = client.post(url, json={"text": "{}\n"}).json()
    assert result["ok"] is True, result["error"]
    assert result["config"]["trainer"]["precision"] == "fp32"
    assert result["config"]["trainer"]["accumulate_grad_batches"] == 1
    text = (
        "experiment:\n  device: cpu\n"
        "trainer:\n  precision: bf16\n  accumulate_grad_batches: 4\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    assert result["diff"]["trainer.precision"]["experiment"] == "bf16"
    assert result["diff"]["trainer.accumulate_grad_batches"]["experiment"] == 4

    # 値の誤りと組み合わせの誤りは check_trainer_config のエラー
    for text, expected in [
        ("trainer:\n  precision: fp16\n", "trainer.precision"),
        ("trainer:\n  accumulate_grad_batches: 0\n",
         "trainer.accumulate_grad_batches"),
        ("optimizer:\n  name: LBFGS\n  params:\n    lr: 0.1\n"
         "trainer:\n  accumulate_grad_batches: 2\n",
         "trainer.accumulate_grad_batches"),
    ]:
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is False
        assert expected in result["error"]

    # デバイスで bf16 を使えない場合は, config も返す値の誤り (フォームで直す)
    devices: list[torch.device] = []

    def unsupported(cfg: object, device: torch.device) -> None:
        devices.append(device)
        raise ValueError(f"trainer.precision: bf16 は {device} で使えません")

    monkeypatch.setattr(ml_found.experiment, "check_precision", unsupported)
    text = "experiment:\n  device: cpu\ntrainer:\n  precision: bf16\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert result["error"] == "trainer.precision: bf16 は cpu で使えません"
    assert result["config"]["trainer"]["precision"] == "bf16"
    assert devices == [torch.device("cpu")]

    # cuda と mps では GPU の文脈を持たないように不使用 (学習のプロセスで確認)
    for name in ["cuda", "mps"]:
        monkeypatch.setattr(
            "ml_found.utils.get_device",
            lambda value, name=name: torch.device(name)
        )
        text = (
            f"experiment:\n  device: {name}\ntrainer:\n  precision: bf16\n"
        )
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is True, result["error"]
        assert result["config"]["trainer"]["precision"] == "bf16"
    assert devices == [torch.device("cpu")]
    monkeypatch.undo()

    # 始める前に読む重みは, 無いファイルと重みの辞書でないファイルがエラー
    text = "trainer:\n  init_weights:\n    path: weights/missing.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "weights/missing.pt" in result["error"]
    (project_dir / "weights").mkdir()
    torch.save([1, 2], project_dir / "weights" / "list.pt")
    text = "trainer:\n  init_weights:\n    path: weights/list.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    torch.save(
        torch.nn.Linear(2, 1).state_dict(), project_dir / "weights" / "ok.pt"
    )
    text = "trainer:\n  init_weights:\n    path: weights/ok.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    assert result["warnings"] == []


def test_validate_notes_filled_scheduler(
    client: TestClient, project_dir: Path
) -> None:
    """
    ML-Found が補う Scheduler の引数を, 注意ではなくお知らせで返すことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    text = (
        "scheduler:\n  name: OneCycleLR\n  interval: step\n  params:\n"
        "    max_lr: 0.1\n"
    )
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["ok"] is True
    assert result["warnings"] == []
    assert "epochs は, 学習を始めるときに ML-Found が trainer.epochs" in (
        result["notes"][0]
    )
    assert "学習用データのバッチ数" in result["notes"][1]

    # OneCycleLR の epochs が trainer.epochs より少なければ誤り, 多ければ注意
    for epochs, ok in ((1, False), (100_000, True)):
        result = client.post(
            f"/api/projects/{project_id}/validate",
            json={"text": text + f"    epochs: {epochs}\n"}
        ).json()
        assert result["ok"] is ok
        if not ok:
            assert "trainer.epochs" in result["error"]
        else:
            assert "下がりきりません" in result["warnings"][0]

    # 総ステップ数を書いた場合はお知らせなし
    text += "    total_steps: 10\n"
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["notes"] == []

    # auto と書いた引数は, 学習全体のステップ数で補うお知らせ
    text = (
        "scheduler:\n  name: CosineAnnealingLR\n  interval: step\n"
        "  params:\n    T_max: auto\n"
    )
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["ok"] is True
    assert result["notes"] == [
        "CosineAnnealingLR の T_max は, 学習を始めるときに ML-Found が"
        " trainer.epochs × 学習用データのバッチ数 (学習全体のステップ数) に"
        "します"
    ]

    # warmup の割合を書いた場合は, auto は残りで, 回数に直すこともお知らせ
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": text + "  warmup_ratio: 0.1\n"}
    ).json()
    assert result["ok"] is True
    assert "warmup の後の残り" in result["notes"][0]
    assert "0.1 倍" in result["notes"][1]

    # auto と書けない引数 (範囲を持たない eta_min) は値の誤り
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": text + "    eta_min: auto\n"}
    ).json()
    assert result["ok"] is False
    assert "eta_min には auto と書けません" in result["error"]


def test_validate_named_optimizers(
    client: TestClient, project_dir: Path
) -> None:
    """
    名前付きの複数の Optimizer (optimizers) の config で, 引数の範囲の誤りと
    補う Scheduler の引数のお知らせを, 名前を付けて返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # default を名前付きの 2 つの Optimizer に変更
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "optimizers:\n"
        "  discriminator:\n    name: Adam\n    modules: [discriminator]\n"
        "  generator:\n    name: Adam\n    modules: [generator]\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 範囲の外の値は, どの Optimizer かを付けた誤り
    text = "optimizers:\n  generator:\n    params:\n      lr: -1\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "optimizers.generator" in result["error"]
    assert "lr は 0.0 以上" in result["error"]

    # Scheduler の auto は, 名前を付けたお知らせ
    text = (
        "optimizers:\n  generator:\n    scheduler:\n"
        "      name: CosineAnnealingLR\n      params:\n        T_max: auto\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True
    assert result["notes"][0].startswith("optimizers.generator: ")
    assert "T_max" in result["notes"][0]

    # 1 つ目の必須の引数の不足 (注意) があっても, 2 つ目の名前の誤りはエラー
    text = (
        "optimizers:\n  discriminator:\n    scheduler:\n      name: StepLR\n"
        "  generator:\n    params:\n      lrr: 0.1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "optimizers.generator" in result["error"]
    assert "lrr" in result["error"]

    # trainer の値の参照 (${...}) も, 名前ごとの確認で解決
    text = (
        "trainer:\n  epochs: ${experiment.seed}\n"
        "optimizers:\n  generator:\n    scheduler:\n"
        "      name: OneCycleLR\n      params:\n        max_lr: 0.1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert "InterpolationKeyError" not in (result.get("error") or "")

    # 一番上の optimizer は書けない
    result = client.post(
        url, json={"text": "optimizer:\n  name: SGD\n"}
    ).json()
    assert result["ok"] is False
    assert "optimizers.<名前>" in result["error"]


def test_validate_missing_paths(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    パスの項目のファイルが無い場合に, 起動を止めずに注意することを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    (project_dir / "data").mkdir()
    (project_dir / "data" / "train.csv").write_text("x\n")
    outside = tmp_path / "absent.csv"

    # default の項目も対象 (experiment で書き換えた値で確認)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n"
        "  train_path: data/train.csv\n"
        "  valid_path: data/train.csv\n"
        "  cache_dir: cache\n"
        "  Vocab_FILE: ''\n"
        "  test_file: null\n"
        "  remote_path: https://example.com/train.csv\n"
        "  ref_path: ${data.valid_path}\n"
        "  sizes_path: 3\n"
        "  splits: [missing.csv]\n"
        "  data_dir: data\n"
        "  profile: simple\n"
        "  model_name_or_path: org/model\n"
        "  home_dir: '~'\n"
        "  user_dir: ~no_such_user_for_test/data\n"
    )
    text = (
        "data:\n"
        "  valid_path: data/valid.csv\n"
        f"  test_file: {outside}\n"
    )
    result = client.post(url, json={"text": text}).json()

    # 無いものだけを注意, 相対パスにはプロジェクトのディレクトリからと明記
    assert result["ok"] is True, result["error"]
    assert result["warnings"] == [
        "data.cache_dir のディレクトリが見つかりません: cache "
        "(プロジェクトのディレクトリから)",
        f"data.test_file のファイルが見つかりません: {outside}",
        "data.user_dir のディレクトリが見つかりません: "
        "~no_such_user_for_test/data (プロジェクトのディレクトリから)",
        "data.valid_path のファイルが見つかりません: data/valid.csv "
        "(プロジェクトのディレクトリから)"
    ]

    # ML-Found が作る出力先と, ML-Found が確かめる再開元は対象外
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: not_yet\n"
    )
    result = client.post(url, json={"text": "{}\n"}).json()
    assert result["ok"] is True
    assert result["warnings"] == []
    resume = client.post(
        url, json={"text": "trainer:\n  resume_from: missing/last.pt\n"}
    ).json()
    assert resume["ok"] is False
    assert "resume_from" in resume["error"]

    # 再開元はファイルが無くても, パスの確認では注意にしない
    assert describe_missing_path(
        "trainer.resume_from", "missing/last.pt", project_dir
    ) is None


def test_relaunch_plan(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    実験の起動のしかたから, もう一度起動する設定をまとめることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    url = (
        f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/relaunch"
    )
    source = run_dir / "source.yaml"

    def plan(text: str) -> dict:
        source.write_text(text)
        # 後から書き換えたファイルと区別できるように, 古い時刻に設定
        os.utime(source, (0, 0))
        result: dict = client.get(url).json()
        return result

    # source.yaml の無い実験は, 理由だけ
    old = client.get(url).json()
    assert old["script"] is None
    assert "source.yaml" in old["reason"]
    # 理由は今の条件だけで, 版の経緯を書かない
    assert "古い" not in old["reason"]
    missing = client.get(
        f"/api/projects/{project_id}/runs/demo/2026-11-08/12-00-00/relaunch"
    )
    assert missing.status_code == 404

    # プロジェクトの config と上書き: config を選び, 上書きを重ねた中身
    examples = project_dir / "configs" / "experiment" / "examples"
    (examples / "a.yaml").write_text(
        "# 例\noptimizer:\n  name: Adam\n  params:\n    lr: 0.1\n"
    )
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/examples/a.yaml\n"
        "overrides:\n- trainer.epochs=3\n- optimizer.name=SGD\n"
    )
    assert result["reason"] is None
    assert result["script"] == "train.py"
    assert result["default_config"] == "configs/default/train.yaml"
    assert result["config_path"] == "configs/experiment/examples/a.yaml"
    # クラスを変える上書きは, ML-Found と同じく experiment の引数を捨てる
    assert OmegaConf.to_container(OmegaConf.create(result["config_text"])) == {
        "optimizer": {"name": "SGD", "params": {}},
        "trainer": {"epochs": 3}
    }
    assert any("trainer.epochs=3" in note for note in result["notes"])
    assert any("書き換えられています" in note for note in result["notes"])

    # 上書きが無ければ, ファイルの中身そのまま
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\noverrides: []\n"
    )
    assert result["config_text"] == "{}\n"
    assert result["config_path"] == "configs/experiment/train.yaml"

    # 画面から起動した学習の config (ジョブの置き場) は中身だけ
    job_config = tmp_path / "home" / "jobs" / "0123456789ab" / "a.yaml"
    job_config.parent.mkdir(parents=True)
    job_config.write_text("trainer:\n  epochs: 2\n")
    result = plan(
        f"script: train.py\ndefault: configs/default/train.yaml\n"
        f"experiment: {job_config.resolve()}\noverrides: []\n"
    )
    assert result["reason"] is None
    assert result["config_path"] is None
    assert result["config_text"] == "trainer:\n  epochs: 2\n"

    # プロジェクトとジョブの置き場の外, 無いファイル, 出力先の変更は理由
    outside = tmp_path / "outside.yaml"
    outside.write_text("{}\n")
    for experiment, message in (
        (str(outside), "だけを読みます"),
        ("../outside.yaml", "だけを読みます"),
        ("train.py", "だけを読みます"),
        ("configs/experiment/gone.yaml", "見つかりません")
    ):
        result = plan(
            f"script: train.py\ndefault: configs/default/train.yaml\n"
            f"experiment: {experiment}\n"
        )
        assert message in result["reason"]
        assert result["config_text"] is None
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
        "overrides:\n- experiment.output_dir=elsewhere\n"
    )
    assert "output_dir" in result["reason"]

    # 無いスクリプト, 記録の無いスクリプトと config も理由
    result = plan("script: train_gone.py\n")
    assert "train_gone.py" in result["reason"]
    result = plan("script: null\ndefault: configs/default/train.yaml\n")
    assert "スクリプト" in result["reason"]
    result = plan("script: train.py\ndefault: null\nexperiment: null\n")
    assert result["script"] == "train.py"
    assert "load_config" in result["reason"]

    # configs/default に無い default は使わず, お知らせ
    result = plan(
        "script: train.py\ndefault: /elsewhere/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
    )
    assert result["reason"] is None
    assert result["default_config"] is None
    assert any("/elsewhere/train.yaml" in note for note in result["notes"])


def test_relaunch_model_spec(
    client: TestClient, project_dir: Path
) -> None:
    """
    実験に写したモデルの定義が記録と合えば, その写しで起動し直し, 使えない
    場合は今の定義に戻すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    relative = "outputs/demo/2026-11-08/10-00-00"
    run_dir = project_dir / relative
    url = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/relaunch"
    copy = run_dir / "model_spec.yaml"
    content = b"layers:\n- type: Linear\n"
    copy.write_bytes(content)
    sha = hashlib.sha256(content).hexdigest()
    experiment = project_dir / "configs" / "experiment" / "train.yaml"
    experiment.write_text(
        "# 例\nmodel:\n  spec: models/model.yaml\n  hidden_dim: 8\n"
    )

    def plan(status: str = "copied", digest: str = sha) -> dict:
        (run_dir / "source.yaml").write_text(
            "script: train.py\ndefault: configs/default/train.yaml\n"
            "experiment: configs/experiment/train.yaml\n"
            "model_spec:\n  path: models/model.yaml\n"
            f"  status: {status}\n  sha256: '{digest}'\n"
        )
        result: dict = client.get(url).json()
        assert result["reason"] is None
        return result

    # 記録と合う写しは, model.spec をその場所に書き換えて使う. 戻す値は
    # experiment の config の今の値
    result = plan()
    assert result["model_spec"] == f"{relative}/model_spec.yaml"
    assert result["model_spec_original"] == "models/model.yaml"
    assert result["config_path"] == "configs/experiment/train.yaml"
    assert OmegaConf.to_container(OmegaConf.create(result["config_text"])) == {
        "model": {
            "spec": f"{relative}/model_spec.yaml", "hidden_dim": 8
        }
    }
    assert "この実験に写した定義" in result["model_spec_note"]
    assert "models/model.yaml" in result["model_spec_note"]
    assert not any("モデルの定義" in note for note in result["notes"])

    # 中身が記録と違う写し, 写していない実験, 知らない status は今の定義
    for status, digest, message in (
        ("copied", "0" * 64, "中身が"),
        ("missing", sha, "定義のファイルが無い"),
        ("renamed", sha, "(renamed)"),
    ):
        result = plan(status, digest)
        assert result["model_spec"] is None
        assert result["model_spec_note"] is None
        assert "spec: models/model.yaml" in result["config_text"]
        assert any(
            "今のプロジェクトの models/model.yaml" in note
            and message in note for note in result["notes"]
        ), status

    # 外部の重みのファイルを読む定義と, 16 MiB を超える写しは今の定義
    for text, message in (
        (b"nodes:\n  a:\n    weights: {path: w.pt}\n", "weights.path"),
        (b"x" * (16 * 1024 * 1024 + 1), "16 MiB"),
        # 自分を指す別名, 重ねた別名, 深い入れ子でも止まらない
        (b"nodes: &n {a: *n}\n", "別名"),
        (
            b"a: &a [x, x, x, x, x, x, x, x, x]\n" + b"".join(
                f"{chr(98 + index)}: &{chr(98 + index)} "
                f"[*{chr(97 + index)}, *{chr(97 + index)}, "
                f"*{chr(97 + index)}]\n".encode()
                for index in range(20)
            ), "別名"
        ),
        (b"[" * 5000 + b"]" * 5000 + b"\n", "100 段"),
        # 辞書の 1 段と並びの 100 段で, 上限の 100 段を超える
        (b"a: " + b"[" * 100 + b"]" * 100 + b"\n", "100 段"),
        (
            b"nodes:\n  a: {weights: {path: first.pt}}\n"
            b"  b: {weights: {path: second.pt}}\n", "first.pt"
        ),
    ):
        copy.write_bytes(text)
        result = plan(digest=hashlib.sha256(text).hexdigest())
        assert result["model_spec"] is None
        assert any(message in note for note in result["notes"])
    copy.write_bytes(content)

    # model が辞書でない experiment の config も今の定義
    experiment.write_text("model: 3\n")
    result = plan()
    assert result["model_spec"] is None
    assert any("辞書ではありません" in note for note in result["notes"])

    # 写しから起動し直した実験の config (model.spec が写しを指す) で写しが
    # 使えなければ, model.spec を消して default の値に戻す
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "model:\n  spec: models/base.yaml\n"
    )
    experiment.write_text(
        f"model:\n  spec: {relative}/model_spec.yaml\n"
    )
    result = plan(digest="0" * 64)
    assert result["model_spec"] is None
    assert "spec" not in result["config_text"]
    assert any(
        "今のプロジェクトの models/base.yaml" in note
        for note in result["notes"]
    )
    # 使える場合は戻す値を消すこと (None) にする
    result = plan()
    assert result["model_spec"] == f"{relative}/model_spec.yaml"
    assert result["model_spec_original"] is None
    assert "models/base.yaml" in result["model_spec_note"]

    # 消えた実験の写しを指す config も, 出力先の下の model_spec.yaml なので
    # default の値に戻す
    experiment.write_text(
        "model:\n  spec: outputs/demo/2026-11-08/09-00-00/model_spec.yaml\n"
    )
    result = plan(digest="0" * 64)
    assert "spec" not in result["config_text"]

    # 今の定義が記録と同じ中身か違う中身かを言い切る
    (project_dir / "models").mkdir()
    (project_dir / "models" / "base.yaml").write_bytes(content)
    result = plan(status="missing")
    assert any(
        "記録と同じ中身です. 外部の重みのファイルは比べていません" in note
        for note in result["notes"]
    )
    (project_dir / "models" / "base.yaml").write_bytes(b"layers: []\n")
    result = plan(status="missing")
    assert any("違うモデルになります" in note for note in result["notes"])

    # model_spec の無い実験は何も足さない
    experiment.write_text("{}\n")
    (run_dir / "source.yaml").write_text(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
    )
    result = client.get(url).json()
    assert result["model_spec"] is None
    assert result["model_spec_note"] is None
    assert not any("モデルの定義" in note for note in result["notes"])


def test_model_spec_copy_place(project_dir: Path, tmp_path: Path) -> None:
    """
    写しを使えない場所 (プロジェクトの外, 途中のリンク, 写しのリンク,
    ${ と ~) を見分けることを確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    content = b"layers: []\n"
    record = RunModelSpec(
        path="models/model.yaml", status="copied",
        sha256=hashlib.sha256(content).hexdigest()
    )

    def place(run_dir: Path) -> Optional[str]:
        run_dir.mkdir(parents=True, exist_ok=True)
        if not (run_dir / "model_spec.yaml").exists():
            (run_dir / "model_spec.yaml").write_bytes(content)
        path, reason = find_model_spec_copy(project_dir, run_dir, record)
        assert (path is None) != (reason is None)
        return reason

    # プロジェクトの中の普通の場所は使える
    assert place(project_dir / "outputs" / "ok") is None

    # 外と, 途中のリンクは理由を分ける
    outside = place(tmp_path / "outside_run")
    assert outside is not None and "外にあります" in outside
    (project_dir / "linked").symlink_to(
        tmp_path / "outside_run", target_is_directory=True
    )
    linked = place(project_dir / "linked")
    assert linked is not None and "途中にシンボリックリンク" in linked

    # 写し自体のリンクと, 無い写し
    run_dir = project_dir / "outputs" / "copy_link"
    run_dir.mkdir(parents=True)
    (run_dir / "model_spec.yaml").symlink_to(
        tmp_path / "outside_run" / "model_spec.yaml"
    )
    reason = place(run_dir)
    assert reason is not None and "写した定義 (model_spec.yaml) が" in reason
    assert "シンボリックリンクです" in reason
    (run_dir / "model_spec.yaml").unlink()
    path, reason = find_model_spec_copy(project_dir, run_dir, record)
    assert reason is not None and "ありません" in reason

    # config の参照とホームの展開に読まれる場所
    for name in ("${oops}", "~home"):
        reason = place(project_dir / name / "run")
        assert reason is not None and "書けません" in reason, name


def test_own_model_spec_name(client: TestClient, tmp_path: Path) -> None:
    """
    出力先が . のプロジェクトで, 自分の定義の models/model_spec.yaml を
    消えた実験の写しとみなさないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    project_dir = tmp_path / "dot_project"
    (project_dir / "configs" / "default").mkdir(parents=True)
    (project_dir / "configs" / "experiment").mkdir(parents=True)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: .\n"
        "model:\n  spec: models/model_spec.yaml\n"
    )
    (project_dir / "configs" / "experiment" / "train.yaml").write_text(
        "{}\n"
    )
    (project_dir / "models").mkdir()
    (project_dir / "models" / "model_spec.yaml").write_text("layers: []\n")
    (project_dir / "train.py").write_text("print('train')\n")
    assert run_of_copy(project_dir, "models/model_spec.yaml") is None
    # 実験の形 (<名前>/<日付>/<時刻>/) の深さなら, 消えた実験の写し
    assert run_of_copy(
        project_dir, "demo/2026-11-08/10-00-00/model_spec.yaml"
    ) == project_dir / "demo/2026-11-08/10-00-00"

    project_id = register(client, project_dir)
    response = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py",
            "config_text": "model:\n  spec: models/model_spec.yaml\n"
        }
    )
    assert response.status_code == 201, response.json()


def test_launch_rechecks_model_spec(
    client: TestClient, project_dir: Path
) -> None:
    """
    model.spec が実験に写した定義を指す起動では, 写しを確かめ直し, 記録と
    違えば起動しないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    relative = "outputs/demo/2026-11-08/10-00-00"
    run_dir = project_dir / relative
    content = b"layers: []\n"
    (run_dir / "model_spec.yaml").write_bytes(content)
    (run_dir / "source.yaml").write_text(
        "script: train.py\nmodel_spec:\n  path: models/model.yaml\n"
        f"  status: copied\n  sha256: '{hashlib.sha256(content).hexdigest()}'"
        "\n"
    )
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "model:\n  spec: models/model.yaml\n"
    )
    body = {
        "script": "train.py",
        "config_text": f"model:\n  spec: {relative}/model_spec.yaml\n"
    }

    # 起動の画面を開いた後に写しが書き換わった場合は起動しない
    (run_dir / "model_spec.yaml").write_bytes(b"layers: [changed]\n")
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 400
    assert "起動しません" in response.json()["detail"]
    assert "中身が" in response.json()["detail"]

    assert response.json()["code"] == "model_spec_copy_refused"

    # 消えた実験の写しを指す config も起動しない
    gone = {
        "script": "train.py",
        "config_text": (
            "model:\n  spec: outputs/demo/2026-11-08/09-00-00/"
            "model_spec.yaml\n"
        )
    }
    response = client.post(f"/api/projects/{project_id}/jobs", json=gone)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "その実験がありません" in detail
    assert detail.count("09-00-00") == 1

    # 別名を使う写しは, 500 にならず起動しない
    (run_dir / "model_spec.yaml").write_bytes(b"nodes: &n {a: *n}\n")
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 400

    # 記録と合えば起動する
    (run_dir / "model_spec.yaml").write_bytes(content)
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 201, response.json()


def test_launch_with_default_config(
    client: TestClient, project_dir: Path
) -> None:
    """
    起動の前の確認に, 指定した default の config を使うことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # train.py の名前からは train.yaml を選ぶが, hf.yaml を指定して確認
    (project_dir / "configs" / "default" / "hf.yaml").write_text(
        "experiment:\n  name: demo_hf\n  output_dir: outputs_hf\n"
        "data:\n  n_train: 10\n"
    )
    (project_dir / "train.py").write_text("print('done')\n")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = "data:\n  n_train: 20\n"
    body = {"text": text, "script": "train.py"}
    assert client.post(url, json=body).json()["ok"] is False
    hf = client.post(
        url, json=body | {"default_config": "configs/default/hf.yaml"}
    ).json()
    assert hf["ok"] is True
    assert hf["default_config"] == "configs/default/hf.yaml"

    # configs/default の外と, 無いファイルは受け付けない
    for bad in (
        "configs/experiment/train.yaml", "../outside.yaml",
        "configs/default/gone.yaml"
    ):
        rejected = client.post(url, json=body | {"default_config": bad})
        assert rejected.status_code == 400
    rejected = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py", "config_text": text,
            "default_config": "../train.yaml"
        }
    )
    assert rejected.status_code == 400

    # 起動したジョブに記録し, もう一度起動しても同じ default で確認
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py", "config_text": text,
            "default_config": "configs/default/hf.yaml"
        }
    )
    assert created.status_code == 201
    assert created.json()["default_config"] == "configs/default/hf.yaml"
    wait_for(client, created.json()["id"], "status", "finished")
    again = client.post(f"/api/jobs/{created.json()['id']}/rerun")
    assert again.status_code == 201
    assert again.json()["default_config"] == "configs/default/hf.yaml"
    wait_for(client, again.json()["id"], "status", "finished")


def test_validate_hides_env_values(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    環境変数を参照する config の確かめの応答に, その値が含まれないことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数を置き換える pytest の仕組み

    Returns
    ----------
    None
    """
    secret, other = "s3cr3t-token-value", "an0ther-hidden-value"
    monkeypatch.setenv("ML_DASHBOARD_TEST_SECRET", secret)
    monkeypatch.setenv("ML_DASHBOARD_TEST_OTHER", other)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n"
        "  token: plain\n  url: plain\n  alias: plain\n  nested: plain\n"
        "  tokens: []\n  name: plain\n"
        "  key: ${oc.env:ML_DASHBOARD_TEST_OTHER}\n"
        "  env_name: ML_DASHBOARD_TEST_SECRET\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # そのまま, 文字の中, 他の項目を介した参照, 入れ子, リストの中
    text = (
        "data:\n"
        "  token: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n"
        "  url: https://user:${oc.env:ML_DASHBOARD_TEST_SECRET}@example.com\n"
        "  alias: ${data.token}\n"
        "  nested: ${oc.env:ML_DASHBOARD_TEST_NONE,"
        "${oc.env:ML_DASHBOARD_TEST_SECRET}}\n"
        "  tokens: ['${oc.env:ML_DASHBOARD_TEST_SECRET}']\n"
        "  name: ${experiment.name}\n"
        "  key: changed\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    body = json.dumps(result)
    assert secret not in body
    assert other not in body

    # 書いたままの値を返し, 環境変数を引かない参照は解決
    data = result["config"]["data"]
    assert data["token"] == "${oc.env:ML_DASHBOARD_TEST_SECRET}"
    assert data["alias"] == "${data.token}"
    assert data["tokens"] == ["${oc.env:ML_DASHBOARD_TEST_SECRET}"]
    assert data["name"] == "demo"
    assert result["diff"]["data.url"] == {
        "default": "plain",
        "experiment": "https://user:${oc.env:ML_DASHBOARD_TEST_SECRET}"
        "@example.com"
    }
    assert result["diff"]["data.key"] == {
        "default": "${oc.env:ML_DASHBOARD_TEST_OTHER}",
        "experiment": "changed"
    }

    # 値の誤り, 読み込めない誤り, 起動の誤りの文にも値を出さない
    for text in (
        "optimizer:\n  name: SGD\n  params:\n"
        "    lr: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        "experiment:\n  name: bad/${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        "trainer:\n  epochs: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        # 名前を参照で決める場合も, 解決した名前の値を出さない
        "optimizer:\n  name: SGD\n  params:\n"
        "    lr: ${oc.env:${data.env_name}}\n"
    ):
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is False
        assert "${oc.env:ML_DASHBOARD_TEST_SECRET}" in result["error"]
        assert secret not in json.dumps(result)

        launched = client.post(
            f"/api/projects/{project_id}/jobs",
            json={"script": "train.py", "config_text": text}
        )
        assert launched.status_code == 400
        assert secret not in launched.text


def test_validate_uses_env_values(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    値を使う確かめは, 環境変数を解決した値で今までどおり働くことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数を置き換える pytest の仕組み

    Returns
    ----------
    None
    """
    monkeypatch.setenv("ML_DASHBOARD_TEST_EPOCHS", "7")
    monkeypatch.setenv("ML_DASHBOARD_TEST_DEVICE", "gpu")
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n  train_path: missing.csv\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 解決した値で範囲を確かめ, 食い違いの誤りの文は参照の書き方で出す
    text = (
        "trainer:\n  epochs: ${oc.env:ML_DASHBOARD_TEST_EPOCHS}\n"
        "scheduler:\n  name: OneCycleLR\n"
        "  params:\n    max_lr: 0.1\n    epochs: 3\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "trainer.epochs (${oc.env:ML_DASHBOARD_TEST_EPOCHS})" in (
        result["error"]
    )
    assert result["config"]["trainer"]["epochs"] == (
        "${oc.env:ML_DASHBOARD_TEST_EPOCHS}"
    )

    # 解決した値のデバイスを確かめ, 他の項目の場所の確かめも今までどおり
    text = "experiment:\n  device: ${oc.env:ML_DASHBOARD_TEST_DEVICE}\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "experiment.device の誤り" in result["error"]
    assert "gpu" not in json.dumps(result)
    assert result["warnings"] == [
        "data.train_path のファイルが見つかりません: missing.csv "
        "(プロジェクトのディレクトリから)"
    ]


def test_validate_monitor_in_default(
    client: TestClient, project_dir: Path
) -> None:
    """
    default の config が監視する指標を書いているかを, 確かめの結果に返す
    ことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 書いていない default (読めない experiment の config でも返す)
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    ok = client.post(url, json={"text": "{}\n"}).json()
    assert ok["ok"] is True
    assert ok["monitor_in_default"] is False
    assert ok["mode_in_default"] is False
    assert ok["config"]["trainer"]["monitor"] is None
    typo = client.post(url, json={"text": "trainer:\n  epoch: 3\n"}).json()
    assert typo["ok"] is False
    assert typo["monitor_in_default"] is False

    # experiment の config に書いても default の値ではない
    written = client.post(
        url, json={"text": "trainer:\n  monitor: valid/acc\n  mode: max\n"}
    ).json()
    assert written["ok"] is True, written
    assert written["monitor_in_default"] is False
    assert written["config"]["trainer"]["monitor"] == "valid/acc"

    # default に書くと True. null は書いていないものとみなす
    default = project_dir / "configs" / "default" / "train.yaml"
    base = default.read_text()
    default.write_text(base + "trainer:\n  monitor: valid/loss\n")
    assert client.post(url, json={"text": "{}\n"}).json()[
        "monitor_in_default"
    ] is True
    default.write_text(base + "trainer:\n  monitor: null\n  mode: max\n")
    written = client.post(url, json={"text": "{}\n"}).json()
    assert written["monitor_in_default"] is False
    assert written["mode_in_default"] is True
