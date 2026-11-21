import math
import re
from pathlib import Path
from typing import Any, Optional

from ml_dashboard.core.models import (
    Better,
    Evaluation,
    EvaluationValue,
    GuardCheck,
    GuardState,
    Mode,
    RunEvaluations,
)
from ml_dashboard.core.results import (
    EVALUATIONS_DIR,
    EVALUATIONS_LINK_NOTICE,
    evaluation_files,
    evaluation_order,
    is_plain_dir,
    load_checked_evaluations,
    skipped_notice,
    to_cell,
    to_evaluation,
)

# 一覧と比較に出す評価の分割 (検証用はモデルの選びに使ったので, テスト用)
LIST_SPLIT = "test"

# 1 つの実験で一覧に返す評価の値の上限
MAX_LIST_VALUES = 100

# 比べる相手との表の形の列の名前の終わり (ML-Found の docs/FORMAT.md)
DIFF_SUFFIX = "_diff"

# 指標の名前を語に分ける区切り
METRIC_SEPARATORS = re.compile(r"[_\-.@/\s]+")

# 小さいほど良い指標の語と, 大きいほど良い指標の語
LOWER_BETTER = frozenset({
    "loss", "error", "err", "mae", "mse", "rmse", "rmsle", "msle", "mape",
    "smape", "nll", "logloss", "brier", "ece", "eer", "fid", "kid", "lpips",
    "perplexity", "ppl", "wer", "cer", "chamfer", "hausdorff", "violations",
    "cost", "regret", "miss",
})
HIGHER_BETTER = frozenset({
    "accuracy", "acc", "f1", "fbeta", "auc", "auroc", "ap", "map",
    "precision", "recall", "sensitivity", "specificity", "iou", "miou",
    "jaccard", "dice", "r2", "bleu", "rouge", "meteor", "chrf", "psnr",
    "ssim", "ndcg", "mrr", "hit", "hits", "kappa", "mcc",
    "reward", "return", "success", "coverage",
})
# 向きを打ち消すか変える語 (neg_log_loss は大きいほど良く, accuracy_gap は
# 小さいほど良い). 含む名前は名前の語では向きを決めない
MODIFIER_WORDS = frozenset({
    "neg", "negative", "inv", "inverse", "gap", "drop", "delta",
    "std", "var", "variance", "reduction", "improvement", "increase",
    "decrease", "gain",
})
# 差を 0 とみなす幅 (計算の誤差で落ちたとしないため)
DIFF_TOLERANCE = 1e-12

# 実験のディレクトリごとに覚えた結果 (ファイルの名前, i-node, 大きさ,
# 更新の時刻と, 監視する指標と向きが同じ間は使い直す)
EVALUATION_SUMMARY_CACHE: dict[
    str, tuple[tuple[Any, ...], RunEvaluations]
] = {}


def metric_better(
    name: str, monitor: Optional[str], mode: Optional[Mode]
) -> Optional[Better]:
    """
    指標の名前から, 小さいほど良いか大きいほど良いかを推し量る関数

    評価の better に向きの無い列だけに使う

    Parameters
    ----------
    name: str
        指標の名前 (<指標>_diff の <指標>)
    monitor: Optional[str]
        実験の監視する指標 (valid/acc など)
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    better: Optional[Better]
        lower か higher. 決まらなければ None
    """
    # 名前の語が, 片方の向きの語だけを含む場合はその向き
    words = {
        word for word in METRIC_SEPARATORS.split(name.lower()) if word
    }
    lower = bool(words & LOWER_BETTER)
    higher = bool(words & HIGHER_BETTER)
    if lower != higher and not words & MODIFIER_WORDS:
        better: Optional[Better] = "lower" if lower else "higher"
        return better

    # 監視する指標と同じ名前なら, その向き
    better = None
    if monitor and mode and monitor.rsplit("/", 1)[-1] == name:
        better = "lower" if mode == "min" else "higher"

    return better


def column_better(
    column: str, metric: str, better: dict[str, Better],
    monitor: Optional[str], mode: Optional[Mode]
) -> Optional[Better]:
    """
    評価の列の向きを, 評価の better を先に, 無ければ名前から決める関数

    Parameters
    ----------
    column: str
        列の名前 (<指標> か <指標>_diff)
    metric: str
        名前から向きを推し量る指標の名前 (<指標>_diff の <指標>)
    better: dict[str, Better]
        評価の列ごとの向き (同じ指標の列に広げたもの)
    monitor: Optional[str]
        実験の監視する指標
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    direction: Optional[Better]
        lower か higher. 決まらなければ None
    """
    # 書いた側が決めた向きを, 名前からの推測より優先
    direction = better.get(column)
    if direction is None:
        direction = metric_better(metric, monitor, mode)

    return direction


def number_or_none(value: Any) -> Optional[float]:
    """
    表の値から有限の数だけを取り出す関数

    Parameters
    ----------
    value: Any
        表の値

    Returns
    ----------
    number: Optional[float]
        数 (真偽値は除く), それ以外と nan, 無限大は None
    """
    cell = to_cell(value)
    if not isinstance(cell, (int, float)) or isinstance(cell, bool):
        return None

    # float にできない大きな整数も無いものとして扱う
    try:
        converted = float(cell)
    except OverflowError:
        return None
    number = converted if math.isfinite(converted) else None

    return number


def diff_metrics(columns: list[str]) -> list[str]:
    """
    比べる相手との差の列 (<指標>_diff) を持つ指標を集める関数

    Parameters
    ----------
    columns: list[str]
        表の列

    Returns
    ----------
    metrics: list[str]
        差の列を持つ指標の名前 (列の順)
    """
    metrics = [
        column[:-len(DIFF_SUFFIX)] for column in columns
        if column.endswith(DIFF_SUFFIX) and len(column) > len(DIFF_SUFFIX)
    ]

    return metrics


def evaluation_values(
    evaluation: Evaluation, monitor: Optional[str], mode: Optional[Mode]
) -> list[EvaluationValue]:
    """
    1 行の表から一覧の列にする値を集める関数

    Parameters
    ----------
    evaluation: Evaluation
        テスト用の評価
    monitor: Optional[str]
        実験の監視する指標
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    values: list[EvaluationValue]
        値. 1 行の表でなければ空. 差の列を持つ表では <指標> と <指標>_diff
        だけ, 他の表では数の列全て
    """
    values: list[EvaluationValue] = []
    if evaluation.kind != "table" or evaluation.total_rows != 1:
        return values
    row = evaluation.rows[0]

    # 差の列を持つ表は指標と差の列, それ以外は数の値を持つ列
    metrics = diff_metrics(evaluation.columns)
    if metrics:
        columns = [
            column for column in evaluation.columns
            if column in metrics or (
                column.endswith(DIFF_SUFFIX)
                and column.removesuffix(DIFF_SUFFIX) in metrics
            )
        ]
    else:
        columns = [
            column for column in evaluation.columns
            if number_or_none(row.get(column)) is not None
        ]
    for column in columns:
        diff = bool(metrics) and column.endswith(DIFF_SUFFIX)
        metric = column.removesuffix(DIFF_SUFFIX) if diff else column
        values.append(EvaluationValue(
            evaluation=evaluation.name, column=column,
            value=number_or_none(row.get(column)), guard=evaluation.guard,
            diff=diff,
            better=column_better(
                column, metric, evaluation.better, monitor, mode
            ),
            baseline=evaluation.baseline
        ))

    return values


def is_worse(diff: float, better: Better) -> bool:
    """
    比べる相手との差が悪い向きかを判定する関数

    Parameters
    ----------
    diff: float
        この実験 - 比べる相手
    better: Better
        指標の向き

    Returns
    ----------
    worse: bool
        悪い向きの差かどうか (0 と, 幅 DIFF_TOLERANCE の中は悪くない)
    """
    worse = (
        diff > DIFF_TOLERANCE if better == "lower" else diff < -DIFF_TOLERANCE
    )

    return worse


def judge_guard(
    data: dict[str, Any], better: dict[str, Better],
    monitor: Optional[str], mode: Optional[Mode]
) -> tuple[list[str], list[str]]:
    """
    1 つの守る指標の表の全ての行の差を見る関数

    Parameters
    ----------
    data: dict[str, Any]
        evaluations/<名前>.json の中身 (形を確かめたもの)
    better: dict[str, Better]
        評価の列ごとの向き (同じ指標の列に広げたもの)
    monitor: Optional[str]
        実験の監視する指標
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    dropped: list[str]
        落ちた指標と一番悪い差
    unknown: list[str]
        判断できなかった理由
    """
    name = str(data["name"])
    columns: list[str] = data["columns"]
    rows: list[dict[str, Any]] = data["rows"]
    dropped: list[str] = []
    unknown: list[str] = []
    metrics = diff_metrics(columns)
    if not metrics:
        unknown.append(f"{name}: 比べる相手との差の列がありません")
        return dropped, unknown

    # 指標ごとに, 全ての行 (グループ) の差を見る
    for metric in metrics:
        direction = column_better(
            metric + DIFF_SUFFIX, metric, better, monitor, mode
        )
        if direction is None:
            unknown.append(f"{name}: {metric} の向きが分かりません")
            continue
        diffs = [
            number_or_none(row.get(metric + DIFF_SUFFIX)) for row in rows
        ]
        worse = [
            diff for diff in diffs if diff is not None
            and is_worse(diff, direction)
        ]
        if worse:
            worst = max(worse) if direction == "lower" else min(worse)
            dropped.append(f"{name}: {metric} (差 {worst:+.4g})")
        elif not diffs or None in diffs:
            unknown.append(f"{name}: {metric} の差の値がありません")

    return dropped, unknown


def guard_state(dropped: list[str], unknown: list[str]) -> GuardState:
    """
    守る指標の判定をまとめる関数

    Parameters
    ----------
    dropped: list[str]
        落ちた指標
    unknown: list[str]
        判断できなかった理由

    Returns
    ----------
    state: GuardState
        1 つでも落ちれば dropped, 判断できないものが残れば unknown,
        それ以外は kept
    """
    state: GuardState = (
        "dropped" if dropped else "unknown" if unknown else "kept"
    )

    return state


def build_summary(
    run_dir: Path, files: list[Path], monitor: Optional[str],
    mode: Optional[Mode]
) -> RunEvaluations:
    """
    テスト用の評価の値と守る指標の判定を求める関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    files: list[Path]
        evaluations/ の評価のファイル
    monitor: Optional[str]
        実験の監視する指標
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    summary: RunEvaluations
        値 (守る指標の表を先に), 守る指標の判定, 出せなかったファイルの理由
    """
    # 形と名前の合う評価のうち, テスト用だけの行 (守る指標の表を先に名前の
    # 順)
    tests: list[tuple[Evaluation, dict[str, Any]]] = []
    checked, skipped = load_checked_evaluations(run_dir, files)
    for _, data in checked:
        if data.get("split") != LIST_SPLIT:
            continue
        evaluation = to_evaluation(data)
        if evaluation is not None:
            tests.append((evaluation, data))
    tests.sort(key=lambda item: evaluation_order(item[0]))
    notice = skipped_notice(skipped)

    # 列にする値と, 守る指標の表の判定
    values: list[EvaluationValue] = []
    dropped: list[str] = []
    unknown: list[str] = []
    has_guard = False
    for evaluation, data in tests:
        values += evaluation_values(evaluation, monitor, mode)
        if evaluation.guard:
            has_guard = True
            found, unclear = judge_guard(
                data, evaluation.better, monitor, mode
            )
            dropped += found
            unknown += unclear
    guard = (
        GuardCheck(
            state=guard_state(dropped, unknown), dropped=dropped,
            unknown=unknown
        )
        if has_guard else None
    )
    summary = RunEvaluations(
        values=values[:MAX_LIST_VALUES], guard=guard, notice=notice
    )

    return summary


def summarize_evaluations(
    run_dir: Path, monitor: Optional[str], mode: Optional[Mode]
) -> Optional[RunEvaluations]:
    """
    一覧と比較に出すテスト用の評価を, 覚えた結果を使い直して求める関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    monitor: Optional[str]
        実験の監視する指標 (向きを決めるため)
    mode: Optional[Mode]
        監視する指標の向き

    Returns
    ----------
    summary: Optional[RunEvaluations]
        値と守る指標の判定. evaluations/ の無い実験は None, リンクの
        実験は注意だけ
    """
    # evaluations/ がリンクの実験は注意だけ, 無い実験は None
    if (run_dir / EVALUATIONS_DIR).is_symlink():
        EVALUATION_SUMMARY_CACHE.pop(str(run_dir), None)
        return RunEvaluations(notice=EVALUATIONS_LINK_NOTICE)
    if not is_plain_dir(run_dir / EVALUATIONS_DIR):
        EVALUATION_SUMMARY_CACHE.pop(str(run_dir), None)
        return None

    # ファイル (リンクはリンクそのもの) の名前, i-node, 大きさ, 更新の時刻,
    # 種類と権限, 状態の変更の時刻 (chmod など) が同じなら, 前に求めた結果
    files = evaluation_files(run_dir)
    stats: list[tuple[str, int, int, int, int, int]] = []
    for path in files:
        try:
            stat = path.lstat()
        except OSError:
            continue
        stats.append(
            (
                path.name, stat.st_ino, stat.st_size, stat.st_mtime_ns,
                stat.st_mode, stat.st_ctime_ns
            )
        )
    key = (tuple(stats), monitor, mode)
    cached = EVALUATION_SUMMARY_CACHE.get(str(run_dir))
    if cached is not None and cached[0] == key:
        return cached[1]

    # 壊れた評価 1 つで実験の行が読めなくならないように, 理由を残して返却
    try:
        summary = build_summary(run_dir, files, monitor, mode)
    except Exception as error:
        summary = RunEvaluations(
            notice=(
                "evaluations/ を読めませんでした: "
                f"{type(error).__name__}: {error}"
            )
        )
    EVALUATION_SUMMARY_CACHE[str(run_dir)] = (key, summary)

    return summary


def forget_missing_summaries() -> None:
    """
    覚えた結果から, 実験のディレクトリか evaluations/ が無くなった実験の分を
    捨てる関数

    消した実験の分が残り続けないように, 一覧を読むたびに呼ぶ

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # 他の要求が書き足しても止まらないように, 名前の写しで処理
    for key in list(EVALUATION_SUMMARY_CACHE):
        if not is_plain_dir(Path(key) / EVALUATIONS_DIR):
            EVALUATION_SUMMARY_CACHE.pop(key, None)
