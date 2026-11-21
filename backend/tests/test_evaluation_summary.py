import json
import os
import shutil
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core import evaluation_summary as summary_module
from ml_dashboard.core.evaluation_summary import (
    EVALUATION_SUMMARY_CACHE,
    is_worse,
    metric_better,
    summarize_evaluations,
)
from ml_dashboard.core.models import Evaluation
from ml_dashboard.core.results import (
    check_evaluation,
    evaluation_files,
    load_plain_evaluations,
    read_evaluations,
    read_plain_file,
)

from test_api import register

# 評価を持つ実験と持たない実験の場所
EVALUATED_RUN = "demo/2026-11-08/10-00-00"
PLAIN_RUN = "demo/2026-11-08/11-00-00"


def write_evaluation(
    run_dir: Path, name: str, rows: list[dict[str, Any]],
    split: str = "test", guard: bool = False, kind: str = "table",
    baseline: Optional[str] = "今のやり方"
) -> None:
    """
    ML-Found の約束の形の評価のファイルを書く関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    name: str
        評価の名前
    rows: list[dict[str, Any]]
        表の行
    split: str = "test"
        分割
    guard: bool = False
        守る指標の表か
    kind: str = "table"
        table か curve
    baseline: Optional[str] = "今のやり方"
        比べる相手の名前

    Returns
    ----------
    None
    """
    columns = list(rows[0]) if rows else []
    path = run_dir / "evaluations" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "name": name, "split": split, "kind": kind,
        "x": columns[0] if kind == "curve" else None, "columns": columns,
        "rows": rows, "description": None, "baseline": baseline,
        "guard": guard, "epoch": 2,
        "created_at": "2026-11-08T22:00:03+09:00"
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def list_summaries(
    client: TestClient, project_dir: Path
) -> dict[str, Any]:
    """
    実験の一覧を読み, 実験の ID から評価の値と判定を返す関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    found: dict[str, Any]
        実験の ID から evaluations の値
    """
    project_id = register(client, project_dir)
    response = client.get(f"/api/projects/{project_id}/runs")
    assert response.status_code == 200
    found = {run["id"]: run["evaluations"] for run in response.json()}

    return found


def test_list_values_and_guard(
    client: TestClient, project_dir: Path
) -> None:
    """
    一覧がテスト用の 1 行の表の値と, 守る指標の落ちを返すことを確かめる関数

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
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    # 比べる相手との表 (行の数と相手の値は列にしない)
    write_evaluation(run_dir, "baseline_test", [{
        "rows": 50, "split_rows": 60, "mae": 0.4, "mae_baseline": 0.5,
        "mae_diff": -0.1
    }])
    # グループごとの守る指標. 1 つのグループで正解率が落ちた
    write_evaluation(run_dir, "by_group", [
        {"group": "a", "accuracy": 0.9, "accuracy_diff": 0.02},
        {"group": "b", "accuracy": 0.7, "accuracy_diff": -0.05},
        {"group": "c", "accuracy": 0.8, "accuracy_diff": -0.01},
    ], guard=True)
    # 差の列の無い表は数の列全て (文字と真偽値と nan は除く)
    write_evaluation(run_dir, "plain", [{
        "note": "文", "flag": True, "score": 3, "missing": float("nan")
    }], baseline=None)
    # 検証用の評価と曲線は列にしない
    write_evaluation(run_dir, "baseline_valid", [{
        "mae": 0.3, "mae_baseline": 0.5, "mae_diff": -0.2
    }], split="valid", guard=True)
    write_evaluation(run_dir, "curve", [
        {"k": 1, "recall": 0.5}, {"k": 2, "recall": 0.7}
    ], kind="curve")

    found = list_summaries(client, project_dir)
    assert found[PLAIN_RUN] is None
    evaluations = found[EVALUATED_RUN]
    assert evaluations["notice"] is None

    # 守る指標の表は 2 行以上なので列にせず, 判定には全ての行を使う
    values = [
        (item["evaluation"], item["column"], item["value"], item["diff"],
         item["better"])
        for item in evaluations["values"]
    ]
    assert values == [
        ("baseline_test", "mae", 0.4, False, "lower"),
        ("baseline_test", "mae_diff", -0.1, True, "lower"),
        ("plain", "score", 3.0, False, None),
    ]
    assert evaluations["values"][0]["baseline"] == "今のやり方"
    guard = evaluations["guard"]
    assert guard["state"] == "dropped"
    assert guard["dropped"] == ["by_group: accuracy (差 -0.05)"]
    assert guard["unknown"] == []


def test_guard_kept_and_unknown(
    client: TestClient, project_dir: Path
) -> None:
    """
    守る指標を保った実験と, 判断できない実験を見分けることを確かめる関数

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
    # 差が 0 と良い向きだけなら保った
    kept_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(kept_dir, "guard", [
        {"group": "a", "loss_diff": 0.0}, {"group": "b", "loss_diff": -0.2}
    ], guard=True)

    # 向きの分からない指標, 値の無い差, 差の列の無い表は判断できない
    unknown_dir = project_dir / "outputs" / PLAIN_RUN
    write_evaluation(unknown_dir, "guard_a", [
        {"score": 1.0, "score_diff": 0.1, "acc_diff": None}
    ], guard=True)
    write_evaluation(unknown_dir, "guard_b", [{"acc": 0.9}], guard=True)

    found = list_summaries(client, project_dir)
    assert found[EVALUATED_RUN]["guard"] == {
        "state": "kept", "dropped": [], "unknown": []
    }
    guard = found[PLAIN_RUN]["guard"]
    assert guard["state"] == "unknown"
    assert guard["unknown"] == [
        "guard_a: score の向きが分かりません",
        "guard_a: acc の差の値がありません",
        "guard_b: 比べる相手との差の列がありません",
    ]


def test_metric_better() -> None:
    """
    指標の名前と監視する指標から向きを決めることを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    assert metric_better("mae", None, None) == "lower"
    assert metric_better("test/top1_accuracy", None, None) == "higher"
    assert metric_better("F1-macro", None, None) == "higher"
    assert metric_better("recall@5", None, None) == "higher"
    # 片方の向きの語を含まない名前と, 両方を含む名前は監視する指標の向き
    assert metric_better("score", "valid/score", "max") == "higher"
    assert metric_better("score", "valid/score", "min") == "lower"
    assert metric_better("acc_loss", "valid/acc_loss", "max") == "higher"
    assert metric_better("acc_loss", None, None) is None
    assert metric_better("score", "valid/other", "max") is None
    # 語の一部だけが同じ名前 (accent は acc でない) は分からない
    assert metric_better("accent", None, None) is None
    # 向きを打ち消すか変える語を含む名前は, 名前の語では決めない
    for name in ("neg_log_loss", "neg_mse", "accuracy_gap", "acc_drop",
                 "f1_std", "loss_reduction"):
        assert metric_better(name, None, None) is None, name
    assert metric_better("neg_log_loss", "valid/neg_log_loss", "max") == (
        "higher"
    )
    # top1 と top5 は修飾語で, 向きは acc か err で決まる
    assert metric_better("top1_error", None, None) == "lower"
    assert metric_better("top5_acc", None, None) == "higher"
    assert metric_better("top1", None, None) is None
    # 普通の名前に使う語 (変化検出の change) は打ち消しの語にしない
    assert metric_better("change_detection_f1", None, None) == "higher"


def test_is_worse_tolerance() -> None:
    """
    計算の誤差の幅の差は落ちたとしないことを確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    assert not is_worse(-1e-17, "higher") and not is_worse(1e-17, "lower")
    assert is_worse(-1e-6, "higher") and is_worse(1e-6, "lower")


def test_cache_and_skip(project_dir: Path, tmp_path: Path) -> None:
    """
    ファイルと監視する指標が変わらなければ前の結果を使い, リンクと形の違う
    評価を読まないことを確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(run_dir, "metrics", [{"score": 0.5}])
    first = summarize_evaluations(run_dir, None, None)
    assert first is not None and first.notice is None
    assert summarize_evaluations(run_dir, None, None) is first

    # 監視する指標が変わると, 向きを決め直す
    monitored = summarize_evaluations(run_dir, "valid/score", "max")
    assert monitored is not None and monitored is not first
    assert monitored.values[0].better == "higher"

    # 書き直すと読み直し
    write_evaluation(run_dir, "metrics", [{"score": 0.75, "extra": 1}])
    second = summarize_evaluations(run_dir, None, None)
    assert second is not None and second is not first
    assert [item.value for item in second.values] == [0.75, 1.0]

    # 外のファイルを指すリンクは, 中の名前がファイルの名前と違っても読まない
    outside = tmp_path / "outside_eval"
    write_evaluation(outside, "secret", [{"secret": 42}])
    (run_dir / "evaluations" / "linked.json").symlink_to(
        outside / "evaluations" / "secret.json"
    )
    # 名前に : を含む評価と, float にできない大きな整数の値
    write_evaluation(run_dir, "bad:name", [{"acc": 0.1}])
    write_evaluation(run_dir, "huge", [{"big": 10 ** 400, "acc": 0.5}])
    third = summarize_evaluations(run_dir, None, None)
    assert third is not None
    assert {item.evaluation for item in third.values} == {"metrics", "huge"}
    assert [
        item.column for item in third.values if item.evaluation == "huge"
    ] == ["acc"]
    assert third.notice is not None and "2 個" in third.notice

    # evaluations/ の無い実験は None
    plain = project_dir / "outputs" / PLAIN_RUN
    assert summarize_evaluations(plain, None, None) is None


def test_guard_edge_cases(project_dir: Path) -> None:
    """
    行の無い守る指標の表, 値の上限, 表として読む曲線を確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(run_dir, "empty", [], guard=True)
    (run_dir / "evaluations" / "empty.json").write_text(
        '{"name": "empty", "split": "test", "kind": "table", "columns": '
        '["acc", "acc_diff"], "rows": [], "guard": true}',
        encoding="utf-8"
    )
    # x の無い曲線は 1 行の表として値にする. 値は上限まで
    write_evaluation(run_dir, "wide", [
        {f"m{index}": index for index in range(150)}
    ], kind="curve")
    (run_dir / "evaluations" / "wide.json").write_text(
        (run_dir / "evaluations" / "wide.json").read_text().replace(
            '"x": "m0"', '"x": null'
        ),
        encoding="utf-8"
    )
    summary = summarize_evaluations(run_dir, None, None)
    assert summary is not None and summary.guard is not None
    assert summary.guard.state == "unknown"
    assert summary.guard.unknown == ["empty: acc の差の値がありません"]
    assert len(summary.values) == summary_module.MAX_LIST_VALUES
    assert summary.values[0].column == "m0"


def test_detail_has_evaluations(
    client: TestClient, project_dir: Path
) -> None:
    """
    実験の詳細の本体にも評価の値と判定が入ることを確かめる関数

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
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(run_dir, "guard", [{"acc_diff": -0.1}], guard=True)
    project_id = register(client, project_dir)
    detail = client.get(
        f"/api/projects/{project_id}/runs/{EVALUATED_RUN}"
    ).json()
    assert detail["evaluations"]["guard"]["state"] == "dropped"


NO_FIFO = pytest.mark.skipif(
    not hasattr(os, "mkfifo"), reason="FIFO を作れない環境"
)


@NO_FIFO
@pytest.mark.parametrize("use_dir_fd", [True, False])
def test_read_plain_file(tmp_path: Path, use_dir_fd: bool) -> None:
    """
    評価のファイルを開くときに, リンク, FIFO, 上限を超えるファイルを
    読まないことを, dir_fd を使う場合と使わない場合で確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    use_dir_fd: bool
        dir_fd を使うか

    Returns
    ----------
    None
    """
    (tmp_path / "plain.json").write_bytes(b"12345")
    (tmp_path / "link.json").symlink_to(tmp_path / "plain.json")
    os.mkfifo(tmp_path / "fifo.json")
    dir_fd = (
        os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
        if use_dir_fd else None
    )
    try:
        plain = tmp_path / "plain.json"
        assert read_plain_file(plain, dir_fd, 5) == b"12345"
        # 上限 + 1 バイトまでで止め, 超えれば読まない
        assert read_plain_file(plain, dir_fd, 4) is None
        assert read_plain_file(tmp_path / "link.json", dir_fd, 5) is None
        # FIFO は書く側を待たずに, 普通のファイルでないとして読まない
        assert read_plain_file(tmp_path / "fifo.json", dir_fd, 5) is None
        assert read_plain_file(tmp_path / "missing.json", dir_fd, 5) is None
    finally:
        if dir_fd is not None:
            os.close(dir_fd)


def test_read_plain_file_swapped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    dir_fd を使わない場合に, 確かめた後に別のファイルに替わると読まない
    ことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest が用意する差し替えの道具

    Returns
    ----------
    None
    """
    (tmp_path / "plain.json").write_bytes(b"12345")
    (tmp_path / "other.json").write_bytes(b"secret")
    # 開くときだけ別のファイル (確かめた後に置き換えられた場合)
    real_open = os.open

    def swapped(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        return real_open(tmp_path / "other.json", flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", swapped)
    assert read_plain_file(tmp_path / "plain.json", None, 100) is None


def test_load_plain_evaluations_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    集めた後に evaluations/ がリンクに替わると読まず, dir_fd を使えない
    環境でも普通のファイルを読むことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest が用意する差し替えの道具

    Returns
    ----------
    None
    """
    run_dir = tmp_path / "run"
    write_evaluation(run_dir, "metrics", [{"score": 0.5}])
    files = evaluation_files(run_dir)
    assert [stem for stem, _ in load_plain_evaluations(run_dir, files)] == [
        "metrics"
    ]

    # dir_fd を使えない環境 (Windows など) でも, 普通のファイルは読む
    monkeypatch.setattr(os, "supports_dir_fd", set())
    assert len(load_plain_evaluations(run_dir, files)) == 1
    monkeypatch.undo()

    # 集めた後に evaluations/ を外を指すリンクに置き換えると読まない
    outside = tmp_path / "outside"
    write_evaluation(outside, "metrics", [{"score": 0.9}])
    shutil.rmtree(run_dir / "evaluations")
    (run_dir / "evaluations").symlink_to(outside / "evaluations")
    assert load_plain_evaluations(run_dir, files) == []
    monkeypatch.setattr(os, "supports_dir_fd", set())
    assert load_plain_evaluations(run_dir, files) == []


def test_check_evaluation(tmp_path: Path) -> None:
    """
    名前がファイルの名前と同じで決まりに合う評価だけを, 評価のタブでも
    出すことを確かめる関数

    Parameters
    ----------
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    data = {"name": "metrics", "columns": [], "rows": []}
    assert check_evaluation("metrics", data) == "metrics"
    assert check_evaluation("other", data) is None
    # 末尾の改行も決まりに合わない
    newline = {**data, "name": "metrics\n"}
    assert check_evaluation("metrics\n", newline) is None
    assert check_evaluation("metrics", {**data, "rows": [1]}) is None

    # 評価のタブも, ファイルの名前と違う評価を出さない
    run_dir = tmp_path / "run"
    write_evaluation(run_dir, "metrics", [{"score": 0.5}])
    write_evaluation(run_dir, "other", [{"score": 0.9}])
    (run_dir / "evaluations" / "metrics.json").replace(
        run_dir / "evaluations" / "copy.json"
    )
    (run_dir / "evaluations" / "other.json").replace(
        run_dir / "evaluations" / "metrics.json"
    )
    notices: list[str] = []
    assert [item.name for item in read_evaluations(run_dir, notices)] == []
    assert len(notices) == 1 and "2 個" in notices[0]


@NO_FIFO
def test_skip_fifo_and_renamed(
    project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    FIFO, 深く入れ子の JSON, 中の名前がファイルの名前と違う評価を出さず,
    テスト用でない評価の行を作らないことを確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        pytest が用意する差し替えの道具

    Returns
    ----------
    None
    """
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(run_dir, "metrics", [{"score": 0.5}])
    write_evaluation(run_dir, "by_class", [{"acc": 0.5}], split="valid")
    os.mkfifo(run_dir / "evaluations" / "pipe.json")
    # 深く入れ子の JSON (読めないファイルとして飛ばす)
    (run_dir / "evaluations" / "deep.json").write_text(
        "[" * 100000, encoding="utf-8"
    )
    write_evaluation(run_dir, "other", [{"acc": 0.9}])
    (run_dir / "evaluations" / "other.json").rename(
        run_dir / "evaluations" / "renamed.json"
    )
    # 行を作る評価を記録 (テスト用でない評価は形だけを確かめる)
    built: list[str] = []
    original = summary_module.to_evaluation

    def record(data: dict[str, Any]) -> Optional[Evaluation]:
        built.append(str(data.get("name")))
        return original(data)

    monkeypatch.setattr(summary_module, "to_evaluation", record)
    summary = summarize_evaluations(run_dir, None, None)
    assert summary is not None
    assert [item.evaluation for item in summary.values] == ["metrics"]
    assert built == ["metrics"]
    assert summary.notice is not None
    assert "3 個" in summary.notice
    assert "ファイルの名前と同じ" in summary.notice


def test_forget_removed_runs(
    client: TestClient, project_dir: Path
) -> None:
    """
    一覧を読むと, 消した実験の評価の覚えを捨てることを確かめる関数

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
    run_dir = project_dir / "outputs" / EVALUATED_RUN
    write_evaluation(run_dir, "metrics", [{"score": 0.5}])
    project_id = register(client, project_dir)
    assert client.get(f"/api/projects/{project_id}/runs").status_code == 200
    assert str(run_dir) in EVALUATION_SUMMARY_CACHE

    # 実験を消してから一覧を読み直すと, 覚えからも消える
    shutil.rmtree(run_dir)
    assert client.get(f"/api/projects/{project_id}/runs").status_code == 200
    assert str(run_dir) not in EVALUATION_SUMMARY_CACHE

    # 実験を残して evaluations/ だけを消しても, 覚えから消える
    other = project_dir / "outputs" / PLAIN_RUN
    write_evaluation(other, "metrics", [{"score": 0.5}])
    assert client.get(f"/api/projects/{project_id}/runs").status_code == 200
    assert str(other) in EVALUATION_SUMMARY_CACHE
    shutil.rmtree(other / "evaluations")
    assert client.get(f"/api/projects/{project_id}/runs").status_code == 200
    assert str(other) not in EVALUATION_SUMMARY_CACHE
