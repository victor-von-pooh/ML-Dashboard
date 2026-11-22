import os
import sys
import types
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from test_api import register


def write_problem(
    home: Path, key: str, body: dict[str, object], stamp: float
) -> Path:
    """
    ML-Pathfinder の置き場の形で問題の設定を書く関数

    Parameters
    ----------
    home: Path
        ML-Pathfinder の置き場
    key: str
        問題の設定の識別子 (ディレクトリの名前)
    body: dict[str, object]
        問題の設定
    stamp: float
        更新時刻 (並びを決めるため)

    Returns
    ----------
    path: Path
        書いた problem.yaml
    """
    path = home / "problems" / key / "problem.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump(body, allow_unicode=True))
    os.utime(path, (stamp, stamp))

    return path


def test_recorded_projects(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    問題の設定に記録された, 今あり登録していないプロジェクトだけを, 新しい
    順に 1 件ずつ並べ, 選んで登録すると一覧から外れることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数の差し替え

    Returns
    ----------
    None
    """
    # 置き場が無ければ空
    home = tmp_path / "pathfinder"
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(home))
    url = "/api/problems/projects"
    response = client.get(url)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "root": str(home.resolve() / "problems"), "projects": [],
        "skipped": [], "error": None
    }

    # 同じプロジェクトを記録した 2 つ, 消したプロジェクト, config の無い
    # 場所, 記録の無いもの, 相対パス, 読めないもの, 新しい版
    other = tmp_path / "plain"
    other.mkdir()
    write_problem(home, "old", {
        "format_version": 2, "name": "古い",
        "project": {"path": str(project_dir)}
    }, 1_000)
    newer = write_problem(home, "new", {
        "format_version": 2, "name": "売上",
        "project": {"path": str(project_dir)}
    }, 2_000)
    write_problem(home, "gone", {
        "format_version": 2, "name": "消した",
        "project": {"path": str(tmp_path / "gone")}
    }, 3_000)
    write_problem(home, "plain", {
        "format_version": 2, "project": {"path": str(other)}
    }, 3_000)
    write_problem(home, "draft", {"format_version": 2, "name": "下書き"}, 0)
    write_problem(home, "relative", {
        "format_version": 2, "project": {"path": "workspace/demo_task"}
    }, 0)
    broken = home / "problems" / "broken" / "problem.yaml"
    broken.parent.mkdir()
    broken.write_text("name: [\n")
    future = write_problem(home, "future", {
        "format_version": 3, "project": {"path": str(project_dir)}
    }, 0)
    body = client.get(url).json()
    assert body["projects"] == [{
        "path": str(project_dir.resolve()), "name": "demo_task",
        "problem": "売上", "problem_path": str(newer),
        "updated_at": body["projects"][0]["updated_at"]
    }]
    assert body["projects"][0]["updated_at"]
    assert len(body["skipped"]) == 1 and str(future) in body["skipped"][0]

    # 登録すると一覧から外れる
    register(client, project_dir)
    assert client.get(url).json()["projects"] == []


def test_problem_trainings(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    問題の設定ごとの学習で監視する指標と向きを ML-Quest の受け渡しから
    受け取り, 渡せないものは理由と一緒に新しい順に並べることを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数の差し替え

    Returns
    ----------
    None
    """
    # 置き場が無ければ空
    quest = pytest.importorskip("ml_quest")
    home = tmp_path / "pathfinder"
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(home))
    url = "/api/problems/training"
    response = client.get(url)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "root": str(home.resolve() / "problems"), "problems": [],
        "error": None
    }

    # 学習する見本 (記録したプロジェクトの場所付き), 既製のモデル,
    # 機械学習を使わない見本, 読めないもの
    project = str(tmp_path / "own")
    sales = quest.example_problem("総菜の作る量")
    sales["project"] = {"path": project}
    pretrained = quest.example_problem("写真の仕分け (既製のモデル)")
    no_ml = quest.example_problem("問い合わせの振り分け (機械学習を使わない)")
    for key, problem, stamp in [
        ("sales", sales, 400), ("pretrained", pretrained, 300),
        ("no_ml", no_ml, 200)
    ]:
        path = home / "problems" / key / "problem.yaml"
        quest.save_problem(problem, path)
        os.utime(path, (stamp, stamp))
    broken = home / "problems" / "broken" / "problem.yaml"
    broken.parent.mkdir(parents=True)
    broken.write_text("format_version: [\n")
    os.utime(broken, (100, 100))

    # 値は ML-Quest の受け渡しと同じ (ML-Found の trainer.monitor と mode)
    result = client.get(url).json()
    problems = result["problems"]
    assert [item["problem"] for item in problems] == [
        "総菜の作る量", "写真の仕分け (既製のモデル)",
        "問い合わせの振り分け (機械学習を使わない)", "broken"
    ]
    expected = quest.handoff(sales)["training"]
    first = problems[0]
    assert (first["monitor"], first["mode"]) == (
        expected["monitor"], expected["mode"]
    )
    assert (first["monitor"], first["mode"]) == ("valid/mae", "min")
    assert first["project_path"] == project
    assert first["reason"] is None
    assert first["problem_path"].endswith("sales/problem.yaml")
    assert first["updated_at"] is not None

    # 渡せないものは値が無く, 理由がある
    for item in problems[1:]:
        assert item["monitor"] is None and item["mode"] is None
    assert "既製のモデル" in problems[1]["reason"]
    assert "後ろの段階に渡せません" in problems[2]["reason"]
    assert "読めません" in problems[3]["reason"]


def test_problem_trainings_without_quest(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    ML-Quest が無いか古い場合は 501 で入れ方を案内し, 書き出した
    プロジェクトの一覧は今までどおり読めることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        モジュールと環境変数の差し替え

    Returns
    ----------
    None
    """
    # 入っていない (読み込みが ImportError になる)
    monkeypatch.setenv("ML_PATHFINDER_HOME", str(tmp_path / "pathfinder"))
    monkeypatch.setitem(sys.modules, "ml_quest", None)
    response = client.get("/api/problems/training")
    assert response.status_code == 501
    assert "ml_quest が入っていません" in response.json()["detail"]
    assert "uv sync --extra problem" in response.json()["detail"]
    assert client.get("/api/problems/projects").status_code == 200

    # handoff の無い古い版
    monkeypatch.setitem(sys.modules, "ml_quest", types.ModuleType("ml_quest"))
    response = client.get("/api/problems/training")
    assert response.status_code == 501
    assert "handoff がありません" in response.json()["detail"]
