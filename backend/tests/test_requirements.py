import json
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core.requirements import (
    REPORT_CACHE,
    REPORT_MARK,
    parse_output,
    read_requires,
    to_report,
)

# 読み込まれたら印のファイルを書く, Gymnasium の代わりのパッケージ
# (確かめが import せずに find_spec で探すことを見るため)
FAKE_GYMNASIUM = """\
from pathlib import Path
Path(__file__).with_name("imported").write_text("yes")
"""


@pytest.fixture(autouse=True)
def clear_cache() -> Iterator[None]:
    """
    テストの間で, 確かめた結果を持ち越さないようにする関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    REPORT_CACHE.clear()
    yield
    REPORT_CACHE.clear()


def register_with(
    client: TestClient, project_dir: Path, python: str = sys.executable
) -> str:
    """
    Python を指定してプロジェクトを登録する関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    python: str = sys.executable
        プロジェクトの Python

    Returns
    ----------
    project_id: str
        登録したプロジェクトの ID
    """
    response = client.post(
        "/api/projects", json={"path": str(project_dir), "python": python}
    )
    assert response.status_code == 201
    project_id: str = response.json()["id"]

    return project_id


def add_fake_gymnasium(project_dir: Path) -> Path:
    """
    プロジェクトのディレクトリに Gymnasium の代わりのパッケージを置く関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    package: Path
        置いたパッケージのディレクトリ
    """
    package = project_dir / "gymnasium"
    package.mkdir()
    (package / "__init__.py").write_text(FAKE_GYMNASIUM, encoding="utf-8")

    return package


def write_fake_python(directory: Path, body: str) -> str:
    """
    決まった出力を返す, Python の代わりの実行ファイルを作る関数

    Parameters
    ----------
    directory: Path
        置くディレクトリ
    body: str
        シェルのスクリプトの本文

    Returns
    ----------
    python: str
        実行ファイルのパス (名前は python3)
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "python3"
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    python = str(path)

    return python


def test_report_uses_project_python_and_dir(
    client: TestClient, project_dir: Path
) -> None:
    """
    登録簿の全ての機能を, プロジェクトの Python とディレクトリで import
    せずに確かめ, 結果を覚えて確かめ直しで読み直すことを確かめる関数

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
    project_id = register_with(client, project_dir)
    url = f"/api/projects/{project_id}/requirements"

    response = client.get(url)
    assert response.status_code == 200
    report = response.json()
    assert report["error"] is None
    assert report["python"] == sys.executable
    items = {item["name"]: item for item in report["requirements"]}
    assert {"rl", "mujoco", "ros2", "cuda"} <= set(items)
    assert items["ros2"]["available"] is False
    assert items["ros2"]["install"]["kind"] == "guide"
    assert items["ros2"]["install"]["url"].startswith("https://")
    assert items["rl"]["install"]["command"].startswith("pip install")
    assert items["rl"]["install"]["extra_command"]
    rl_before = items["rl"]["available"]

    # 覚えた結果を返し, 確かめ直しではプロジェクトの中のパッケージも見つける
    package = add_fake_gymnasium(project_dir)
    cached = client.get(url).json()
    assert cached["checked_at"] == report["checked_at"]
    assert cached["requirements"][0]["available"] == rl_before
    fresh = client.get(url, params={"refresh": "true"}).json()
    items = {item["name"]: item for item in fresh["requirements"]}
    assert items["rl"]["available"] is True
    assert items["rl"]["checks"][0] == {
        "kind": "module", "name": "gymnasium", "ok": True, "error": None
    }

    # 探すだけで読み込まず, ダッシュボードのプロセスにも読み込まない
    assert not (package / "imported").exists()
    assert "gymnasium" not in sys.modules or rl_before

    missing = client.get("/api/projects/missing/requirements")
    assert missing.status_code == 404


def test_report_errors(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    動かない Python と読めない出力で, 確かめられない理由を返すことを
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
    broken = write_fake_python(
        tmp_path / "broken", "echo 'no torch here' >&2\nexit 3"
    )
    project_id = register_with(client, project_dir, broken)
    report = client.get(f"/api/projects/{project_id}/requirements").json()
    assert report["requirements"] == []
    assert "終了コード 3" in report["error"]
    assert "no torch here" in report["error"]

    # 起動の前の requires の確かめは, 確かめられなくても止めない
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\nrequires: [rl]\n"
    )
    status = client.post(
        f"/api/projects/{project_id}/requires", json={"text": ""}
    ).json()
    assert status["requires"] == ["rl"]
    assert status["missing"] == []
    assert status["error"] is None
    assert "終了コード 3" in status["check_error"]


def test_parse_and_report_shapes() -> None:
    """
    印の無い出力, ML-Found が古い場合, 形の違う項目と危ない URL の扱いを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    assert parse_output("hello\n") is None
    assert parse_output(f"{REPORT_MARK}{{broken\n") is None
    assert parse_output(f"log\n{REPORT_MARK}{{\"a\": 1}}\n") == {"a": 1}

    old = to_report("py", "now", {"error": "ImportError: cannot import"})
    assert old.requirements == []
    assert old.error is not None and "古い" in old.error

    good = {
        "name": "x", "description": "d",
        "checks": [{"kind": "module", "name": "m", "ok": False,
                    "error": None}],
        "match": "all", "available": False,
        "install": {"kind": "guide", "extra": None, "packages": [],
                    "url": "javascript:alert(1)", "command": None,
                    "extra_command": None},
        "note": None
    }
    report = to_report("py", "now", {"requirements": [good, {"name": 1}]})
    assert [item.name for item in report.requirements] == ["x"]
    assert report.requirements[0].install.url is None
    assert report.error is not None and "1 個" in report.error


def test_read_requires() -> None:
    """
    config の requires の書き方の確かめを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    assert read_requires({}) == ([], None)
    assert read_requires({"requires": None}) == ([], None)
    assert read_requires({"requires": ["rl", "cuda"]}) == (
        ["rl", "cuda"], None
    )
    for value in ("rl", ["rl", 1], [""], {"rl": True}):
        names, error = read_requires({"requires": value})
        assert names == [] and error is not None
    names, error = read_requires({"requires": ["rl", "rl"]})
    assert error is not None and "2 回" in error


def test_requires_blocks_start(
    client: TestClient, project_dir: Path
) -> None:
    """
    足りない機能を書いた config は, 確かめと起動が次の一手を添えて
    止まり, 登録簿に無い名前は注意だけになることを確かめる関数

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
    # experiment で置き換えられるように, default に空のリストを書く
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\nrequires: []\n"
    )
    add_fake_gymnasium(project_dir)
    project_id = register_with(client, project_dir)
    base = f"/api/projects/{project_id}"

    # 画面がボタンを止めるのに使う軽い確かめ
    status = client.post(
        f"{base}/requires",
        json={"text": "requires: [rl, ros2, unknown_feature]",
              "script": "train.py"}
    ).json()
    assert status["requires"] == ["rl", "ros2", "unknown_feature"]
    assert [item["name"] for item in status["missing"]] == ["ros2"]
    assert status["unknown"] == ["unknown_feature"]
    assert status["error"] is None

    empty = client.post(f"{base}/requires", json={"text": ""}).json()
    assert empty == {
        "requires": [], "missing": [], "unknown": [], "error": None,
        "check_error": None, "python": None
    }
    wrong = client.post(f"{base}/requires", json={"text": "requires: rl"})
    assert wrong.json()["error"] is not None
    broken = client.post(f"{base}/requires", json={"text": "a: ["}).json()
    assert broken["requires"] == [] and broken["error"] is None
    bad_script = client.post(
        f"{base}/requires", json={"text": "", "script": "evil.py"}
    )
    assert bad_script.status_code == 400

    # 起動の前の確認と起動は, 足りない機能の次の一手を添えて止まる
    checked = client.post(
        f"{base}/validate", json={"text": "requires: [rl, ros2]"}
    ).json()
    assert checked["ok"] is False
    assert "ros2" in checked["error"]
    assert "https://docs.ros.org/" in checked["error"]
    created = client.post(
        f"{base}/jobs",
        json={"script": "train.py", "config_text": "requires: [ros2]"}
    )
    assert created.status_code == 400
    assert "ros2" in created.json()["detail"]
    assert client.get("/api/jobs").json() == []

    # 書き方の誤りも止まり, 入っている機能と登録簿に無い名前は通る
    wrong_checked = client.post(
        f"{base}/validate", json={"text": "requires: rl"}
    ).json()
    assert wrong_checked["ok"] is False
    assert "requires" in wrong_checked["error"]
    passed = client.post(
        f"{base}/validate", json={"text": "requires: [rl, unknown_feature]"}
    ).json()
    assert passed["ok"] is True
    assert any("unknown_feature" in item for item in passed["warnings"])
    assert json.dumps(passed["diff"]).count("requires") == 1
