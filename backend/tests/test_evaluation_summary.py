import json
from pathlib import Path
from typing import Any, Optional

from fastapi.testclient import TestClient

from ml_dashboard.core import evaluation_summary as summary_module
from ml_dashboard.core.evaluation_summary import (
    metric_better,
    summarize_evaluations,
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
