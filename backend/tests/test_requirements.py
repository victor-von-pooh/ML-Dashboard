import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core.models import RequirementReport
from ml_dashboard.core.requirements import (
    REPORT_CACHE,
    REPORT_MARK,
    describe_missing,
    describe_warnings,
    is_old_version,
    parse_output,
    read_requires,
    requires_status,
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
    # 版を書かない版の ML-Found でも, 版と下限の欄は null で返す
    check = items["rl"]["checks"][0]
    assert {key: check[key] for key in ("kind", "name", "ok")} == {
        "kind": "module", "name": "gymnasium", "ok": True
    }
    assert check["version"] is None

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
    印の無い出力, ML-Found が describe_requirements を持たない場合,
    形の違う項目と危ない URL の扱いを確かめる関数

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
    assert old.error is not None and "持たない版" in old.error

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
        "requires": [], "missing": [], "unknown": [], "unchecked": [],
        "error": None,
        "check_error": None, "python": None
    }
    wrong = client.post(f"{base}/requires", json={"text": "requires: rl"})
    assert wrong.json()["error"] is not None
    broken = client.post(f"{base}/requires", json={"text": "a: ["}).json()
    assert broken["requires"] == [] and broken["error"] is None
    # 解決できない参照は 500 にせず書き方の誤り, default の値の参照は読める
    oops = client.post(
        f"{base}/requires", json={"text": "requires: ${oops}"}
    ).json()
    assert oops["requires"] == [] and "requires" in oops["error"]
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\nrequires: []\n"
        "needs: [ros2]\n"
    )
    referenced = client.post(
        f"{base}/requires", json={"text": "requires: ${needs}"}
    ).json()
    assert referenced["requires"] == ["ros2"]
    assert [item["name"] for item in referenced["missing"]] == ["ros2"]
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


def test_unchecked_and_empty_registry() -> None:
    """
    入っているかを確かめられなかった機能の注意と, 空の登録簿の文を
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    item = {
        "name": "cuda", "description": "d",
        "checks": [{"kind": "function", "name": "f", "ok": None,
                    "error": "boom"}],
        "match": "all", "available": None,
        "install": {"kind": "guide", "url": "https://example.org/"},
        "note": None
    }
    report = to_report("py", "now", {"requirements": [item]})
    status = requires_status(["cuda"], report)
    assert status.missing == [] and status.unchecked == ["cuda"]
    assert any("cuda" in text for text in describe_warnings(status))

    empty = to_report("py", "now", {"requirements": []})
    assert empty.error == "ML-Found の登録簿の結果に機能がありません"
    assert isinstance(empty, RequirementReport)


def rl_item(
    checks: list[dict[str, Any]], match: str = "all",
    available: Optional[bool] = False
) -> dict[str, Any]:
    """
    確かめの結果を差し込んだ, 強化学習の機能の項目を作る関数

    Parameters
    ----------
    checks: list[dict[str, Any]]
        確かめ方ごとの結果
    match: str = "all"
        all か any
    available: Optional[bool] = False
        全体の判定

    Returns
    ----------
    item: dict[str, Any]
        ML-Found の describe_requirements の 1 項目の形
    """
    item = {
        "name": "rl", "description": "d", "checks": checks,
        "match": match, "available": available,
        "install": {"kind": "pip", "packages": ["gymnasium>=1.0"],
                    "command": 'pip install "gymnasium>=1.0"'},
        "note": None
    }

    return item


def test_old_version() -> None:
    """
    版の古い追加の依存を, 入っていない時と分けて起動を止める文に書き,
    版を読めない時と版を書かない版の ML-Found の結果は今のまま読むことを
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    old = {"kind": "module", "name": "gymnasium", "ok": False,
           "error": "版 0.29.1 は古い. 1.0 以上が要る",
           "version": "0.29.1", "min_version": "1.0"}
    absent = {"kind": "module", "name": "gymnasium", "ok": False,
              "error": None, "version": None, "min_version": "1.0"}
    unread = {"kind": "module", "name": "gymnasium", "ok": True,
              "error": "版を読めないので 1.0 以上かを確かめていない",
              "version": None, "min_version": "1.0"}
    legacy = {"kind": "module", "name": "gymnasium", "ok": False,
              "error": None}
    ros2 = {
        "name": "ros2", "description": "d",
        "checks": [{"kind": "module", "name": "rclpy", "ok": False,
                    "error": None}],
        "match": "all", "available": False,
        "install": {"kind": "guide", "url": "https://docs.ros.org/"},
        "note": None
    }

    # 版が古い時は版と下限を出し, 入っていない機能とは分ける
    report = to_report("py", "now", {"requirements": [rl_item([old]), ros2]})
    assert report.requirements[0].checks[0].version == "0.29.1"
    assert report.requirements[0].checks[0].min_version == "1.0"
    assert is_old_version(report.requirements[0])
    status = requires_status(["rl", "ros2"], report)
    message = describe_missing(status)
    assert "ros2 が入っていません" in message
    assert (
        "rl は入っている版が古いです (gymnasium 0.29.1, 1.0 以上が要る)"
        in message
    )
    assert 'pip install "gymnasium>=1.0"' in message

    # 無い時, 版を読めない時, 書かない版の ML-Found の結果は今のまま
    for checks, available in (
        ([absent], False), ([unread], True), ([legacy], False)
    ):
        payload = {"requirements": [rl_item(checks, available=available)]}
        item = to_report("py", "now", payload).requirements[0]
        assert not is_old_version(item)
    legacy_report = to_report(
        "py", "now", {"requirements": [rl_item([legacy])]}
    )
    assert legacy_report.requirements[0].checks[0].version is None
    message = describe_missing(requires_status(["rl"], legacy_report))
    assert "rl が入っていません" in message
    assert "版が古い" not in message

    # 全てが要る機能は, 入っていない確かめ方が残れば「入っていない」.
    # どれか 1 つの機能は, 版の古いものを入れ替えれば満たせる
    mixed = [old, {**absent, "name": "other", "min_version": None}]
    assert not is_old_version(
        to_report("py", "now", {"requirements": [rl_item(mixed)]})
        .requirements[0]
    )
    assert is_old_version(
        to_report("py", "now", {"requirements": [rl_item(mixed, "any")]})
        .requirements[0]
    )
