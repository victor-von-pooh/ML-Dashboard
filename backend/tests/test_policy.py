import copy
import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from test_api import register

# 方策の一式を置く実験
RUN = "demo/2026-11-08/10-00-00"

# 方策の重みの代わりの中身 (ダッシュボードは sha256 を求めるだけ)
WEIGHTS = b"policy weights"

# CartPole の形の方策の一式 (ML-Found の docs/FORMAT.md の「方策の一式」)
SPEC: dict[str, Any] = {
    "format_version": 1,
    "kind": "policy",
    "head": "categorical",
    "observation_space": {
        "type": "box", "shape": [4], "low": [None] * 4, "high": [None] * 4
    },
    "action_space": {"type": "discrete", "n": 2, "start": 0},
    "guards": {
        "action_low": None, "action_high": None, "allowed_actions": None,
        "observation_low": [-2.4, None, -0.21, None],
        "observation_high": [2.4, None, 0.21, None],
        "fallback": {"kind": "handover", "action": None}
    },
    "weights": "policy.pt",
    "weights_sha256": hashlib.sha256(WEIGHTS).hexdigest(),
    "model_class": "train.PolicyNet",
    "created_at": "2026-11-20T10:00:00+09:00",
    "metadata": {"env": "CartPole-v1"}
}


def write_policy(
    project_dir: Path, spec: Any = SPEC, weights: bytes = WEIGHTS,
    text: str = ""
) -> Path:
    """
    実験のディレクトリに方策の一式を書く関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    spec: Any = SPEC
        policy.json の中身
    weights: bytes = WEIGHTS
        policy.pt の中身, 空の場合は書かない
    text: str = ""
        policy.json の文字 (壊れた JSON に使う), 空の場合は spec を書く

    Returns
    ----------
    folder: Path
        一式のディレクトリ
    """
    folder = project_dir / "outputs" / RUN / "policy"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "policy.json").write_text(
        text or json.dumps(spec), encoding="utf-8"
    )
    if weights:
        (folder / "policy.pt").write_bytes(weights)

    return folder


def read_policy(client: TestClient, project_id: str) -> Any:
    """
    実験の任意のファイルの API から方策を取り出す関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    policy: Any
        方策の一式の辞書か None
    """
    response = client.get(f"/api/projects/{project_id}/runs/{RUN}/results")
    assert response.status_code == 200
    policy = response.json()["policy"]

    return policy


def test_policy_guards_and_weights(
    client: TestClient, project_dir: Path
) -> None:
    """
    方策の一式の守り, 空間, 重みの sha256 の確かめを返すことを確かめる関数

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
    project_id = register(client, project_dir)
    assert read_policy(client, project_id) is None

    folder = write_policy(project_dir)
    policy = read_policy(client, project_id)
    assert policy["error"] is None
    assert policy["path"] == "policy"
    assert policy["format_version"] == 1
    assert policy["head"] == "categorical"
    assert policy["action_space"]["n"] == 2
    assert policy["observation_space"]["shape"] == [4]
    assert policy["guards"]["observation_low"] == [-2.4, None, -0.21, None]
    assert policy["guards"]["fallback"] == {"kind": "handover", "action": None}
    assert policy["weights_status"] == "match"
    assert policy["weights_size"] == len(WEIGHTS)
    assert policy["metadata"] == {"env": "CartPole-v1"}

    # 重みを書き換えると違い, 消すと無い
    (folder / "policy.pt").write_bytes(b"other policy weights")
    assert read_policy(client, project_id)["weights_status"] == "mismatch"
    (folder / "policy.pt").unlink()
    assert read_policy(client, project_id)["weights_status"] == "missing"


def test_policy_box_action(client: TestClient, project_dir: Path) -> None:
    """
    連続の行動の範囲と, 決めた行動に戻す守りを返すことを確かめる関数

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
    spec = copy.deepcopy(SPEC)
    spec["head"] = "deterministic"
    spec["action_space"] = {
        "type": "box", "shape": [2], "low": [-1.0, -1.0], "high": [1.0, 1.0]
    }
    spec["guards"].update({
        "action_low": [-0.5, None], "action_high": [0.5, None],
        "fallback": {"kind": "action", "action": [0.0, 0.0]}
    })
    project_id = register(client, project_dir)
    write_policy(project_dir, spec)
    policy = read_policy(client, project_id)
    assert policy["error"] is None
    assert policy["guards"]["action_low"] == [-0.5, None]
    assert policy["guards"]["fallback"] == {
        "kind": "action", "action": [0.0, 0.0]
    }


def test_policy_unreadable(client: TestClient, project_dir: Path) -> None:
    """
    壊れた JSON, 新しい版, 版の無いもの, 守りの書き損じは, 中身を出さずに
    理由だけを返すことを確かめる関数

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
    project_id = register(client, project_dir)
    newer = dict(SPEC, format_version=2)
    unversioned = {key: SPEC[key] for key in SPEC if key != "format_version"}
    typo = copy.deepcopy(SPEC)
    typo["guards"]["observation_hihg"] = typo["guards"].pop(
        "observation_high"
    )
    nan_text = json.dumps(SPEC).replace("-2.4", "NaN")
    cases: list[tuple[Any, str, str]] = [
        (SPEC, "{broken", "JSONDecodeError"),
        (newer, "", "新しい"),
        (unversioned, "", "format_version"),
        (typo, "", "observation_hihg"),
        (SPEC, nan_text, "NaN"),
        ([1, 2], "", "辞書"),
    ]
    for spec, text, expected in cases:
        write_policy(project_dir, spec, text=text)
        policy = read_policy(client, project_id)
        assert policy["error"] is not None, expected
        assert expected in policy["error"], policy["error"]
        assert policy["guards"] is None
        assert policy["observation_space"] is None
        assert policy["weights_status"] is None


def test_policy_weights_not_served(
    client: TestClient, project_dir: Path
) -> None:
    """
    方策の重みはファイルを返す API で返さず, 一覧でも配らない印を付ける
    ことを確かめる関数

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
    project_id = register(client, project_dir)
    write_policy(project_dir)
    base = f"/api/projects/{project_id}/runs/{RUN}"

    weights = client.get(f"{base}/files/policy/policy.pt")
    assert weights.status_code == 403
    assert WEIGHTS not in weights.content
    # 大文字と小文字を区別しないファイルシステムでも返さない
    upper = client.get(f"{base}/files/Policy/policy.pt")
    assert upper.status_code in (403, 404)
    assert WEIGHTS not in upper.content
    spec = client.get(f"{base}/files/policy/policy.json")
    assert spec.status_code == 200

    # 方策を持つ実験の他の重み (final_model.pt は方策と同じ重み) も返さず,
    # 方策を持たない実験の重みは返す
    run_dir = project_dir / "outputs" / RUN
    (run_dir / "final_model.pt").write_bytes(WEIGHTS)
    final = client.get(f"{base}/files/final_model.pt")
    assert final.status_code == 403
    other = project_dir / "outputs" / "demo" / "2026-11-08" / "11-00-00"
    (other / "final_model.pt").write_bytes(WEIGHTS)
    other_url = f"/api/projects/{project_id}/runs/demo/2026-11-08/11-00-00"
    assert client.get(f"{other_url}/files/final_model.pt").status_code == 200

    files = {
        item["path"]: item for item in client.get(base).json()["files"]
    }
    assert files["policy/policy.pt"]["downloadable"] is False
    assert files["final_model.pt"]["downloadable"] is False
    assert files["policy/policy.json"]["downloadable"] is True
    assert files["loss_curve.png"]["downloadable"] is True


def episode_row(index: int, end: Any) -> dict[str, Any]:
    """
    ML-Found の evaluate_policy の形の 1 エピソードの行を作る関数

    Parameters
    ----------
    index: int
        エピソードの番号
    end: Any
        終えた理由

    Returns
    ----------
    row: dict[str, Any]
        episode, seed, reward, length, end と守りの結果ごとの数
    """
    row = {
        "episode": index, "seed": 20000 + index, "reward": 10.0,
        "length": 10, "end": end, "ok": 10, "clipped": 0, "fallback": 0,
        "stop": 1 if end == "stop" else 0,
        "handover": 1 if end == "handover" else 0
    }

    return row


def test_policy_outcomes(client: TestClient, project_dir: Path) -> None:
    """
    守り付きの評価の全ての行から終え方ごとの割合と, 守りが止めたか元の
    制御に戻したエピソードの割合を数えることを確かめる関数

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
    from ml_found import save_evaluation

    project_id = register(client, project_dir)
    write_policy(project_dir)
    url = f"/api/projects/{project_id}/runs/{RUN}/results"
    # 評価の無い実験は空
    assert client.get(url).json()["policy_outcomes"] == []

    # 返す行 (先頭の 2000 行) より多い評価. 2000 行の後に stop を置き,
    # 割合が全ての行から求まることを確かめる
    ends = (
        ["truncated"] * 1500 + ["terminated"] * 400 + ["handover"] * 100
        + ["stop"] * 200 + ["max_steps"] * 300 + ["landed", None]
    )
    rows = [episode_row(index, end) for index, end in enumerate(ends)]
    run_dir = project_dir / "outputs" / RUN
    save_evaluation(
        run_dir, "guarded_episodes", rows, "simulator",
        description="守りを当てて動かしたエピソード", guard=True, epoch=7
    )
    # 守りの結果の列の無い表と曲線は数えない
    save_evaluation(run_dir, "plain", [{"end": "stop", "ok": 1}], "test")
    save_evaluation(
        run_dir, "curve", rows[:3], "test", kind="curve", x="episode"
    )
    # 行の無い守り付きの評価 (ML-Found は列の無い表に書くので手で置く)
    # は割合を出さない
    (run_dir / "evaluations" / "empty.json").write_text(json.dumps({
        "name": "empty", "split": "simulator", "kind": "table",
        "columns": [
            "episode", "end", "ok", "clipped", "fallback", "stop", "handover"
        ],
        "rows": []
    }), encoding="utf-8")
    # 横軸の列の無い曲線は評価のタブで表として出るので数える
    (run_dir / "evaluations" / "loose_curve.json").write_text(json.dumps({
        "name": "loose_curve", "split": "simulator", "kind": "curve",
        "x": "step", "columns": [
            "episode", "end", "ok", "clipped", "fallback", "stop", "handover"
        ],
        "rows": [episode_row(0, "stop"), episode_row(1, "truncated")]
    }), encoding="utf-8")

    data = client.get(url).json()
    kinds = {item["name"]: item["kind"] for item in data["evaluations"]}
    assert kinds["curve"] == "curve"
    assert kinds["loose_curve"] == "table"
    guarded = next(
        item for item in data["evaluations"]
        if item["name"] == "guarded_episodes"
    )
    assert len(guarded["rows"]) == 2000
    outcomes = data["policy_outcomes"]
    assert [item["name"] for item in outcomes] == [
        "guarded_episodes", "empty", "loose_curve"
    ]
    outcome = outcomes[0]
    total = len(ends)
    assert outcome["episodes"] == total
    assert outcome["split"] == "simulator"
    assert outcome["description"] == "守りを当てて動かしたエピソード"
    assert outcome["epoch"] == 7
    assert {item["end"]: item["count"] for item in outcome["ends"]} == {
        "terminated": 400, "truncated": 1500, "max_steps": 300,
        "stop": 200, "handover": 100, "other": 2
    }
    assert [item["end"] for item in outcome["ends"]] == [
        "terminated", "truncated", "max_steps", "stop", "handover", "other"
    ]
    assert outcome["ends"][1]["ratio"] == 1500 / total
    assert outcome["guarded"] == 300
    assert outcome["guarded_ratio"] == 300 / total

    # 行の無い評価は割合が無く, 知らない値の無い評価は other を持たない
    empty = outcomes[1]
    assert empty["episodes"] == 0
    assert empty["guarded_ratio"] is None
    assert [item["end"] for item in empty["ends"]] == [
        "terminated", "truncated", "max_steps", "stop", "handover"
    ]
    assert all(item["ratio"] is None for item in empty["ends"])

    # 表として出る曲線も同じく数える
    loose = outcomes[2]
    assert loose["episodes"] == 2
    assert loose["guarded"] == 1
    assert loose["guarded_ratio"] == 0.5
