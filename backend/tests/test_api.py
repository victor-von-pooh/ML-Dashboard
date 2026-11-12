from pathlib import Path

from fastapi.testclient import TestClient


def register(client: TestClient, project_dir: Path) -> str:
    """
    プロジェクトを登録して ID を返す関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    project_id: str
        登録したプロジェクトの ID
    """
    response = client.post("/api/projects", json={"path": str(project_dir)})
    assert response.status_code == 201
    project_id: str = response.json()["id"]

    return project_id


def test_register_and_list(client: TestClient, project_dir: Path) -> None:
    """
    プロジェクトの登録, 一覧, 重複の拒否, 登録の解除を確かめる関数

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
    assert project_id == "demo-task"

    projects = client.get("/api/projects").json()
    assert projects[0]["run_count"] == 2
    assert projects[0]["latest_run"] == "demo/2026-11-08/11-00-00"

    # 同じディレクトリの 2 回目の登録の拒否
    again = client.post("/api/projects", json={"path": str(project_dir)})
    assert again.status_code == 400

    # 登録を外しても実験のファイルは維持
    assert client.delete(f"/api/projects/{project_id}").status_code == 204
    assert client.get("/api/projects").json() == []
    assert (project_dir / "outputs").is_dir()


def test_register_rejects_non_project(
    client: TestClient, tmp_path: Path
) -> None:
    """
    ML-Found のプロジェクトでないディレクトリを拒否することを確かめる関数

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
    response = client.post("/api/projects", json={"path": str(tmp_path)})
    assert response.status_code == 400
    assert "configs" in response.json()["detail"]


def test_scan(client: TestClient, project_dir: Path) -> None:
    """
    ディレクトリの下のプロジェクトを探せることを確かめる関数

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
    root = project_dir.parent
    found = client.post("/api/projects/scan", json={"path": str(root)})
    assert [item["name"] for item in found.json()] == ["demo_task"]
    assert found.json()[0]["registered"] is False

    register(client, project_dir)
    found = client.post("/api/projects/scan", json={"path": str(root)})
    assert found.json()[0]["registered"] is True


def test_project_detail(client: TestClient, project_dir: Path) -> None:
    """
    プロジェクトの詳細にスクリプトと config が含まれることを確かめる関数

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
    detail = client.get(f"/api/projects/{project_id}").json()
    assert detail["scripts"] == ["train.py"]
    assert detail["experiment_configs"] == [
        "configs/experiment/examples/a.yaml", "configs/experiment/train.yaml"
    ]


def test_runs(client: TestClient, project_dir: Path) -> None:
    """
    実験の一覧と概要の値を確かめる関数

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
    runs = client.get(f"/api/projects/{project_id}/runs").json()

    # 新しい順の並び
    assert [run["id"] for run in runs] == [
        "demo/2026-11-08/11-00-00", "demo/2026-11-08/10-00-00"
    ]

    # ログの無い実験は状態が不明
    assert runs[0]["status"] == "unknown"
    assert runs[0]["best"] is None

    # ログのある実験
    run = runs[1]
    assert run["status"] == "completed"
    assert run["epochs"] == 3
    assert run["planned_epochs"] == 10
    assert run["best"] == {
        "monitor": "valid/acc", "mode": "max", "epoch": 2, "value": 0.9
    }
    assert run["duration_sec"] == 0.26
    assert run["early_stopped_epoch"] == 3
    assert run["final_metrics"]["lr"] is None
    assert run["diff"]["trainer.epochs"]["experiment"] == 10


def test_run_detail_history_log(
    client: TestClient, project_dir: Path
) -> None:
    """
    実験の詳細, 指標の推移, ログを確かめる関数

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
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00"

    detail = client.get(base).json()
    assert detail["seed"] == 42
    assert detail["device"] == "cpu"
    assert detail["parameter_count"] == 131
    assert detail["env"][0]["items"]["OS"] == "Darwin 27.2.0"
    assert detail["packages"] == {"torch": "2.15.0", "numpy": "2.3.0"}
    assert {"path": "loss_curve.png", "size": 4, "kind": "image"} in (
        detail["files"]
    )

    history = client.get(f"{base}/history").json()
    assert history["columns"][0] == "epoch"
    assert history["rows"][2]["lr"] is None

    log = client.get(f"{base}/log").json()
    assert log[2]["message"].startswith("OS の情報:")
    assert "Python Version" in log[2]["message"]
    assert [entry["level"] for entry in log].count("WARNING") == 1


def test_files_stay_inside_run(client: TestClient, project_dir: Path) -> None:
    """
    実験のディレクトリの外のファイルを返さないことを確かめる関数

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
    base = f"/api/projects/{project_id}/runs"

    image = client.get(f"{base}/demo/2026-11-08/10-00-00/files/loss_curve.png")
    assert image.status_code == 200
    assert image.content == b"\x89PNG"

    outside = client.get(
        f"{base}/demo/2026-11-08/10-00-00/files/..%2F..%2F..%2F..%2Ftrain.py"
    )
    assert outside.status_code == 404

    not_run = client.get(f"{base}/demo/2026-11-08")
    assert not_run.status_code == 404

    unknown = client.get("/api/projects/missing/runs")
    assert unknown.status_code == 404
