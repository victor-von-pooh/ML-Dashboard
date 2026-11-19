import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from ml_dashboard.app import create_app
from ml_dashboard.core.models import History
from ml_dashboard.core.runs import last_metrics, read_history_csv

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

    # ホストが同じでもポートが違えば別のサイト
    other_port = client.post(
        "/api/projects", json={"path": str(project_dir)},
        headers={"Origin": "http://testserver:3000"}
    )
    assert other_port.status_code == 403

    same = client.post(
        "/api/projects", json={"path": str(project_dir)},
        headers={"Origin": "http://testserver"}
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


def test_token_required(tmp_path: Path) -> None:
    """
    起動ごとのトークンが無い API の呼び出しを拒否することを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    app = create_app(tmp_path / "home", token="secret")
    client = TestClient(app)

    # トークンが無いか違う場合は 401
    assert client.get("/api/projects").status_code == 401
    wrong = client.get("/api/projects", headers={"x-dashboard-token": "x"})
    assert wrong.status_code == 401
    assert client.get("/api/auth?token=x").status_code == 401
    assert client.get("/api/auth?token=%C3%A9").status_code == 401
    non_ascii = client.get(
        "/api/projects", headers={"x-dashboard-token": b"r\xe9"}
    )
    assert non_ascii.status_code == 401

    # ヘッダーのトークンか, URL で受け取って保存した Cookie で利用可能
    header = client.get(
        "/api/projects", headers={"x-dashboard-token": "secret"}
    )
    assert header.status_code == 200
    auth = client.get("/api/auth?token=secret", follow_redirects=False)
    assert auth.status_code == 303
    assert "httponly" in auth.headers["set-cookie"].lower()
    assert client.get("/api/projects").status_code == 200


def test_broken_history_rows(tmp_path: Path) -> None:
    """
    epoch が数値でない行を持つ history.csv で, その行を捨てることを確かめる
    関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # 壊れた行と列の数の違う行を混ぜる
    path = tmp_path / "history.csv"
    path.write_text(
        "epoch,train/loss\n1,0.5\nbroken,0.4\n2,0.3,9\n3,0.2\n",
        encoding="utf-8"
    )
    history = read_history_csv(path)
    assert [row["epoch"] for row in history.rows] == [1.0, 2.0, 3.0]
    assert history.rows[1]["train/loss"] == 0.3


def test_unreadable_run_json_notice(
    client: TestClient, project_dir: Path
) -> None:
    """
    run.json が壊れている実験の詳細に, 注意を出すことを確かめる関数

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
    # 読める run.json では注意なし, 途中で切れた run.json では注意
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00"
    assert client.get(base).json()["notices"] == []
    run_dir = project_dir / "outputs/demo/2026-11-08/10-00-00"
    (run_dir / "run.json").write_text('{"status": "comp', encoding="utf-8")
    notices = client.get(base).json()["notices"]
    assert any("run.json を読めません" in notice for notice in notices)


def test_newer_format_notice(
    client: TestClient, project_dir: Path
) -> None:
    """
    知らない新しい版の run.json と source.yaml の実験に, 注意を出しつつ
    表示することを確かめる関数

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
    # 知っている版 (1) では注意なし
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00"
    run_dir = project_dir / "outputs/demo/2026-11-08/10-00-00"
    status = {
        "format_version": 1, "status": "completed", "completed_epochs": 10
    }
    (run_dir / "run.json").write_text(json.dumps(status), encoding="utf-8")
    (run_dir / "source.yaml").write_text(
        "format_version: 1\nscript: train.py\n", encoding="utf-8"
    )
    assert client.get(base).json()["notices"] == []

    # 新しい版で知らない項目があっても, 読める項目で表示して注意
    status["format_version"] = 2
    status["unknown_key"] = {"nested": True}
    (run_dir / "run.json").write_text(json.dumps(status), encoding="utf-8")
    (run_dir / "source.yaml").write_text(
        "format_version: 3\nscript: train.py\nnew_key: 1\n", encoding="utf-8"
    )
    detail = client.get(base).json()
    assert detail["status"] == status["status"]
    assert detail["source"]["script"] == "train.py"
    notices = detail["notices"]
    assert len(notices) == 1
    assert "run.json (版 2)" in notices[0]
    assert "source.yaml (版 3)" in notices[0]


def test_last_metrics_with_valid_interval() -> None:
    """
    検証の間隔が 2 以上の実験で, 最後の検証の値を補うことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 間隔 2 の学習中 (エポック 3 は検証しない) の推移
    history = History(
        columns=["epoch", "train/loss", "valid/loss", "train_eval/loss"],
        rows=[
            {
                "epoch": 1.0, "train/loss": 0.9, "valid/loss": None,
                "train_eval/loss": None
            },
            {
                "epoch": 2.0, "train/loss": 0.8, "valid/loss": 0.7,
                "train_eval/loss": 0.75
            },
            {
                "epoch": 3.0, "train/loss": 0.6, "valid/loss": None,
                "train_eval/loss": None
            },
        ]
    )

    # 検証の値は最後に検証したエポック 2, 学習の値はエポック 3
    metrics = last_metrics(history, 2)
    assert metrics == {
        "train/loss": 0.6, "valid/loss": 0.7, "train_eval/loss": 0.75
    }

    # 間隔が 1 (既定) と, 読めない値の場合は空のまま (nan などの欠け)
    assert last_metrics(history)["valid/loss"] is None
    assert last_metrics(history, "x")["valid/loss"] is None

    # ログから作った推移 (検証しないエポックに valid/ の項目が無い)
    logged = History(
        columns=history.columns,
        rows=[history.rows[1], {"epoch": 3.0, "train/loss": 0.6}]
    )
    assert last_metrics(logged, 2) == metrics

    # 1 度も検証していない場合と, 推移が空の場合
    first = History(columns=history.columns, rows=history.rows[:1])
    assert last_metrics(first, 2)["valid/loss"] is None
    assert last_metrics(History(columns=[], rows=[]), 2) == {}


def test_valid_interval_summary(
    client: TestClient, project_dir: Path
) -> None:
    """
    検証の間隔を空けた実験の最新の値とベストのエポックを確かめる関数

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
    # 間隔 2 で 3 エポックまで学習した途中 (run.json の無い学習中の実験)
    run_dir = write_run(
        project_dir, "12-30-00",
        history=(
            "epoch,train/loss,lr,valid/loss,valid/acc\n"
            "1,0.9,0.1,,\n2,0.8,0.1,0.7,0.6\n3,0.6,0.1,,\n"
        )
    )
    (run_dir / "config.yaml").write_text(
        "experiment:\n  name: demo\ntrainer:\n  epochs: 10\n"
        "  valid_every_n_epochs: 2\n  monitor: valid/acc\n  mode: max\n"
    )
    project_id = register(client, project_dir)
    base = f"/api/projects/{project_id}/runs/demo/2026-11-08/12-30-00"
    detail = client.get(base).json()

    # 検証の値は最後に検証したエポック 2, ベストは検証したエポックから
    assert detail["final_metrics"]["valid/acc"] == 0.6
    assert detail["final_metrics"]["train/loss"] == 0.6
    assert detail["best"]["epoch"] == 2
    assert detail["best"]["value"] == 0.6

    # config.yaml に間隔が無い場合は, ログの検証の間隔の行から
    (run_dir / "config.yaml").write_text(
        "experiment:\n  name: demo\ntrainer:\n  epochs: 10\n"
        "  monitor: valid/acc\n  mode: max\n"
    )
    assert client.get(base).json()["final_metrics"]["valid/acc"] is None
    (run_dir / "train.log").write_text(
        (run_dir / "train.log").read_text()
        + "2026-11-08 12:30:00,000 - ml_found - INFO - 検証の間隔: 2 "
        "エポックごとと予定の最後のエポック (10). 判定もこのエポックだけ\n"
    )
    detail = client.get(base).json()
    assert detail["final_metrics"]["valid/acc"] == 0.6
