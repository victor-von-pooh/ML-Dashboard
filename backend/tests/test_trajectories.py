from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core.policy_estimate import ActionCounter, FixedPolicy

from test_api import register

# 軌跡を置く実験
RUN = "demo/2026-11-08/10-00-00"

# 観測 (形 (1,) の Box) と行動 (2 つの番号の Discrete) の空間
OBSERVATION_SPACE = SimpleNamespace(
    low=np.array([-1.0]), high=np.array([1.0]), shape=(1,)
)
DISCRETE_SPACE = SimpleNamespace(n=2, start=0, shape=())
BOX_SPACE = SimpleNamespace(
    low=np.array([-1.0]), high=np.array([1.0]), shape=(1,)
)

# 記録の確率が 0.7 (行動 1) と 0.3 (行動 0) の, 2 エピソード 6 歩の軌跡
# (行動, 記録の確率, 報酬)
COIN = [
    [(1, 0.7, 1.0), (1, 0.7, 1.0), (0, 0.3, 0.0)],
    [(1, 0.7, 1.0), (1, 0.7, 1.0), (0, 0.3, 0.0)]
]


def write_trajectory(
    project_dir: Path, name: str, episodes: list[list[tuple]],
    action_space: Any = DISCRETE_SPACE, with_prob: bool = True
) -> Path:
    """
    ML-Found の save_trajectory で軌跡の表と説明を書く関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    name: str
        軌跡の名前
    episodes: list[list[tuple]]
        エピソードごとの (行動, 記録の確率, 報酬) の並び
    action_space: Any = DISCRETE_SPACE
        行動の空間
    with_prob: bool = True
        記録の確率を書くか

    Returns
    ----------
    path: Path
        書いた表
    """
    from ml_found.rl import Trajectory, save_trajectory

    # エピソードの最後の歩で終了
    trajectory = Trajectory(
        observation_space=OBSERVATION_SPACE, action_space=action_space
    )
    for number, steps in enumerate(episodes):
        trajectory.start_episode(number, None)
        for index, (action, prob, reward) in enumerate(steps):
            trajectory.add(
                [0.0], action, reward, index == len(steps) - 1, False,
                action_prob=prob if with_prob else None
            )
        trajectory.end_episode()
    path = save_trajectory(
        project_dir / "outputs" / RUN, name, trajectory, epoch=3,
        description="確かめ用の軌跡"
    )

    return path


def estimate(
    client: TestClient, project_id: str, name: str, **params: Any
) -> Any:
    """
    方策の見積もりの API を呼ぶ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_id: str
        プロジェクトの ID
    name: str
        軌跡の名前
    **params: Any
        policy, epsilon, gamma

    Returns
    ----------
    response: Any
        応答
    """
    response = client.get(
        f"/api/projects/{project_id}/runs/{RUN}/trajectories/{name}/estimate",
        params=params
    )

    return response


def listed(client: TestClient, project_id: str) -> list[dict[str, Any]]:
    """
    実験の任意のファイルの API から軌跡の一覧を取り出す関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    trajectories: list[dict[str, Any]]
        軌跡の一覧
    """
    response = client.get(f"/api/projects/{project_id}/runs/{RUN}/results")
    assert response.status_code == 200
    trajectories: list[dict[str, Any]] = response.json()["trajectories"]

    return trajectories


def test_uniform_estimate(client: TestClient, project_dir: Path) -> None:
    """
    一様の方策の見積もりが ML-Found の値と同じことを確かめる関数

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
    assert listed(client, project_id) == []
    write_trajectory(project_dir, "coin", COIN)

    # 一覧: 説明の項目と, 見積もりに使えること
    [item] = listed(client, project_id)
    assert item["name"] == "coin"
    assert item["file"] == "trajectories/coin.csv"
    assert item["has_info"] is True
    assert item["episodes"] == 2
    assert item["rows"] == 6
    assert item["epoch"] == 3
    assert item["with_action_prob"] is True
    assert item["action_space"] == {"type": "discrete", "n": 2, "start": 0}
    assert item["reason"] is None

    # 一様 (γ = 1): 重みは 0.5^3 / (0.7 * 0.7 * 0.3) で両方同じ
    response = estimate(client, project_id, "coin", policy="uniform")
    assert response.status_code == 200
    result = response.json()
    assert result["policy"] == "uniform"
    assert result["epsilon"] == 1.0
    assert result["best_action"] is None
    assert result["value"] == pytest.approx(2.0)
    assert result["ordinary"] == pytest.approx(2 * 0.125 / 0.147)
    assert result["ordinary"] == pytest.approx(1.7007, abs=1e-4)
    assert result["behavior_value"] == pytest.approx(2.0)
    assert result["effective_sample_size"] == pytest.approx(2.0)
    assert result["max_weight_share"] == pytest.approx(0.5)
    assert result["episodes"] == 2
    assert result["steps"] == 6
    assert result["zero_weight_episodes"] == 0
    assert result["low_ess"] is False

    # 割引率を変えると割り引いた報酬の和 (1 + 0.5) になる
    result = estimate(
        client, project_id, "coin", policy="uniform", gamma=0.5
    ).json()
    assert result["gamma"] == 0.5
    assert result["value"] == pytest.approx(1.5)


def test_epsilon_greedy_estimate(
    client: TestClient, project_dir: Path
) -> None:
    """
    記録で最も多い行動の ε-greedy と, ε = 0 の重み 0 を確かめる関数

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
    # 行動 1 を多くとった記録 (2 つ目のエピソードだけが行動 0 をとる)
    project_id = register(client, project_dir)
    episodes = [
        [(1, 0.7, 1.0), (1, 0.7, 1.0)],
        [(1, 0.7, 1.0), (0, 0.3, 0.0)]
    ]
    write_trajectory(project_dir, "mostly_one", episodes)

    # ε = 0.2: 行動 1 は 0.9, 行動 0 は 0.1
    result = estimate(
        client, project_id, "mostly_one", policy="epsilon_greedy",
        epsilon=0.2
    ).json()
    assert result["best_action"] == 1
    assert result["epsilon"] == pytest.approx(0.2)
    first = (0.9 / 0.7) ** 2
    second = (0.9 / 0.7) * (0.1 / 0.3)
    assert result["value"] == pytest.approx(
        (first * 2 + second * 1) / (first + second)
    )
    assert result["zero_weight_episodes"] == 0

    # ε = 0: 行動 0 をとったエピソードの重みが 0 になり, 数と notes に出る
    result = estimate(
        client, project_id, "mostly_one", policy="epsilon_greedy",
        epsilon=0.0
    ).json()
    assert result["zero_weight_episodes"] == 1
    assert result["value"] == pytest.approx(2.0)
    assert any("確率 0" in note for note in result["notes"])


def test_low_effective_sample_size(
    client: TestClient, project_dir: Path
) -> None:
    """
    有効なサンプルの数がエピソードの数に比べて小さいと知らせることを
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
    # 記録の方策がほぼ選ばない行動 1 のエピソードの重みが大きい
    project_id = register(client, project_dir)
    episodes = [[(0, 0.99, 0.0)]] * 19 + [[(1, 0.01, 1.0)]]
    write_trajectory(project_dir, "rare", episodes)
    result = estimate(client, project_id, "rare", policy="uniform").json()
    assert result["episodes"] == 20
    assert result["effective_sample_size"] < 2.0
    assert result["low_ess"] is True
    assert result["max_weight_share"] > 0.8


def test_refuses_unusable_trajectories(
    client: TestClient, project_dir: Path
) -> None:
    """
    確率の列の無い軌跡, Discrete でない行動, 説明の無い表を, 理由を付けて
    断ることを確かめる関数

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
    write_trajectory(project_dir, "greedy", COIN, with_prob=False)
    write_trajectory(
        project_dir, "box",
        [[([0.5], 0.5, 1.0)]], action_space=BOX_SPACE
    )
    path = write_trajectory(project_dir, "plain", COIN)
    path.with_suffix(".json").unlink()

    # 一覧にも見積もりにも同じ理由
    reasons: dict[str, Optional[str]] = {
        item["name"]: item["reason"] for item in listed(client, project_id)
    }
    assert list(reasons) == ["box", "greedy", "plain"]
    expected = {
        "greedy": "確率の列", "box": "連続の値", "plain": "説明"
    }
    for name, word in expected.items():
        reason = reasons[name]
        assert reason is not None and word in reason
        response = estimate(client, project_id, name, policy="uniform")
        assert response.status_code == 422
        assert response.json()["detail"] == reason


def test_estimate_checks_requests(
    client: TestClient, project_dir: Path
) -> None:
    """
    無い軌跡, 名前の決まりに合わない名前, 範囲の外の値, リンクの表を
    断ることを確かめる関数

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
    path = write_trajectory(project_dir, "coin", COIN)
    assert estimate(client, project_id, "missing").status_code == 404
    assert estimate(client, project_id, ".coin").status_code == 404
    for params in ({"epsilon": 1.5}, {"gamma": -0.1}, {"policy": "best"}):
        response = estimate(client, project_id, "coin", **params)
        assert response.status_code == 422

    # 表をリンクにすると, 一覧は理由を付け, 見積もりは見つからない扱い
    target = path.parent.parent / "outside.csv"
    path.rename(target)
    path.symlink_to(target)
    [item] = listed(client, project_id)
    assert item["reason"] is not None and "リンク" in item["reason"]
    assert estimate(client, project_id, "coin").status_code == 404


def test_fixed_policy_and_counter() -> None:
    """
    見積もる方策の確率と, 最も多い行動の決め方を確かめる関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # ε / n に, best だけ 1 - ε を足す. 空間 [1, 4) の外は 0
    policy = FixedPolicy(3, 1, 0.3, 2)
    assert policy(None, 2) == pytest.approx(0.1 + 0.7)
    assert policy(None, 1) == pytest.approx(0.1)
    assert policy(None, 0) == 0.0
    assert policy(None, 4) == 0.0
    assert policy(None, 1.5) == 0.0
    uniform = FixedPolicy(4, 0, 1.0, None)
    assert uniform(None, 3) == pytest.approx(0.25)

    # 同じ数なら小さい値. 空間の外の行動は選ばない
    counter = ActionCounter()
    for action in (3, 3, 3, 2, 1, 1, 2):
        counter(None, action)
    assert counter.most_common(3, 0) == 1
    assert counter.most_common(4, 0) == 3
    assert ActionCounter().most_common(2, 0) is None
