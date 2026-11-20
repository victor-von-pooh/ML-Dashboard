import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core import results as results_module

from conftest import write_run
from test_api import register

# 任意のファイルを持つ実験と, samples/ の直下の番号付きの画像だけを持つ
# 実験の場所
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
    empty = {"task": None, "evaluations": [], "samples": [], "policy": None,
             "notices": []}
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


@pytest.mark.filterwarnings("ignore::UserWarning")
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


def test_results_guards(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: Any
) -> None:
    """
    シンボリックリンク, 壊れた一覧, NUL 文字の元の実験, 多い行の扱いを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: Any
        pytest の書き換えの道具

    Returns
    ----------
    None
    """
    run_dir = project_dir / "outputs" / RESULTS_RUN
    project_id = register(client, project_dir)
    monkeypatch.setattr(results_module, "MAX_EVALUATION_ROWS", 2)

    # 外のファイルを指すリンクの評価と task.yaml は読まない
    outside = tmp_path / "outside.json"
    write_json(outside, {
        "name": "outside", "split": "test", "kind": "table",
        "columns": ["secret"], "rows": [{"secret": "外"}]
    })
    (run_dir / "evaluations").mkdir()
    (run_dir / "evaluations" / "outside.json").symlink_to(outside)
    write_json(run_dir / "evaluations" / "many.json", {
        "name": "many", "split": "test", "kind": "table",
        "columns": ["a"], "rows": [{"a": i} for i in range(5)]
    })
    outside_task = tmp_path / "task.yaml"
    outside_task.write_text(TASK_TEXT, encoding="utf-8")
    (run_dir / "task.yaml").symlink_to(outside_task)

    # 壊れた見本の一覧は注意
    (run_dir / "samples").mkdir()
    (run_dir / "samples" / "index.json").write_text('{"samples": 3}')

    data = client.get(results_url(project_id, RESULTS_RUN)).json()
    assert data["task"] is None
    assert [item["name"] for item in data["evaluations"]] == ["many"]
    assert len(data["evaluations"][0]["rows"]) == 2
    assert data["evaluations"][0]["total_rows"] == 5
    assert data["samples"] == []
    assert any("samples/index.json" in text for text in data["notices"])

    # 元の実験のパスに NUL 文字があっても, 他は返す
    (run_dir / "task.yaml").unlink()
    (run_dir / "task.yaml").write_text(
        TASK_TEXT.replace(
            "experiment: outputs/demo/2026-11-08/09-00-00",
            'experiment: "a\\0b"'
        ),
        encoding="utf-8"
    )
    response = client.get(results_url(project_id, RESULTS_RUN))
    assert response.status_code == 200
    assert response.json()["task"]["base_run"] is None


def test_mask_and_cloud_samples(
    client: TestClient, project_dir: Path
) -> None:
    """
    ML-Found の save_sample で書いた領域の見本の凡例と, 点群の見本の元の
    座標への戻しを確かめる関数

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
    import numpy as np
    from ml_found import save_sample

    # 名前のある領域の見本, 名前の無い領域の見本, 正規化した点群, 値の
    # 決まりの無い点群, 単位だけの点群
    run_dir = project_dir / "outputs" / RESULTS_RUN
    mask = np.array([[0, 1], [2, 2]])
    save_sample(run_dir, "mask", mask, epoch=1, kind="mask",
                classes=["background", "road"])
    save_sample(run_dir, "plain", mask, kind="mask")
    points = np.array([[0.0, 0.5, 1.0], [1.0, 0.0, -1.0]])
    save_sample(run_dir, "cloud", points, kind="point_cloud",
                convention={"units": "m", "scale": 2.0,
                            "shift": [1.0, 0.0, -3.0]})
    save_sample(run_dir, "raw", points, kind="point_cloud")
    save_sample(run_dir, "metric", points, kind="point_cloud",
                convention={"units": "mm"})
    project_id = register(client, project_dir)
    samples = {
        item["name"]: item
        for item in client.get(results_url(project_id, RESULTS_RUN))
        .json()["samples"]
    }

    # 領域は mask の種類で, 番号の順の凡例 (名前の無い番号は null)
    assert samples["mask"]["kind"] == "mask"
    assert samples["mask"]["path"] == "samples/mask/epoch_0001.png"
    assert samples["mask"]["classes"] == [
        {"id": 0, "name": "background", "color": "#000000"},
        {"id": 1, "name": "road", "color": "#800000"},
        {"id": 2, "name": None, "color": "#008000"}
    ]
    assert [row["name"] for row in samples["plain"]["classes"]] == [
        None, None, None
    ]
    assert samples["cloud"]["classes"] is None
    assert samples["cloud"]["newer_version"] is False

    # 元の座標は 値 × scale - shift (ML-Found の original_coordinates)
    url = f"/api/projects/{project_id}/runs/{RESULTS_RUN}/samples/cloud"
    cloud = client.get(url, params={"path": samples["cloud"]["path"]})
    assert cloud.status_code == 200
    assert cloud.json() == {
        "vertices": 2, "points": points.tolist(),
        "original": [[-1.0, 1.0, 5.0], [1.0, 0.0, 1.0]],
        "units": "m", "reason": None
    }

    # scale も shift も無ければファイルのままの座標だけ (単位は添える)
    raw = client.get(url, params={"path": samples["raw"]["path"]}).json()
    assert raw["original"] is None and raw["units"] is None
    assert raw["reason"] is None
    metric = client.get(url, params={"path": samples["metric"]["path"]})
    assert metric.json()["units"] == "mm"
    assert metric.json()["original"] is None

    # 一覧に無いパス, 点群でない見本, 外への移動は 404
    for path in ("samples/cloud/other.ply", samples["mask"]["path"],
                 "samples/../config.yaml"):
        assert client.get(url, params={"path": path}).status_code == 404

    # 新しい版の一覧の項目は, 値の決まりを読まず元の座標に戻せないと出す
    index = run_dir / "samples" / "index.json"
    data = json.loads(index.read_text())
    data["format_version"] = 99
    write_json(index, data)
    listed = client.get(results_url(project_id, RESULTS_RUN)).json()
    assert all(item["newer_version"] for item in listed["samples"])
    newer = client.get(url, params={"path": samples["cloud"]["path"]})
    assert newer.status_code == 200
    assert newer.json()["original"] is None
    assert newer.json()["units"] is None
    assert "新しい" in newer.json()["reason"]


def test_cloud_sample_files(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    点群の見本のファイルが読めない形か大きすぎる場合と, 多い点の間引きを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        大きさの上限の差し替え

    Returns
    ----------
    None
    """
    from ml_found import save_sample

    # ML-Found の書く ascii の PLY と, 写した binary の PLY
    run_dir = project_dir / "outputs" / RESULTS_RUN
    many = [[float(index), 0.0, 0.0] for index in range(50001)]
    save_sample(run_dir, "many", many, kind="point_cloud")
    binary = run_dir.parent / "binary.ply"
    binary.write_bytes(
        b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
        b"property float x\nproperty float y\nproperty float z\n"
        b"end_header\n" + bytes(12)
    )
    save_sample(run_dir, "binary", binary, kind="point_cloud")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/runs/{RESULTS_RUN}/samples/cloud"

    # 5 万 1 点は 3 点ごとに間引いて 1 万 6667 点
    data = client.get(
        url, params={"path": "samples/many/final.ply"}
    ).json()
    assert data["vertices"] == 50001
    assert len(data["points"]) == 16667
    assert data["points"][1] == [3.0, 0.0, 0.0]

    # binary の PLY と大きすぎるファイルは 422
    response = client.get(url, params={"path": "samples/binary/final.ply"})
    assert response.status_code == 422
    assert "ascii" in response.json()["detail"]
    monkeypatch.setattr(results_module, "MAX_CLOUD_BYTES", 10)
    response = client.get(url, params={"path": "samples/many/final.ply"})
    assert response.status_code == 422
    assert "大きすぎます" in response.json()["detail"]


def test_parse_ascii_ply() -> None:
    """
    ascii の PLY の読み方 (性質の順, 読めない点, 頂点の無いファイル) を
    確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # x, y, z の順でない性質と, 数でない点を除くこと
    text = (
        "ply\nformat ascii 1.0\nelement vertex 3\nproperty float z\n"
        "property float x\nproperty float y\nproperty uchar red\n"
        "end_header\n3 1 2 255\nnan 0 0 0\n6 4 5 0\n"
    )
    assert results_module.parse_ascii_ply(text) == (
        3, [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]
    )

    # PLY でないもの, 頂点の要素が先頭に無いもの, z の無いもの
    broken = [
        "not ply",
        "ply\nformat ascii 1.0\nelement face 1\nelement vertex 1\n"
        "property float x\nend_header\n",
        "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n"
        "property float y\nend_header\n1 2\n",
        "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n"
        "property float y\nproperty float z\nend_header\nA B C\n"
    ]
    for item in broken:
        with pytest.raises(results_module.SampleCloudError):
            results_module.parse_ascii_ply(item)
