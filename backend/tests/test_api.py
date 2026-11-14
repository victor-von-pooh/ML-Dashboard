import json
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


def test_scan_skips_submodules(client: TestClient, tmp_path: Path) -> None:
    """
    submodule の中のプロジェクトを探さないことを確かめる関数

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
    # リポジトリの直下のタスクと, submodule の中の例を用意
    root = tmp_path / "repo"
    projects = (
        root / "tasks" / "task_a", root / "lib" / "examples" / "b",
        root / "vendor" / "deep" / "c"
    )
    for project in projects:
        (project / "configs" / "default").mkdir(parents=True)
        (project / "configs" / "default" / "train.yaml").write_text("{}\n")
    (root / ".gitmodules").write_text(
        '[submodule "lib"]\n\tpath = lib\n\turl = https://example.com/lib\n'
        '[submodule "deep"]\n\tpath = vendor/deep\n'
    )

    found = client.post("/api/projects/scan", json={"path": str(root)})
    assert [item["name"] for item in found.json()] == ["task_a"]

    # submodule を直接指定した場合は探す対象
    found = client.post(
        "/api/projects/scan", json={"path": str(root / "lib")}
    )
    assert [item["name"] for item in found.json()] == ["b"]


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
    assert detail["final_weights"] is None
    run_dir = project_dir / "outputs/demo/2026-11-08/10-00-00"
    (run_dir / "run.json").write_text(
        '{"status": "stopped", "final_weights": "partial"}'
    )
    assert client.get(base).json()["final_weights"] == "partial"

    # ベストモデルを選ばない設定の実験は, 指標の推移からもベストを求めない
    assert client.get(base).json()["best"] is not None
    (run_dir / "run.json").write_text(
        '{"status": "completed", "select_best": false}'
    )
    assert client.get(base).json()["best"] is None
    (run_dir / "run.json").write_text(
        '{"status": "completed", "final_weights": "other"}'
    )
    assert client.get(base).json()["final_weights"] is None

    # Optimizer ごとの情報 (書いていない場合と形が違う場合は None)
    assert client.get(base).json()["optimizers"] is None
    (run_dir / "run.json").write_text(json.dumps({
        "status": "completed",
        "optimizers": [
            {"name": "actor", "optimizer": "Adam", "modules": ["actor"],
             "scheduler": "StepLR"},
            {"name": "critic", "optimizer": "SGD", "modules": ["critic"],
             "scheduler": None}
        ]
    }))
    optimizers = client.get(base).json()["optimizers"]
    assert [item["name"] for item in optimizers] == ["actor", "critic"]
    assert optimizers[0]["scheduler"] == "StepLR"
    (run_dir / "run.json").write_text(
        '{"status": "completed", "optimizers": [{"name": 1}]}'
    )
    assert client.get(base).json()["optimizers"] is None
    (run_dir / "run.json").unlink()
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
    assert history["lr_steps"] == []

    # step ごとに学習率を変えた実験は, 更新ごとの学習率も返却
    # (エポックの読めない行は除外)
    run_dir = project_dir / "outputs/demo/2026-11-08/10-00-00"
    (run_dir / "lr_steps.csv").write_text(
        "step,epoch,lr\n1,1,0.1\n2,1,0.05\n3,x,0.1\n4,2,nan\n"
    )
    history = client.get(f"{base}/history").json()
    assert history["lr_steps"] == [
        {"x": 1.0, "lr": 0.1},
        {"x": 1.5, "lr": 0.05},
        {"x": 2.0, "lr": None},
    ]
    assert history["named_lr_steps"] == {}

    # 名前付きの複数の Optimizer の実験は, 列 (lr_<名前>) ごとに返却
    (run_dir / "lr_steps.csv").write_text(
        "step,epoch,lr_a,lr_b\n1,1,0.1,0.2\n2,1,0.05,0.2\n"
    )
    history = client.get(f"{base}/history").json()
    assert history["lr_steps"] == []
    assert history["named_lr_steps"]["lr_b"] == [
        {"x": 1.0, "lr": 0.2}, {"x": 1.5, "lr": 0.2}
    ]
    assert set(history["named_lr_steps"]) == {"lr_a", "lr_b"}

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


def test_params(client: TestClient, project_dir: Path) -> None:
    """
    分析用の config と結果を確かめる関数

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
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    (run_dir / "config.yaml").write_text(
        "experiment:\n  name: demo\n"
        "optimizer:\n  name: Adam\n  params:\n    lr: 0.01\n"
        "trainer:\n  monitor: valid/acc\n  mode: max\n"
        "  milestones: [1, 2]\n  extra: {}\n  flag: true\n  none: null\n"
    )
    project_id = register(client, project_dir)
    params = client.get(f"/api/projects/{project_id}/params").json()

    run = next(item for item in params if item["id"].endswith("10-00-00"))
    assert run["params"]["optimizer.params.lr"] == 0.01
    assert run["params"]["optimizer.name"] == "Adam"
    assert run["params"]["trainer.milestones"] == "[1, 2]"
    assert run["params"]["trainer.extra"] == "{}"
    assert run["params"]["trainer.flag"] is True
    assert run["params"]["trainer.none"] is None
    assert run["best"]["value"] == 0.9


def test_flatten_params_edge_cases() -> None:
    """
    分析用の平らな config の端の場合を確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    from ml_dashboard.core.runs import flatten_params

    assert flatten_params({}) == {}
    assert flatten_params({"a": {}, "b": [[1], 2]}) == {
        "a": "{}", "b": "[[1], 2]"
    }
    assert flatten_params({"x": float("nan"), "y": b"raw"}) == {
        "x": None, "y": "\"b'raw'\""
    }


def test_notes(client: TestClient, project_dir: Path) -> None:
    """
    実験のメモ, タグ, 星の保存と削除を確かめる関数

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
    url = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/note"

    # タグの空白と重複は整えて保存し, 実験のディレクトリには書かない
    saved = client.put(url, json={
        "note": "lr を下げた", "tags": [" base ", "base", "", "a  b"],
        "starred": True
    })
    assert saved.status_code == 200
    assert saved.json()["tags"] == ["base", "a b"]
    notes = client.get(f"/api/projects/{project_id}/notes").json()
    assert notes["demo/2026-11-08/10-00-00"]["note"] == "lr を下げた"
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    assert not any("note" in path.name for path in run_dir.iterdir())

    # 空にすると削除, 存在しない実験と長すぎるタグは拒否
    client.put(url, json={"note": "", "tags": [], "starred": False})
    assert client.get(f"/api/projects/{project_id}/notes").json() == {}
    missing = client.put(
        f"/api/projects/{project_id}/runs/demo/2026-11-08/09-00-00/note",
        json={"note": "x"}
    )
    assert missing.status_code == 404
    long_tag = client.put(url, json={"tags": ["x" * 41]})
    assert long_tag.status_code == 422


def test_notes_corrupt_file_and_remove(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    壊れたメモのファイルを退避し, 登録を外すとメモも消えることを確かめる関数

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
    notes_dir = tmp_path / "home" / "notes"
    notes_dir.mkdir(parents=True)
    (notes_dir / f"{project_id}.json").write_text("{broken")

    url = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/note"
    assert client.put(url, json={"note": "x"}).status_code == 200
    assert (notes_dir / f"{project_id}.corrupt").read_text() == "{broken"

    client.delete(f"/api/projects/{project_id}")
    assert not (notes_dir / f"{project_id}.json").exists()
