import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from conftest import write_run
from test_api import register

# 任意のファイルを持つ実験と, 前からの形の画像だけを持つ実験の場所
RESULTS_RUN = "demo/2026-11-08/10-00-00"
LEGACY_RUN = "demo/2026-11-08/11-00-00"
BASE_RUN = "demo/2026-11-08/09-00-00"

TASK_TEXT = """\
format_version: 1
role: predict
output: shape
what: 撮影ごとの物の表面の点群
target:
  kind: point_cloud
  origin:
    type: process
    name: 再構成の処理
    settings:
      voxel: 0.01
method: finetune
base:
  experiment: outputs/demo/2026-11-08/09-00-00
  weights: null
dataset:
  path: outputs/dataset
  name: captures
  format_version: 2
"""


def write_json(path: Path, data: Any) -> None:
    """
    JSON のファイルを書く関数

    Parameters
    ----------
    path: Path
        書く先
    data: Any
        中身

    Returns
    ----------
    None
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def write_results(run_dir: Path) -> None:
    """
    task.yaml, evaluations/, samples/ を ML-Found の約束の形で書く関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    None
    """
    (run_dir / "task.yaml").write_text(TASK_TEXT, encoding="utf-8")

    # 表 (守る指標), 曲線, 形の違うファイル, 一時ファイル
    evaluations = run_dir / "evaluations"
    write_json(evaluations / "by_group.json", {
        "name": "by_group", "split": "test", "kind": "table", "x": None,
        "columns": ["group", "chamfer", "diff"],
        "rows": [
            {"group": "a", "chamfer": 0.1, "diff": -0.01},
            {"group": "b", "chamfer": None, "diff": 0.02}
        ],
        "description": "グループごとの距離", "baseline": "今の処理",
        "guard": False, "epoch": 9, "created_at": "2026-11-19T10:00:00+09:00"
    })
    write_json(evaluations / "recall.json", {
        "name": "recall", "split": "valid", "kind": "curve", "x": "k",
        "columns": ["k", "recall"],
        "rows": [{"k": 1, "recall": 0.5}, {"k": 5, "recall": 0.8}],
        "description": None, "baseline": None, "guard": False,
        "epoch": None, "created_at": "2026-11-19T10:00:00+09:00"
    })
    write_json(evaluations / "safety.json", {
        "name": "safety", "split": "test", "kind": "table", "x": None,
        "columns": ["metric", "value"],
        "rows": [{"metric": "miss", "value": 0.01}],
        "description": "見逃し", "baseline": None, "guard": True,
        "epoch": 9, "created_at": "2026-11-19T10:00:00+09:00"
    })
    write_json(evaluations / "broken.json", {"name": "broken", "rows": 3})
    write_json(evaluations / ".tmp.json.x.tmp", {"name": "temp"})

    # 名前ごとのディレクトリの見本, 外を指す項目, 無いファイル, 直下の画像
    samples = run_dir / "samples"
    (samples / "recon").mkdir(parents=True)
    (samples / "recon" / "epoch_0005.png").write_bytes(b"\x89PNG")
    (samples / "recon" / "final.png").write_bytes(b"\x89PNG")
    (samples / "caption").mkdir()
    (samples / "caption" / "epoch_0005.txt").write_text("文の見本")
    (samples / "voice").mkdir()
    (samples / "voice" / "final.wav").write_bytes(b"RIFF0000WAVE")
    (samples / "cloud").mkdir()
    (samples / "cloud" / "final.ply").write_text(
        "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n"
        "property float y\nproperty float z\nend_header\n0 0 0\n"
    )
    (samples / "epoch_010.png").write_bytes(b"\x89PNG")
    (run_dir / "secret.txt").write_text("外")
    items = [
        {"epoch": 5, "name": "recon", "kind": "image",
         "file": "recon/epoch_0005.png", "split": "valid",
         "caption": "復元", "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": None, "name": "recon", "kind": "image",
         "file": "recon/final.png", "split": "test", "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": 5, "name": "caption", "kind": "text",
         "file": "caption/epoch_0005.txt", "split": None, "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": None, "name": "voice", "kind": "audio",
         "file": "voice/final.wav", "split": None, "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": None, "name": "cloud", "kind": "point_cloud",
         "file": "cloud/final.ply", "split": None, "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": 1, "name": "evil", "kind": "text",
         "file": "../secret.txt", "split": None, "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"},
        {"epoch": 1, "name": "gone", "kind": "image",
         "file": "gone/epoch_0001.png", "split": None, "caption": None,
         "created_at": "2026-11-19T10:00:00+09:00"}
    ]
    write_json(samples / "index.json", {"samples": items})


def results_url(project_id: str, run_id: str) -> str:
    """
    実験の任意のファイルの API の URL を返す関数

    Parameters
    ----------
    project_id: str
        プロジェクトの ID
    run_id: str
        実験の ID

    Returns
    ----------
    url: str
        URL
    """
    url = f"/api/projects/{project_id}/runs/{run_id}/results"

    return url


def test_results(client: TestClient, project_dir: Path) -> None:
    """
    task.yaml, evaluations/, samples/ を読んで返すことを確かめる関数

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
    write_run(project_dir, "09-00-00")
    write_results(project_dir / "outputs" / RESULTS_RUN)
    project_id = register(client, project_dir)
    response = client.get(results_url(project_id, RESULTS_RUN))
    assert response.status_code == 200
    data = response.json()

    # 何の実験か. 処理の出力の正解と, 元にした実験へのつなぎ
    task = data["task"]
    assert task["role"] == "predict"
    assert task["what"] == "撮影ごとの物の表面の点群"
    assert task["target_kind"] == "point_cloud"
    assert task["origin"] == {
        "type": "process", "name": "再構成の処理",
        "settings": {"voxel": 0.01}
    }
    assert "超えられない" in task["origin_note"]
    assert task["newer_version"] is False
    assert task["method"] == "finetune"
    assert task["base_run"] == {"project_id": project_id, "run_id": BASE_RUN}
    assert task["dataset_name"] == "captures"

    # 守る指標を先に, 次に名前の順. 形の違うファイルは注意に
    evaluations = data["evaluations"]
    assert [item["name"] for item in evaluations] == [
        "safety", "by_group", "recall"
    ]
    assert evaluations[0]["guard"] is True
    assert evaluations[1]["columns"] == ["group", "chamfer", "diff"]
    assert evaluations[1]["rows"][1]["chamfer"] is None
    assert evaluations[1]["baseline"] == "今の処理"
    assert evaluations[2]["kind"] == "curve"
    assert evaluations[2]["x"] == "k"
    assert any("evaluations/ の 1 個" in text for text in data["notices"])

    # 一覧の見本だけ (直下の画像は画像の推移で見る). 外と無いファイルは除く
    samples = data["samples"]
    assert [item["path"] for item in samples] == [
        "samples/recon/epoch_0005.png", "samples/recon/final.png",
        "samples/caption/epoch_0005.txt", "samples/voice/final.wav",
        "samples/cloud/final.ply"
    ]
    assert samples[0]["epoch"] == 5
    assert samples[0]["caption"] == "復元"
    assert samples[1]["epoch"] is None
    assert any("2 個の見本" in text for text in data["notices"])

    # 画像の推移に出る直下の画像と名前ごとの画像は, ファイルの一覧にある
    detail = client.get(
        f"/api/projects/{project_id}/runs/{RESULTS_RUN}"
    ).json()
    paths = {item["path"] for item in detail["files"]}
    assert {"samples/epoch_010.png", "samples/recon/epoch_0005.png"} <= paths

    # 音は <audio> で再生できる形, 点群はダウンロード
    base = f"/api/projects/{project_id}/runs/{RESULTS_RUN}/files"
    audio = client.get(f"{base}/samples/voice/final.wav")
    assert audio.status_code == 200
    assert audio.headers["content-type"].startswith("audio/")
    assert "attachment" not in audio.headers.get("content-disposition", "")
    cloud = client.get(f"{base}/samples/cloud/final.ply")
    assert "attachment" in cloud.headers["content-disposition"]
    assert "sandbox" in cloud.headers["content-security-policy"]


def test_results_legacy_and_missing(
    client: TestClient, project_dir: Path
) -> None:
    """
    任意のファイルを持たない実験と, 直下の画像だけの実験は空を返すことを
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
    legacy = project_dir / "outputs" / LEGACY_RUN / "samples"
    legacy.mkdir()
    (legacy / "epoch_010.png").write_bytes(b"\x89PNG")
    (legacy / "epoch_020.png").write_bytes(b"\x89PNG")
    project_id = register(client, project_dir)
    empty = {"task": None, "evaluations": [], "samples": [], "notices": []}
    for run_id in (RESULTS_RUN, LEGACY_RUN):
        response = client.get(results_url(project_id, run_id))
        assert response.status_code == 200
        assert response.json() == empty

    # 無い実験と, 外への移動は 404
    missing = client.get(results_url(project_id, "demo/2026-11-08/12-00-00"))
    assert missing.status_code == 404
    outside = client.get(
        f"/api/projects/{project_id}/runs/demo/2026-11-08/..%2F..%2F/results"
    )
    assert outside.status_code == 404


def test_results_task_versions(client: TestClient, project_dir: Path) -> None:
    """
    新しい版と壊れた版の task.yaml の扱いを確かめる関数

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
    run_dir = project_dir / "outputs" / RESULTS_RUN
    project_id = register(client, project_dir)

    # 新しい版は正解の出どころを分からないものに. 元の実験が無ければ文字
    (run_dir / "task.yaml").write_text(
        TASK_TEXT.replace("format_version: 1", "format_version: 99"),
        encoding="utf-8"
    )
    task = client.get(results_url(project_id, RESULTS_RUN)).json()["task"]
    assert task["newer_version"] is True
    assert task["origin"]["type"] == "unknown"
    assert "新しい版" in task["origin_note"]
    assert task["base_run"] is None
    assert task["base_experiment"] == "outputs/demo/2026-11-08/09-00-00"

    # 版が整数でない task.yaml は無いものとして注意
    (run_dir / "task.yaml").write_text(
        TASK_TEXT.replace("format_version: 1", "format_version: '2'"),
        encoding="utf-8"
    )
    data = client.get(results_url(project_id, RESULTS_RUN)).json()
    assert data["task"] is None
    assert any("task.yaml" in text for text in data["notices"])
