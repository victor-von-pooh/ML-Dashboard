import hashlib
import os
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core import batches as batches_module
from ml_dashboard.core.batches import BatchManager
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
        run_key(outputs / "e"): source(copy_of("gone")),
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
    job_id = stopped["candidates"][0]["job_id"]
    assert client.get(f"/api/jobs/{job_id}").json()["stop_requested"]

    # 学習中の候補のプロセスを止めて, まとまりの終わりを待つ
    client.post(f"/api/jobs/{job_id}/stop", json={"force": True})
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


def test_batch_candidate_changed(
    client: TestClient, project_dir: Path
) -> None:
    """
    まとまりを作った後に定義を書き換えた候補は起動せず, 次へ進むことを
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
    make_specs(project_dir, "import time\ntime.sleep(0.5)\n")
    project_id = register(client, project_dir)
    response = client.post(
        f"/api/projects/{project_id}/batches",
        json={
            "script": "train.py", "config_text": "{}\n",
            "specs": ["models/a.yaml", "models/b.yaml"]
        }
    )
    assert response.status_code == 201
    (project_dir / "models" / "b.yaml").write_text("nodes: {changed: {}}\n")
    batch = wait_batch(client, response.json()["id"])
    assert batch["candidates"][0]["state"] == "finished"
    assert batch["candidates"][1]["state"] == "failed"
    assert "定義の中身が変わった" in batch["candidates"][1]["reason"]


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
