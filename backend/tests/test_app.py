import time
from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ml_dashboard.app import cookie_name, create_api, create_app


def wait_finished(client: TestClient, url: str) -> dict:
    """
    ジョブが終わるまで待つ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    url: str
        ジョブの状態の URL

    Returns
    ----------
    job: dict
        終わったジョブの情報
    """
    # 最大 10 秒まで, 0.05 秒ごとに確認
    for _ in range(200):
        job: dict = client.get(url).json()
        if job["status"] == "finished":
            return job
        time.sleep(0.05)

    raise AssertionError(f"ジョブが終わりませんでした: {job}")


def test_standalone_checks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    単独の起動のアプリが確かめ, /api/auth, 画面の配信を持つことを
    確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        画面の置き場の差し替え

    Returns
    ----------
    None
    """
    # ビルド済みの画面の代わり
    static_dir = (tmp_path / "static").resolve()
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("画面", encoding="utf-8")
    (static_dir / "assets" / "a.js").write_text("1", encoding="utf-8")
    monkeypatch.setattr("ml_dashboard.app.STATIC_DIR", static_dir)
    standalone = create_app(
        tmp_path / "home", token="secret", allowed_hosts=["testserver"]
    )
    client = TestClient(standalone)

    # 違うトークンは 401, 合うトークンは Cookie を置いて画面へ
    assert client.get("/api/auth?token=x").status_code == 401
    # GET でない /api/auth もトークンの確かめの対象
    assert client.post("/api/auth?token=secret").status_code == 401
    assert client.get("/api/projects").status_code == 401
    moved = client.get("/api/auth?token=secret", follow_redirects=False)
    assert moved.status_code == 303 and moved.headers["location"] == "/"
    assert cookie_name("secret").startswith("ml_dashboard_token_")
    assert cookie_name("secret") != cookie_name("other")
    assert cookie_name("secret") in moved.cookies
    assert client.get("/api/projects").json() == []

    # トークンから作らない名前の Cookie では呼べない
    fixed = TestClient(standalone, cookies={"ml_dashboard_token": "secret"})
    assert fixed.get("/api/projects").status_code == 401

    # 別の Origin の書き込みは 403, 別のホスト名は 400
    project = tmp_path / "project"
    (project / "configs" / "default").mkdir(parents=True)
    (project / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
    )
    foreign = client.post(
        "/api/projects", json={"path": str(project)},
        headers={"origin": "http://evil.example"}
    )
    assert foreign.status_code == 403
    other = client.get("/api/projects", headers={"host": "evil.example"})
    assert other.status_code == 400

    # 既定のホスト名は 127.0.0.1 と localhost (テストの名前は受け付けない)
    default = TestClient(create_app(tmp_path / "home", token="secret"))
    assert default.get("/api/auth?token=secret").status_code == 400

    # 画面の配信と, 無い API と仕様の画面の 404 (根の仕様の画面も出さず,
    # 画面の中の移動先として index.html)
    assert client.get("/").text == "画面"
    assert client.get("/projects/x").text == "画面"
    assert client.get("/assets/a.js").text == "1"
    for path in ["/api", "/api/nothing", "/api/openapi.json", "/api/docs"]:
        assert client.get(path).status_code == 404, path
    for path in ["/docs", "/openapi.json"]:
        assert client.get(path).text == "画面", path


def test_create_api_mounted(tmp_path: Path, project_dir: Path) -> None:
    """
    API だけのアプリを別の頭の下に mount して, 確かめ無しでプロジェクトの
    登録と実験の一覧が動き, 確かめを持たないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 殻の代わりのアプリ (確かめは殻が持つので, ここでは付けない)
    shell = FastAPI()
    shell.mount("/api/train", create_api(tmp_path / "home"))
    client = TestClient(shell)

    # トークン無しで, 別の Origin からも呼べる (確かめは殻の役目)
    created = client.post(
        "/api/train/projects", json={"path": str(project_dir)},
        headers={"origin": "http://other.example"}
    )
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    runs = client.get(f"/api/train/projects/{project_id}/runs").json()
    assert len(runs) == 2
    assert (tmp_path / "home" / "projects.json").is_file()

    # 例外ハンドラも mount の下で動く (壊れた登録簿は 500 と理由)
    (tmp_path / "home" / "projects.json").write_text("[", encoding="utf-8")
    broken = client.get("/api/train/projects")
    assert broken.status_code == 500 and broken.json()["detail"]

    # /auth も仕様の画面も持たない
    for path in ["/auth", "/openapi.json", "/docs", "/redoc"]:
        assert client.get(f"/api/train{path}").status_code == 404, path

    # 2 度呼んでも誤りにならず, 別の置き場の別のアプリ
    again = TestClient(create_api(tmp_path / "other"))
    assert again.get("/projects").json() == []


def test_create_api_problems_dir(
    tmp_path: Path, project_dir: Path, pathfinder_home: Path
) -> None:
    """
    問題の設定の一覧が, create_api に渡した置き場か, 渡さなければ
    ML_PATHFINDER_HOME の下を読むことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    project_dir: Path
        プロジェクトのディレクトリ
    pathfinder_home: Path
        環境変数 ML_PATHFINDER_HOME の置き場

    Returns
    ----------
    None
    """
    # 渡した問題の設定の置き場に 1 つ置く (環境変数の置き場とは別)
    problems_dir = tmp_path / "shared" / "problems"
    path = problems_dir / "churn" / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump({
        "format_version": 2, "name": "試し",
        "project": {"path": str(project_dir)}
    }, allow_unicode=True), encoding="utf-8")
    shell = FastAPI()
    shell.mount(
        "/api/train",
        create_api(tmp_path / "home", problems_dir=problems_dir)
    )
    client = TestClient(shell)
    listed = client.get("/api/train/problems/projects").json()
    assert listed["root"] == str(problems_dir)
    assert [item["problem"] for item in listed["projects"]] == ["試し"]

    # 監視する指標と向きも同じ置き場から読む
    pytest.importorskip("ml_quest")
    training = client.get("/api/train/problems/training").json()
    assert training["root"] == str(problems_dir)

    # problems_dir を渡さなければ ML_PATHFINDER_HOME の下の problems
    default = TestClient(create_api(tmp_path / "home"))
    expected = pathfinder_home.resolve() / "problems"
    assert default.get("/problems/projects").json()["root"] == str(expected)


def test_jobs_mounted_apps(tmp_path: Path, project_dir: Path) -> None:
    """
    mount の下で学習のジョブが起動して終わり, 同じプロセスの別の置き場の
    2 つのアプリのジョブの管理がぶつからないことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    # 同じプロセスに, 置き場の違う 2 つのアプリを別の頭で mount
    first = create_api(tmp_path / "first")
    second = create_api(tmp_path / "second")
    assert first.state.jobs is not second.state.jobs
    shell = FastAPI()
    shell.mount("/api/train", first)
    shell.mount("/api/again", second)
    client = TestClient(shell)

    # それぞれで登録して学習を起動
    started = {}
    for prefix in ["/api/train", "/api/again"]:
        created = client.post(
            f"{prefix}/projects", json={"path": str(project_dir)}
        )
        assert created.status_code == 201, created.text
        project_id = created.json()["id"]
        job = client.post(
            f"{prefix}/projects/{project_id}/jobs",
            json={"script": "train.py"}
        )
        assert job.status_code == 201, job.text
        started[prefix] = job.json()["id"]

    # 終わりまで見られ, 出力が読め, 一覧はそれぞれのジョブだけ
    for prefix, job_id in started.items():
        job = wait_finished(client, f"{prefix}/jobs/{job_id}")
        assert job["return_code"] == 0
        output = client.get(f"{prefix}/jobs/{job_id}/output").json()
        assert "train" in output["text"]
        listed = client.get(f"{prefix}/jobs").json()
        assert [item["id"] for item in listed] == [job_id]
    assert (tmp_path / "first" / "jobs" / started["/api/train"]).is_dir()
    assert (tmp_path / "second" / "jobs" / started["/api/again"]).is_dir()
