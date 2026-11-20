import os
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
