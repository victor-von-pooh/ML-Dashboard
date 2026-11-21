import hashlib
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core import batches as batches_module
from ml_dashboard.core.batches import BatchManager, is_active
from ml_dashboard.core.model_candidates import (
    describe_models,
    list_model_specs,
    run_key,
    spec_name,
)
from ml_dashboard.core.models import (
    BatchCandidate,
    BatchOwner,
    RunModelSpec,
    RunSource,
)

from test_api import register

# 候補の定義の中身
SPEC_A = "nodes: {fc: {unit: nn.Linear}}\n"
SPEC_B = "nodes: {fc: {unit: nn.Conv2d}}\n"


@pytest.fixture(autouse=True)
def fast_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    まとまりの進め方の確かめの間隔を短くする関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        pytest の差し替え

    Returns
    ----------
    None
    """
    monkeypatch.setattr(batches_module, "POLL_SEC", 0.05)


def make_specs(project_dir: Path, script: str = "print('train')\n") -> None:
    """
    model.spec を使うプロジェクトと, models/ の 2 つの定義を作る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    script: str = "print('train')\\n"
        学習のスクリプトの中身

    Returns
    ----------
    None
    """
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "model:\n  spec: models/a.yaml\n"
    )
    (project_dir / "models").mkdir(exist_ok=True)
    (project_dir / "models" / "a.yaml").write_text(SPEC_A)
    (project_dir / "models" / "b.yaml").write_text(SPEC_B)
    (project_dir / "train.py").write_text(script)


def wait_batch(
    client: TestClient, batch_id: str, timeout: float = 30.0
) -> dict[str, Any]:
    """
    まとまりが終わるまで待つ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    batch_id: str
        まとまりの ID
    timeout: float = 30.0
        待つ秒数の上限

    Returns
    ----------
    batch: dict[str, Any]
        終わったまとまり
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = {
            batch["id"]: batch
            for batch in client.get("/api/batches").json()
        }
        if found[batch_id]["finished"]:
            return found[batch_id]
        time.sleep(0.1)
    raise AssertionError(f"まとまりが終わりません: {found[batch_id]}")


def test_model_spec_list(project_dir: Path, tmp_path: Path) -> None:
    """
    models/ の定義の一覧が, 名前, sha256, 選べない理由を返すことを確かめる
    関数

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
    # models/ が無いプロジェクトは理由だけ
    assert list_model_specs(project_dir).notice == "models/ がありません"

    make_specs(project_dir)
    models = project_dir / "models"
    (models / "sub").mkdir()
    (models / "sub" / "net.yml").write_text("nodes: {}\n")
    (models / ".hidden.yaml").write_text("nodes: {}\n")
    (models / "notes.txt").write_text("メモ\n")
    (tmp_path / "outside.yaml").write_text("nodes: {}\n")
    (models / "link.yaml").symlink_to(tmp_path / "outside.yaml")
    (models / "${bad}.yaml").write_text("nodes: {}\n")
    with (models / "big.yaml").open("wb") as file:
        file.truncate(16 * 1024 * 1024 + 1)
    os.mkfifo(models / "pipe.yaml")

    listing = list_model_specs(project_dir)
    found = {spec.path: spec for spec in listing.specs}
    assert set(found) == {
        "models/${bad}.yaml", "models/a.yaml", "models/b.yaml",
        "models/big.yaml", "models/link.yaml", "models/pipe.yaml",
        "models/sub/net.yml",
    }
    assert found["models/a.yaml"].name == "a"
    assert found["models/a.yaml"].sha256 == hashlib.sha256(
        SPEC_A.encode()
    ).hexdigest()
    assert found["models/sub/net.yml"].name == "sub/net"
    assert found["models/a.yaml"].reason is None
    for path, message in (
        ("models/link.yaml", "シンボリックリンク"),
        ("models/${bad}.yaml", "${"),
        ("models/big.yaml", "16 MiB"),
        ("models/pipe.yaml", "普通のファイル"),
    ):
        reason = found[path].reason
        assert reason is not None and message in reason, path
        assert found[path].sha256 is None

    # models/ そのものがリンクなら選べない
    other = tmp_path / "other_project"
    other.mkdir()
    (other / "models").symlink_to(models, target_is_directory=True)
    linked = list_model_specs(other)
    assert linked.specs == [] and linked.notice is not None


def test_spec_names() -> None:
    """
    定義の名前が, models/ からの場所から拡張子を除いたものになることを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    assert spec_name("models/a.yaml") == "a"
    assert spec_name("models/a/net.yml") == "a/net"
    assert spec_name("other/net.yaml") == "other/net"
    assert spec_name("/abs/net.yaml") == "/abs/net"


def test_describe_models(project_dir: Path) -> None:
    """
    写しから起動し直した実験の元の定義を, 読んだ実験の中だけで辿ることを
    確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    sha = "a" * 64
    outputs = project_dir / "outputs" / "demo" / "2026-11-08"

    def source(path: str, digest: str = sha) -> RunSource:
        return RunSource(model_spec=RunModelSpec(
            path=path, status="copied", sha256=digest
        ))

    def copy_of(name: str) -> str:
        return f"outputs/demo/2026-11-08/{name}/model_spec.yaml"

    sources = {
        run_key(outputs / "a"): source("models/net.yaml"),
        run_key(outputs / "b"): source(copy_of("a")),
        run_key(outputs / "c"): source(copy_of("b")),
        # 中身の違う写しと, 読んでいない実験の写し
        run_key(outputs / "d"): source(copy_of("a"), "b" * 64),
        run_key(outputs / "e"): source(copy_of("09-59-59")),
        # 互いを指す写し
        run_key(outputs / "f"): source(copy_of("g")),
        run_key(outputs / "g"): source(copy_of("f")),
        # 写しの記録の無い実験と, model_spec の無い実験
        run_key(outputs / "h"): RunSource(model_spec=RunModelSpec(
            path="models/net.yaml", status="missing"
        )),
        run_key(outputs / "i"): RunSource(script="train.py"),
    }
    models = describe_models(project_dir, sources)

    def model(name: str) -> Any:
        return models[run_key(outputs / name)]

    # 辿れる写しは元の場所の名前
    for name in ("a", "b", "c"):
        assert model(name).name == "net"
        assert model(name).path == "models/net.yaml"
        assert model(name).origin_known
    # 辿れない写しは「写し」
    for name in ("d", "e", "f", "g"):
        assert model(name).name == "写し", name
        assert not model(name).origin_known
    assert model("h").name == "net" and model("h").sha256 is None
    assert model("i") is None

    # 実験の形でない model_spec.yaml という名前の定義は, 普通の定義
    own = describe_models(project_dir, {
        run_key(outputs / "j"): source("models/model_spec.yaml")
    })[run_key(outputs / "j")]
    assert own is not None and own.name == "model_spec" and own.origin_known


def test_batch_runs_candidates(
    client: TestClient, project_dir: Path
) -> None:
    """
    候補のまとまりが, 候補ごとに model.spec を書き換えて順に学習することを
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
    make_specs(project_dir)
    project_id = register(client, project_dir)
    specs = client.get(f"/api/projects/{project_id}/model-specs").json()
    assert [spec["name"] for spec in specs["specs"]] == ["a", "b"]

    response = client.post(
        f"/api/projects/{project_id}/batches",
        json={
            "script": "train.py", "config_text": "{}\n",
            "specs": ["models/b.yaml", "models/a.yaml"]
        }
    )
    assert response.status_code == 201, response.json()
    batch = wait_batch(client, response.json()["id"])

    # 選んだ順に起動し, 候補のジョブの config は model.spec を書き換えた中身
    states = [candidate["state"] for candidate in batch["candidates"]]
    assert states == ["finished", "finished"]
    jobs = [
        client.get(f"/api/jobs/{candidate['job_id']}").json()
        for candidate in batch["candidates"]
    ]
    assert jobs[0]["created_at"] <= jobs[1]["created_at"]
    assert "spec: models/b.yaml" in (jobs[0]["config_text"] or "")
    assert "spec: models/a.yaml" in (jobs[1]["config_text"] or "")
    assert batch["owned"] and batch["project_name"]


def test_batch_conflict_and_stop(
    client: TestClient, project_dir: Path
) -> None:
    """
    進めている途中のまとまりがあれば 409 で断り, 取りやめで待つ候補を
    取りやめることを確かめる関数

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
    make_specs(project_dir, "import time\ntime.sleep(60)\n")
    project_id = register(client, project_dir)
    body = {
        "script": "train.py", "config_text": "{}\n",
        "specs": ["models/a.yaml", "models/b.yaml"]
    }
    first = client.post(f"/api/projects/{project_id}/batches", json=body)
    assert first.status_code == 201
    batch_id = first.json()["id"]

    # 1 つ目の候補が学習を始めるまで待つ
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        batch = {
            item["id"]: item for item in client.get("/api/batches").json()
        }[batch_id]
        if batch["candidates"][0]["state"] == "running":
            break
        time.sleep(0.05)
    assert batch["candidates"][0]["state"] == "running"
    assert client.post(
        f"/api/projects/{project_id}/batches", json=body
    ).status_code == 409

    # 取りやめで待つ候補を取りやめ, 学習中の候補は中断の要求
    stopped = client.post(f"/api/batches/{batch_id}/stop").json()
    assert stopped["candidates"][1]["state"] == "cancelled"
    assert stopped["waiting_for"] == []
    job_id = stopped["candidates"][0]["job_id"]
    assert client.get(f"/api/jobs/{job_id}").json()["stop_requested"]

    # 実験のディレクトリの無いジョブは中断でプロセスに割り込むので,
    # まとまりの終わりを待つ
    finished = wait_batch(client, batch_id)
    assert finished["candidates"][1]["job_id"] is None

    # 形の違う ID と無い ID は 404
    assert client.post("/api/batches/NOT-AN-ID/stop").status_code == 404
    assert client.post("/api/batches/0123456789ab/stop").status_code == 404


def test_batch_refuses(client: TestClient, project_dir: Path) -> None:
    """
    候補の数, 一覧に無い候補, model.spec の無い default, config の誤りを
    断ることを確かめる関数

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
    make_specs(project_dir)
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/batches"

    def post(specs: list[str], text: str = "{}\n") -> Any:
        return client.post(url, json={
            "script": "train.py", "config_text": text, "specs": specs
        })

    for specs, message in (
        (["models/a.yaml"], "2 個から"),
        (["models/a.yaml", "models/a.yaml"], "2 回"),
        (["models/a.yaml", "models/none.yaml"], "一覧にありません"),
    ):
        response = post(specs)
        assert response.status_code == 400
        assert message in response.json()["detail"], specs

    # model が辞書でない config と, 出力先を変える config
    response = post(["models/a.yaml", "models/b.yaml"], "model: 3\n")
    assert response.status_code == 400
    assert "辞書ではありません" in response.json()["detail"]
    response = post(
        ["models/a.yaml", "models/b.yaml"],
        "experiment:\n  output_dir: elsewhere\n"
    )
    assert response.status_code == 400

    # model.spec の無い default は, 定義を替えても同じモデル
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
    )
    response = post(["models/a.yaml", "models/b.yaml"])
    assert response.status_code == 400
    assert "model.spec が無い" in response.json()["detail"]
    assert client.get("/api/batches").json() == []


class FakeHooks:
    # まとまりの進め方の口の代わり. 呼ばれた順を記録し, 誤りや待つものを
    # 差し込める
    def __init__(self) -> None:
        # 差し込む値と記録を用意
        self.busy_calls = 0
        self.waiting: list[str] = []
        self.wait_rounds = 0
        self.launched: list[str] = []
        self.launch_errors: dict[str, Exception] = {}
        self.finish_errors: dict[str, Exception] = {}
        self.sha: dict[str, str] = {}
        self.run_sha: Optional[str] = None
        self.seen_waiting: list[list[str]] = []
        self.manager: Optional[BatchManager] = None
        self.batch_id = ""

    def busy(self) -> list[str]:
        """
        待つものを返す関数 (初めの wait_rounds 回だけ waiting を返す)

        Parameters
        ----------
        None

        Returns
        ----------
        waiting: list[str]
            待っているジョブ
        """
        self.busy_calls += 1
        if self.manager is not None:
            batch = self.manager.load(self.batch_id)
            if batch is not None:
                self.seen_waiting.append(list(batch.waiting_for))
        waiting = self.waiting if self.busy_calls <= self.wait_rounds else []

        return waiting

    def check(self, candidate: BatchCandidate, text: str) -> Optional[str]:
        """
        起動の前の確かめ (いつも通す) の関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補
        text: str
            config の中身

        Returns
        ----------
        reason: Optional[str]
            いつも None
        """
        reason = None

        return reason

    def launch(self, candidate: BatchCandidate, text: str) -> Optional[str]:
        """
        起動の代わりに候補の場所を記録する関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補
        text: str
            config の中身

        Returns
        ----------
        job_id: Optional[str]
            候補の場所から作ったジョブの ID
        """
        if candidate.path in self.launch_errors:
            raise self.launch_errors[candidate.path]
        self.launched.append(candidate.path)
        job_id = f"job-{candidate.path}"

        return job_id

    def finished(self, job_id: str) -> bool:
        """
        ジョブが終わったか (いつも終わった) を返す関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        finished: bool
            いつも True
        """
        if job_id in self.finish_errors:
            raise self.finish_errors[job_id]
        finished = True

        return finished

    def run_sha256(self, job_id: str) -> Optional[str]:
        """
        実験の写しの sha256 を返す関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        sha256: Optional[str]
            差し込んだ値
        """
        sha256 = self.run_sha

        return sha256

    def current_sha256(self, candidate: BatchCandidate) -> Optional[str]:
        """
        候補の定義の今の sha256 を返す関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補

        Returns
        ----------
        sha256: Optional[str]
            差し込んだ値, 無ければ作ったときの値
        """
        sha256 = self.sha.get(candidate.path, candidate.sha256)

        return sha256


def make_batch(
    manager: BatchManager, paths: list[str]
) -> str:
    """
    候補の場所からまとまりを作る関数

    Parameters
    ----------
    manager: BatchManager
        まとまりの管理
    paths: list[str]
        候補の場所

    Returns
    ----------
    batch_id: str
        作ったまとまりの ID
    """
    batch = manager.create("p", "train.py", None, [
        (BatchCandidate(path=path, name=path, sha256="0" * 64), "{}\n")
        for path in paths
    ])
    batch_id = batch.id

    return batch_id


def test_runner_errors_and_marks(tmp_path: Path) -> None:
    """
    進め方の誤りで止まらず次の候補へ進み, 待っているジョブ, 書き換えた
    定義, 写しの違いの印を残すことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    manager = BatchManager(tmp_path)
    hooks = FakeHooks()
    batch_id = make_batch(manager, ["a", "b", "c", "d"])
    hooks.manager = manager
    hooks.batch_id = batch_id
    hooks.waiting = ["job-other"]
    hooks.wait_rounds = 2
    hooks.launch_errors["b"] = OSError("書けません")
    hooks.finish_errors["job-c"] = ValueError("登録が外されています")
    hooks.sha["d"] = "1" * 64
    hooks.run_sha = "2" * 64
    manager.run(batch_id, hooks)

    batch = manager.load(batch_id)
    assert batch is not None
    states = [(item.state, item.reason) for item in batch.candidates]
    assert states[0] == ("finished", None)
    assert states[1][0] == "failed"
    assert "起動できなかった" in (states[1][1] or "")
    # 学習を始めた後に待てなかった候補は, 起動できなかったとしない
    assert states[2][0] == "finished"
    assert "終わりを待てなかった" in (states[2][1] or "")
    assert states[3][0] == "failed" and "定義の中身が変わった" in (
        states[3][1] or ""
    )
    # 待っている間はジョブの ID を記録し, 起動したら消す
    assert ["job-other"] in hooks.seen_waiting
    assert batch.waiting_for == []
    # 写しが作ったときの中身と違えば印
    assert batch.candidates[0].mismatch
    assert not is_active(batch)


def test_runner_closes_remaining(tmp_path: Path) -> None:
    """
    進め方が途中で止まっても, 待つ候補を残さないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    manager = BatchManager(tmp_path)
    batch_id = make_batch(manager, ["a", "b"])

    class Broken(FakeHooks):
        def busy(self) -> list[str]:
            """
            いつも止まる関数

            Parameters
            ----------
            None

            Returns
            ----------
            waiting: list[str]
                返さない
            """
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        manager.run(batch_id, Broken())
    batch = manager.load(batch_id)
    assert batch is not None
    assert [item.state for item in batch.candidates] == [
        "cancelled", "cancelled"
    ]
    assert not is_active(batch)


def test_orphan_batches(tmp_path: Path) -> None:
    """
    持ち主の居ないまとまりの待つ候補だけを取りやめ, 別の hostname の
    まとまりには触らないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    manager = BatchManager(tmp_path)
    candidate = BatchCandidate(path="models/a.yaml", name="a", sha256="0" * 64)
    gone = manager.create(
        "p", "train.py", None,
        [(candidate.model_copy(), "{}\n"), (candidate.model_copy(), "{}\n")]
    )
    other = manager.create("p", "train.py", None, [(candidate, "{}\n")])

    # 動いていない pid の持ち主と, 別の hostname の持ち主
    gone.owner = BatchOwner(
        hostname=manager.owner.hostname, pid=2 ** 22 + 12345,
        started_at="2026-11-01T00:00:00+09:00"
    )
    gone.candidates[0].state = "running"
    gone.candidates[0].job_id = "0123456789ab"
    manager.save(gone)
    other.owner = BatchOwner(
        hostname="elsewhere", pid=1, started_at="2026-11-01T00:00:00+09:00"
    )
    manager.save(other)

    restarted = BatchManager(tmp_path)
    reloaded = restarted.load(gone.id)
    assert reloaded is not None
    assert [item.state for item in reloaded.candidates] == [
        "running", "cancelled"
    ]
    untouched = restarted.load(other.id)
    assert untouched is not None
    assert untouched.candidates[0].state == "waiting"

    # pid が今のプロセスと同じで起動の時刻が違う (使い回された pid) 持ち主
    reused = manager.create("q", "train.py", None, [(candidate, "{}\n")])
    reused.owner = BatchOwner(
        hostname=manager.owner.hostname, pid=manager.owner.pid,
        started_at="2026-11-01T00:00:00.000001+09:00"
    )
    manager.save(reused)
    assert manager.orphaned(reused)
    after = BatchManager(tmp_path).load(reused.id)
    assert after is not None and after.candidates[0].state == "cancelled"

    # 動いている別のプロセスが持ち主のまとまりも, 学習中の候補はジョブの
    # 状態で読み直し, 終わっていれば新しいまとまりを妨げない
    foreign = manager.create("r", "train.py", None, [(candidate, "{}\n")])
    foreign.owner = BatchOwner(
        hostname=manager.owner.hostname, pid=os.getppid(),
        started_at="2026-11-01T00:00:00+09:00"
    )
    foreign.candidates[0].state = "running"
    foreign.candidates[0].job_id = "0123456789ab"
    manager.save(foreign)
    assert manager.active_for("r", lambda job_id: True) is not None
    # 別のプロセスが進めているまとまりは, このプロセスから取りやめない
    assert not manager.owned(foreign) and not manager.orphaned(foreign)
    assert manager.active_for("r", lambda job_id: False) is None
    # 持ち主が居るまとまりの記録は上書きしない (読み直した結果を返すだけ)
    refreshed = manager.load(foreign.id)
    assert refreshed is not None
    assert refreshed.candidates[0].state == "running"
    read = manager.refresh_foreign(foreign.id, lambda job_id: False)
    assert read is not None and read.candidates[0].state == "finished"


def test_batch_create_once(client: TestClient, project_dir: Path) -> None:
    """
    同じプロジェクトにまとまりを同時に 2 つ作れないことを確かめる関数

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
    make_specs(project_dir, "import time\ntime.sleep(60)\n")
    project_id = register(client, project_dir)
    body = {
        "script": "train.py", "config_text": "{}\n",
        "specs": ["models/a.yaml", "models/b.yaml"]
    }
    codes: list[int] = []

    def post() -> None:
        codes.append(client.post(
            f"/api/projects/{project_id}/batches", json=body
        ).status_code)

    threads = [threading.Thread(target=post) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(codes) == [201, 409]

    # 学習中の候補を止めて片付け
    batch = client.get("/api/batches").json()[0]
    client.post(f"/api/batches/{batch['id']}/stop")
    wait_batch(client, batch["id"])


def test_runs_have_model(client: TestClient, project_dir: Path) -> None:
    """
    実験の一覧と詳細に, 使ったモデルの定義の名前を返すことを確かめる関数

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
    sha = "c" * 64
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    (run_dir / "source.yaml").write_text(
        "script: train.py\nmodel_spec:\n  path: models/small/net.yaml\n"
        f"  status: copied\n  sha256: '{sha}'\n"
    )
    copied = project_dir / "outputs" / "demo" / "2026-11-08" / "11-00-00"
    (copied / "source.yaml").write_text(
        "script: train.py\nmodel_spec:\n"
        "  path: outputs/demo/2026-11-08/10-00-00/model_spec.yaml\n"
        f"  status: copied\n  sha256: '{sha}'\n"
    )
    project_id = register(client, project_dir)
    runs = {
        run["id"]: run["model"]
        for run in client.get(f"/api/projects/{project_id}/runs").json()
    }
    expected = {
        "name": "small/net", "path": "models/small/net.yaml", "sha256": sha,
        "origin_known": True
    }
    assert runs["demo/2026-11-08/10-00-00"] == expected
    assert runs["demo/2026-11-08/11-00-00"] == expected
    detail = client.get(
        f"/api/projects/{project_id}/runs/demo/2026-11-08/11-00-00"
    ).json()
    assert detail["model"] == expected


def test_stop_foreign_batch(client: TestClient, tmp_path: Path) -> None:
    """
    別のプロセスが進めているまとまりの取りやめを 409 で断ることを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ (アプリの置き場は home)

    Returns
    ----------
    None
    """
    manager = BatchManager(tmp_path / "home")
    candidate = BatchCandidate(path="models/a.yaml", name="a", sha256="0" * 64)
    batch = manager.create("p", "train.py", None, [(candidate, "{}\n")])
    batch.owner = BatchOwner(
        hostname=manager.owner.hostname, pid=os.getppid(),
        started_at="2026-11-01T00:00:00+09:00"
    )
    manager.save(batch)
    response = client.post(f"/api/batches/{batch.id}/stop")
    assert response.status_code == 409
    assert "別のダッシュボード" in response.json()["detail"]
    reloaded = manager.load(batch.id)
    assert reloaded is not None
    assert reloaded.candidates[0].state == "waiting"
