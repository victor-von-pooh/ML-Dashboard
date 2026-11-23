import math
from collections import Counter
from pathlib import Path
from typing import Any, Optional

from ml_dashboard.core.loader import import_ml_found
from ml_dashboard.core.models import PolicyEstimate, TargetPolicy
from ml_dashboard.core.results import (
    EVALUATION_NAME,
    TRAJECTORIES_DIR,
    is_plain_dir,
    is_plain_file,
    read_trajectory_info,
)
from ml_dashboard.core.runs import RunNotFoundError


class PolicyEstimateError(Exception):
    pass


class FixedPolicy:
    def __init__(
        self, n: int, start: int, epsilon: float, best: Optional[int]
    ):
        # 行動の空間 [start, start + n) と, ε と最も確率の高い行動を保存
        self.n = n
        self.start = start
        self.epsilon = epsilon
        self.best = best

    def __call__(self, observation: Any, action: Any) -> float:
        """
        見積もる方策がその行動を選ぶ確率を返す関数

        Parameters
        ----------
        observation: Any
            観測 (使わない)
        action: Any
            記録した方策がとった行動

        Returns
        ----------
        prob: float
            ε / n に, 行動が best のときだけ 1 - ε を足した確率. 空間の
            外の行動は 0
        """
        # 整数でない行動と空間の外の行動は選ばない
        prob = 0.0
        try:
            value = int(action)
        except (TypeError, ValueError):
            return prob
        if value != action or not self.start <= value < self.start + self.n:
            return prob
        prob = self.epsilon / self.n
        if self.best is not None and value == self.best:
            prob += 1.0 - self.epsilon
        # 足し算の誤差で 1 を超えないように
        prob = min(prob, 1.0)

        return prob


class ActionCounter:
    def __init__(self) -> None:
        # 記録した方策がとった行動ごとの歩の数
        self.counts: Counter[int] = Counter()

    def __call__(self, observation: Any, action: Any) -> float:
        """
        行動を数え, 重みに使わない確率 1 を返す関数

        Parameters
        ----------
        observation: Any
            観測 (使わない)
        action: Any
            記録した方策がとった行動

        Returns
        ----------
        prob: float
            常に 1
        """
        # 整数の行動だけを数える
        prob = 1.0
        try:
            value = int(action)
        except (TypeError, ValueError):
            return prob
        if value == action:
            self.counts[value] += 1

        return prob

    def most_common(self, n: int, start: int) -> Optional[int]:
        """
        空間の中で最も多い行動を返す関数

        Parameters
        ----------
        n: int
            行動の数
        start: int
            最初の行動

        Returns
        ----------
        best: Optional[int]
            最も多い行動 (同じ数なら小さい値). 空間の中の行動が無ければ
            None
        """
        found = [
            (count, -value) for value, count in self.counts.items()
            if start <= value < start + n
        ]
        best = -max(found)[1] if found else None

        return best


def finite_or_none(value: Any) -> Optional[float]:
    """
    有限の数だけを float にする関数

    Parameters
    ----------
    value: Any
        ML-Found の見積もりの値

    Returns
    ----------
    number: Optional[float]
        有限の数, それ以外は None (JSON に nan と無限大を入れないため)
    """
    number = None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value) if math.isfinite(value) else None

    return number


def trajectory_path(run_dir: Path, name: str) -> Path:
    """
    軌跡の表の場所を確かめて返す関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    name: str
        軌跡の名前

    Returns
    ----------
    path: Path
        trajectories/<名前>.csv. 名前の決まりに合わない, 無い, リンクの
        表は RunNotFoundError
    """
    folder = run_dir / TRAJECTORIES_DIR
    path = folder / f"{name}.csv"
    if not EVALUATION_NAME.fullmatch(name) or not (
        is_plain_dir(folder) and is_plain_file(path)
    ):
        raise RunNotFoundError(f"軌跡の表が見つかりません: {name}")

    return path


def estimate_trajectory(
    run_dir: Path, name: str, policy: TargetPolicy, epsilon: float,
    gamma: float
) -> PolicyEstimate:
    """
    記録した軌跡から, 決まった形の方策の良さを ML-Found の
    estimate_policy_value で見積もる関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    name: str
        軌跡の名前 (trajectories/<名前>.csv)
    policy: TargetPolicy
        uniform (一様) か epsilon_greedy (記録で最も多い行動の ε-greedy)
    epsilon: float
        ε-greedy の ε (0 以上 1 以下. 一様では使わない)
    gamma: float
        割引率 (0 以上 1 以下)

    Returns
    ----------
    estimate: PolicyEstimate
        3 つの見積もり, 記録の方策の平均, 重みのばらつきの印, notes.
        見積もれない軌跡は PolicyEstimateError (理由の文)
    """
    # 値の確認と表の場所
    if not (0.0 <= epsilon <= 1.0 and 0.0 <= gamma <= 1.0):
        raise PolicyEstimateError(
            "epsilon と gamma は 0 以上 1 以下にしてください"
        )
    path = trajectory_path(run_dir, name)
    try:
        import_ml_found()
    except Exception as error:
        raise PolicyEstimateError(
            "ML-Found を読み込めないので見積もれません: "
            f"{type(error).__name__}: {error}"
        ) from error
    from ml_found.rl import estimate_policy_value
    from ml_found.rl.off_policy import LOW_ESS_RATIO

    # 確率の列の無い表, Discrete でない行動, 説明の無い表は断る
    info = read_trajectory_info(path.parent, name)
    if info.reason is not None or info.action_space is None:
        raise PolicyEstimateError(info.reason or "行動の空間が分かりません")
    n = int(info.action_space["n"])
    start = int(info.action_space["start"])

    # 最も多い行動は, 同じ読み方にするため ML-Found に数える関数を渡して
    # 数える (重みは使わない)
    best = None
    if policy == "uniform":
        epsilon = 1.0
    try:
        if policy == "epsilon_greedy":
            counter = ActionCounter()
            estimate_policy_value(path, counter, gamma)
            best = counter.most_common(n, start)
        result = estimate_policy_value(
            path, FixedPolicy(n, start, epsilon, best), gamma
        )
    except ValueError as error:
        raise PolicyEstimateError(str(error)) from error

    # 有効なサンプルの数が少ないかは ML-Found の知らせと同じ決め方
    ess = finite_or_none(result["effective_sample_size"]) or 0.0
    value = finite_or_none(result["value"])
    episodes = int(result["episodes"])
    estimate = PolicyEstimate(
        name=name, policy=policy, epsilon=epsilon, gamma=gamma,
        action_start=start, action_count=n, best_action=best,
        value=value,
        ordinary=finite_or_none(result["ordinary"]),
        per_decision=finite_or_none(result["per_decision"]),
        behavior_value=finite_or_none(result["behavior_value"]),
        episodes=episodes, steps=int(result["steps"]),
        effective_sample_size=ess,
        max_weight_share=finite_or_none(result["max_weight_share"]),
        zero_weight_episodes=int(result["zero_weight_episodes"]),
        underflow_episodes=int(result["underflow_episodes"]),
        low_ess=value is not None and ess < LOW_ESS_RATIO * episodes,
        low_ess_ratio=float(LOW_ESS_RATIO),
        notes=[str(note) for note in result["notes"]]
    )

    return estimate
