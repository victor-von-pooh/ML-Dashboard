import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import write_run
from test_api import register


def test_broken_runs_do_not_break_list(
    client: TestClient, project_dir: Path
) -> None:
    """
    壊れた実験があっても一覧が返り, 読めない理由が付くことを確かめる関数

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
    # 壊れた config, UTF-8 でない CSV, 列の多い行, 辞書でない trainer
    bad_yaml = write_run(project_dir, "12-00-00")
    (bad_yaml / "config.yaml").write_text("trainer: [unclosed\n")
    bad_csv = write_run(project_dir, "12-00-01")
    (bad_csv / "history.csv").write_bytes(b"epoch,loss\n1,\xff\xfe\n")
    extra = write_run(project_dir, "12-00-02")
    (extra / "history.csv").write_text("epoch,loss\n1,0.5,9,9\n")
    list_trainer = write_run(project_dir, "12-00-03")
    (list_trainer / "config.yaml").write_text("trainer: [1, 2]\n")

    # 実在しない日付のディレクトリは実験として扱わない
    fake = project_dir / "outputs" / "demo" / "2026-13-45" / "10-00-00"
    fake.mkdir(parents=True)
    (fake / "config.yaml").write_text("{}\n")

    project_id = register(client, project_dir)
    response = client.get(f"/api/projects/{project_id}/runs")
    assert response.status_code == 200
    runs = {run["id"]: run for run in response.json()}
    assert "demo/2026-13-45/10-00-00" not in runs
    assert runs["demo/2026-11-08/12-00-00"]["error"].startswith("読み込め")
    assert runs["demo/2026-11-08/12-00-01"]["epochs"] == 1
    assert runs["demo/2026-11-08/12-00-02"]["final_metrics"] == {"loss": 0.5}
    assert runs["demo/2026-11-08/12-00-03"]["planned_epochs"] is None


def test_run_order_with_suffix(client: TestClient, project_dir: Path) -> None:
    """
    同じ秒に始めた実験が連番の順に並ぶことを確かめる関数

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
    for name in ("12-00-00", "12-00-00_2", "12-00-00_10"):
        write_run(project_dir, name)
    project_id = register(client, project_dir)
    ids = [run["id"] for run in client.get(
        f"/api/projects/{project_id}/runs"
    ).json()]
    assert ids[:3] == [
        "demo/2026-11-08/12-00-00_10", "demo/2026-11-08/12-00-00_2",
        "demo/2026-11-08/12-00-00"
    ]


def test_files_in_named_subdirs(client: TestClient, project_dir: Path) -> None:
    """
    files や history という名前の下のファイルも返せることを確かめる関数

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
    for sub in ("files", "history"):
        (run_dir / sub).mkdir()
        (run_dir / sub / "a.png").write_bytes(sub.encode())
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/files"
    assert client.get(f"{base}/files/a.png").content == b"files"
    assert client.get(f"{base}/history/a.png").content == b"history"


def test_history_from_log_and_custom_format(
    client: TestClient, project_dir: Path
) -> None:
    """
    推移をログから作り直せることと, 独自の書式のログを確かめる関数

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
    # 独自の書式でエポックの指標まで書いて落ちた実験
    run_dir = write_run(
        project_dir, "12-00-00",
        log=(
            "[INFO] 2026-11-08 12:00:00,000 乱数シード: 7\n"
            "[INFO] 2026-11-08 12:00:01,000 エポック 1: train/loss=0.5, "
            "valid/loss=0.6, lr=0.1\n"
            "[INFO] 2026-11-08 12:00:02,000 エポック 2: train/loss=0.4, "
            "valid/loss=nan, lr=0.1\n"
            "[ERROR] 2026-11-08 12:00:03,000 エラーで学習が止まりました\n"
            "Traceback (most recent call last):\n"
        )
    )
    (run_dir / "history.csv").unlink()
    (run_dir / "config.yaml").write_text(
        "experiment:\n  name: demo\n  seed: 7\n"
        "  log_format: '[%(levelname)s] %(asctime)s %(message)s'\n"
    )
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/12-00-00"

    detail = client.get(base).json()
    assert detail["status"] == "failed"
    assert detail["epochs"] == 2
    assert detail["seed"] == 7
    assert detail["best"]["epoch"] == 1

    history = client.get(f"{base}/history").json()
    assert history["columns"] == ["epoch", "train/loss", "valid/loss", "lr"]
    assert history["rows"][1]["valid/loss"] is None

    log = client.get(f"{base}/log").json()
    assert log[-1]["level"] == "ERROR"
    assert "Traceback" in log[-1]["message"]


def test_run_json_status(client: TestClient, project_dir: Path) -> None:
    """
    run.json と progress.json の状態が使われることを確かめる関数

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
    # 動いているプロセス (このテスト) の実行中の実験
    running = write_run(project_dir, "12-00-00", log="")
    (running / "run.json").write_text(json.dumps({
        "status": "running", "pid": os.getpid(), "planned_epochs": 50,
        "best_epoch": 2, "best_value": 0.9
    }))
    (running / "progress.json").write_text(json.dumps({
        "phase": "train", "epoch": 4, "total_epochs": 50, "batch": 3,
        "total_batches": 10, "elapsed_sec": 1.5,
        "updated_at": "2026-11-08T12:00:05"
    }))

    # プロセスが残っていない実行中の実験と, 中断した実験
    dead = write_run(project_dir, "12-00-01", log="")
    (dead / "run.json").write_text(
        json.dumps({"status": "running", "pid": 2 ** 22 + 12345})
    )
    stopped = write_run(project_dir, "12-00-02", log="")
    (stopped / "run.json").write_text(json.dumps({"status": "stopped"}))

    project_id = register(client, project_dir)
    runs = {run["id"]: run for run in client.get(
        f"/api/projects/{project_id}/runs"
    ).json()}
    run = runs["demo/2026-11-08/12-00-00"]
    assert run["status"] == "running"
    assert run["planned_epochs"] == 50
    assert run["best"]["epoch"] == 2
    assert run["progress"]["batch"] == 3
    assert runs["demo/2026-11-08/12-00-01"]["status"] == "unknown"
    assert runs["demo/2026-11-08/12-00-02"]["status"] == "stopped"


def test_symlinks_are_not_served(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    出力先の外を指すシンボリックリンクの実験とファイルを返さないことを確かめる関数

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
    # 出力先の外の実験へのリンクと, 実験の中から外のファイルへのリンク
    outside = write_run(tmp_path / "elsewhere", "10-00-00")
    (project_dir / "outputs" / "linked").symlink_to(
        outside.parent.parent, target_is_directory=True
    )
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    (run_dir / "secret.txt").symlink_to(secret)

    project_id = register(client, project_dir)
    ids = [run["id"] for run in client.get(
        f"/api/projects/{project_id}/runs"
    ).json()]
    assert not any(run_id.startswith("linked/") for run_id in ids)

    base = f"/api/projects/{project_id}/runs"
    assert client.get(f"{base}/linked/2026-11-08/10-00-00").status_code == 404
    assert client.get(
        f"{base}/demo/2026-11-08/10-00-00/files/secret.txt"
    ).status_code == 404


def test_file_headers(client: TestClient, project_dir: Path) -> None:
    """
    実験のファイルを安全な形で返すことを確かめる関数

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
    (run_dir / "page.html").write_text("<script>fetch('/api')</script>")
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/files"

    html = client.get(f"{base}/page.html")
    assert html.headers["content-type"] == "application/octet-stream"
    assert "attachment" in html.headers["content-disposition"]
    assert "sandbox" in html.headers["content-security-policy"]

    log = client.get(f"{base}/train.log")
    assert log.headers["content-type"].startswith("text/plain")
    assert log.headers["x-content-type-options"] == "nosniff"


def test_host_and_origin_checks(client: TestClient, project_dir: Path) -> None:
    """
    他のホスト名と他のサイトからの書き込みを拒否することを確かめる関数

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
    rebind = client.get("/api/projects", headers={"Host": "evil.example"})
    assert rebind.status_code == 400

    cross = client.post(
        "/api/projects", json={"path": str(project_dir)},
        headers={"Origin": "http://evil.example"}
    )
    assert cross.status_code == 403

    same = client.post(
        "/api/projects", json={"path": str(project_dir)},
        headers={"Origin": "http://localhost:5173"}
    )
    assert same.status_code == 201


def test_project_errors(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    消えたプロジェクトと, 読めないディレクトリの探索を確かめる関数

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
    # 読めないディレクトリがあっても探索は続行
    locked = project_dir.parent / "locked"
    locked.mkdir()
    locked.chmod(0)
    try:
        found = client.post(
            "/api/projects/scan", json={"path": str(project_dir.parent)}
        )
        assert found.status_code == 200
        assert [item["name"] for item in found.json()] == ["demo_task"]
    finally:
        locked.chmod(0o755)

    # Python でないファイルの拒否
    bad = client.post(
        "/api/projects", json={"path": str(project_dir), "python": "/bin/sh"}
    )
    assert bad.status_code == 400

    # 登録した後にディレクトリが消えても, 一覧は理由付きで返し, 実験は 404
    project_id = register(client, project_dir)
    (project_dir / "configs" / "default" / "train.yaml").unlink()
    projects = client.get("/api/projects").json()
    assert projects[0]["error"] is not None
    assert projects[0]["run_count"] == 0
    assert client.get(f"/api/projects/{project_id}/runs").status_code == 404


def test_experiment_output_dir(client: TestClient, project_dir: Path) -> None:
    """
    experiment の config で出力先を変えた実験も見つけることを確かめる関数

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
    (project_dir / "configs" / "experiment" / "other.yaml").write_text(
        "experiment:\n  output_dir: results\n"
    )
    run_dir = project_dir / "results" / "demo" / "2026-11-09" / "09-00-00"
    run_dir.mkdir(parents=True)
    (run_dir / "config.yaml").write_text("experiment:\n  name: demo\n")

    project_id = register(client, project_dir)
    ids = [run["id"] for run in client.get(
        f"/api/projects/{project_id}/runs"
    ).json()]
    assert ids[0] == "demo/2026-11-09/09-00-00"
    detail = client.get(f"/api/projects/{project_id}/runs/{ids[0]}")
    assert detail.status_code == 200
