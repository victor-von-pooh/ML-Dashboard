import json
import os
from pathlib import Path

from ml_found import load_evaluations

from ml_dashboard.core.results import (
    MAX_EVALUATION_BYTES,
    evaluation_files,
    load_plain_evaluations,
)


def padded_json(name: str, size: int) -> bytes:
    """
    決まった大きさの評価の JSON を作る関数

    Parameters
    ----------
    name: str
        評価の名前
    size: int
        ファイルの大きさ (バイト)

    Returns
    ----------
    content: bytes
        後ろを空白で埋めた JSON の辞書
    """
    body = json.dumps({"name": name, "columns": [], "rows": []}).encode()
    content = body + b" " * (size - len(body))

    return content


def dashboard_names(run_dir: Path) -> list[str]:
    """
    画面の読み方で読んだ評価のファイルの名前を返す関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    names: list[str]
        読んだファイルの名前 (.json を除く) の順
    """
    loaded, _ = load_plain_evaluations(run_dir, evaluation_files(run_dir))
    names = [stem for stem, _ in loaded]

    return names


def test_same_rules_as_ml_found(tmp_path: Path) -> None:
    """
    評価の読み込みの大きさの上限と, リンクと普通でないファイルを読まない
    決まりが, ML-Found の load_evaluations と同じことを確かめる関数

    画面はファイルごとの理由を出すので自分で読むが, 読むファイルは
    ML-Found と同じにする (上限の値は ML-Found の公開の名前に無いので,
    上限のちょうどと 1 バイト超えのファイルで確かめる)

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "run"
    folder = run_dir / "evaluations"
    folder.mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_bytes(padded_json("link", 100))

    # 読むもの: 普通のファイル (上限のちょうどの大きさも)
    (folder / "plain.json").write_bytes(padded_json("plain", 100))
    (folder / "limit.json").write_bytes(
        padded_json("limit", MAX_EVALUATION_BYTES)
    )
    # 読まないもの: 上限を 1 バイト超える, リンク, FIFO, 一時ファイル,
    # 辞書でない, 壊れた JSON
    (folder / "over.json").write_bytes(
        padded_json("over", MAX_EVALUATION_BYTES + 1)
    )
    (folder / "link.json").symlink_to(outside)
    os.mkfifo(folder / "fifo.json")
    (folder / ".tmp.json").write_bytes(padded_json(".tmp", 100))
    (folder / "list.json").write_text("[1, 2]")
    (folder / "broken.json").write_text("{broken")

    found = [item["name"] for item in load_evaluations(run_dir)]
    assert found == ["limit", "plain"]
    assert dashboard_names(run_dir) == found

    # evaluations/ 自体がリンクなら, どちらも読まない
    linked = tmp_path / "linked"
    linked.mkdir()
    (linked / "evaluations").symlink_to(folder)
    assert load_evaluations(linked) == []
    assert dashboard_names(linked) == []
