import csv
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from omegaconf import OmegaConf

from ml_dashboard.core.logs import (
    find_message,
    parse_env,
    parse_log,
    parse_number,
    parse_packages,
)
from ml_dashboard.core.models import (
    BestValue,
    History,
    LogEntry,
    RunDetail,
    RunFile,
    RunStatus,
    RunSummary,
)

# 実験のディレクトリの日付と時刻の名前
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^(\d{2})-(\d{2})-(\d{2})(?:_\d+)?$")

# ファイルの種類の判定に使う拡張子
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
CHECKPOINT_SUFFIXES = {".pt", ".pth", ".ckpt", ".safetensors"}
TEXT_SUFFIXES = {".yaml", ".yml", ".csv", ".log", ".patch", ".json", ".txt"}


def find_run_dirs(output_dir: Path) -> list[Path]:
    """
    出力先から実験のディレクトリを探す関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir

    Returns
    ----------
    run_dirs: list[Path]
        <output_dir>/<name>/<日付>/<時刻>/ のディレクトリ, 新しい順
    """
    if not output_dir.is_dir():
        return []

    # 名前, 日付, 時刻の 3 階層で, ML-Found が書く config があるもの
    run_dirs = [
        path for path in output_dir.glob("*/*/*")
        if path.is_dir() and DATE_PATTERN.match(path.parent.name)
        and TIME_PATTERN.match(path.name)
        and (path / "config.yaml").is_file()
    ]
    run_dirs.sort(key=lambda path: (path.parent.name, path.name), reverse=True)

    return run_dirs


def make_run_id(output_dir: Path, run_dir: Path) -> str:
    """
    実験の ID を作る関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    run_id: str
        <name>/<日付>/<時刻> の形の ID
    """
    run_id = run_dir.relative_to(output_dir).as_posix()

    return run_id


def resolve_run_dir(output_dir: Path, run_id: str) -> Path:
    """
    実験の ID からディレクトリを取得する関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir
    run_id: str
        実験の ID

    Returns
    ----------
    run_dir: Path
        実験のディレクトリ
    """
    # 出力先の外を指す ID と, 実験ではないディレクトリを拒否
    run_dir = (output_dir / run_id).resolve()
    if run_dir not in find_run_dirs_set(output_dir):
        raise FileNotFoundError(f"実験が見つかりません: {run_id}")

    return run_dir


def find_run_dirs_set(output_dir: Path) -> set[Path]:
    """
    実験のディレクトリを絶対パスの集合で取得する関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir

    Returns
    ----------
    run_dirs: set[Path]
        実験のディレクトリの絶対パス
    """
    run_dirs = {path.resolve() for path in find_run_dirs(output_dir)}

    return run_dirs


def parse_started_at(run_dir: Path) -> str:
    """
    ディレクトリ名から実験を開始した日時を取得する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    started_at: str
        ISO 8601 の日時
    """
    match = TIME_PATTERN.match(run_dir.name)
    assert match is not None
    hour, minute, second = match.groups()
    started_at = datetime.fromisoformat(
        f"{run_dir.parent.name}T{hour}:{minute}:{second}"
    ).isoformat()

    return started_at


def to_float(value: str) -> Optional[float]:
    """
    CSV の値を数値に変換する関数

    Parameters
    ----------
    value: str
        CSV のセルの文字列

    Returns
    ----------
    number: Optional[float]
        数値, 空か nan や inf の場合は None
    """
    try:
        number = float(value)
    except ValueError:
        return None

    # JSON で表せない値は欠損として扱う
    if not math.isfinite(number):
        return None

    return number


def read_history(run_dir: Path) -> History:
    """
    history.csv を読み込む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    history: History
        列の名前とエポックごとの値
    """
    path = run_dir / "history.csv"
    if not path.is_file():
        return History(columns=[], rows=[])

    with path.open(encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file)
        columns = list(reader.fieldnames or [])
        rows = [
            {key: to_float(value or "") for key, value in row.items()}
            for row in reader
        ]
    history = History(columns=columns, rows=rows)

    return history


def load_config(run_dir: Path, name: str) -> dict[str, Any]:
    """
    実験のディレクトリの config を辞書で読み込む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    name: str
        ファイル名

    Returns
    ----------
    config: dict[str, Any]
        config の中身, 無い場合は空の辞書
    """
    path = run_dir / name
    if not path.is_file():
        return {}

    loaded = OmegaConf.to_container(OmegaConf.load(path), resolve=False)
    config = loaded if isinstance(loaded, dict) else {}

    return {str(key): value for key, value in config.items()}


def get_monitor(config: dict[str, Any], columns: list[str]) -> tuple[str, str]:
    """
    ベストモデルの判定に使った指標と向きを取得する関数

    Parameters
    ----------
    config: dict[str, Any]
        実験の config
    columns: list[str]
        history.csv の列の名前

    Returns
    ----------
    monitor: str
        監視する指標
    mode: str
        min か max
    """
    # config で指定が無い場合は, ML-Found と同じく検証の損失か学習の損失
    trainer = config.get("trainer") or {}
    monitor = trainer.get("monitor")
    if not monitor:
        monitor = "valid/loss" if "valid/loss" in columns else "train/loss"
    mode = str(trainer.get("mode") or "min")

    return str(monitor), mode


def compute_best(
    history: History, monitor: str, mode: str
) -> Optional[BestValue]:
    """
    指標の推移からベストのエポックを求める関数

    Parameters
    ----------
    history: History
        指標の推移
    monitor: str
        監視する指標
    mode: str
        min か max

    Returns
    ----------
    best: Optional[BestValue]
        ベストのエポックと値, 指標が無い場合は None
    """
    # 最初に最良値に達したエポックを選ぶ
    best = None
    for row in history.rows:
        value = row.get(monitor)
        epoch = row.get("epoch")
        if value is None or epoch is None:
            continue
        if best is None or (
            value > best.value if mode == "max" else value < best.value
        ):
            best = BestValue(
                monitor=monitor, mode=mode, epoch=int(epoch), value=value
            )

    return best


def judge_status(entries: list[LogEntry]) -> RunStatus:
    """
    ログから実験の状態を判定する関数

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    status: RunStatus
        完了, 失敗, 不明のどれか
    """
    if any(entry.message.startswith("学習完了") for entry in entries):
        status: RunStatus = "completed"
    elif any(entry.level in ("ERROR", "CRITICAL") for entry in entries):
        status = "failed"
    else:
        status = "unknown"

    return status


def summarize_run(output_dir: Path, run_dir: Path) -> RunSummary:
    """
    実験の概要をまとめる関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    summary: RunSummary
        一覧に表示する実験の情報
    """
    # 指標の推移, config, ログの読み込み
    history = read_history(run_dir)
    config = load_config(run_dir, "config.yaml")
    entries = parse_log(run_dir / "train.log")

    # ベストモデルは, ログにあればその値, 無ければ指標の推移から計算
    monitor, mode = get_monitor(config, history.columns)
    best = compute_best(history, monitor, mode)
    best_epoch = parse_number(find_message(entries, "ベストモデルのエポック:"))
    if best is not None and best_epoch is not None:
        logged = next(
            (
                row.get(monitor) for row in history.rows
                if row.get("epoch") == best_epoch
            ),
            None
        )
        if logged is not None:
            best = BestValue(
                monitor=monitor, mode=mode, epoch=int(best_epoch),
                value=logged
            )

    # 最後のエポックの指標
    final_metrics = dict(history.rows[-1]) if history.rows else {}
    final_metrics.pop("epoch", None)

    # Early Stopping で止めたエポック
    early = find_message(entries, "Early Stopping (エポック")
    early_epoch = parse_number(early)

    trainer = config.get("trainer") or {}
    experiment = config.get("experiment") or {}
    summary = RunSummary(
        id=make_run_id(output_dir, run_dir),
        name=str(experiment.get("name") or run_dir.parent.parent.name),
        started_at=parse_started_at(run_dir),
        status=judge_status(entries),
        epochs=len(history.rows),
        planned_epochs=trainer.get("epochs"),
        best=best,
        duration_sec=parse_number(find_message(entries, "学習時間:")),
        early_stopped_epoch=int(early_epoch) if early_epoch else None,
        diff=load_config(run_dir, "diff.yaml"),
        final_metrics=final_metrics
    )

    return summary


def classify_file(path: Path) -> str:
    """
    ファイルの種類を判定する関数

    Parameters
    ----------
    path: Path
        ファイルのパス

    Returns
    ----------
    kind: str
        image, checkpoint, text, other のどれか
    """
    suffix = path.suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        kind = "image"
    elif suffix in CHECKPOINT_SUFFIXES:
        kind = "checkpoint"
    elif suffix in TEXT_SUFFIXES:
        kind = "text"
    else:
        kind = "other"

    return kind


def list_files(run_dir: Path) -> list[RunFile]:
    """
    実験のディレクトリのファイルを列挙する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    files: list[RunFile]
        相対パス, 大きさ, 種類
    """
    files = [
        RunFile(
            path=path.relative_to(run_dir).as_posix(),
            size=path.stat().st_size,
            kind=classify_file(path)  # type: ignore[arg-type]
        )
        for path in sorted(run_dir.rglob("*"))
        if path.is_file() and not path.is_symlink()
    ]

    return files


def detail_run(output_dir: Path, run_dir: Path) -> RunDetail:
    """
    実験の詳細をまとめる関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの experiment.output_dir
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    detail: RunDetail
        詳細の画面に表示する実験の情報
    """
    summary = summarize_run(output_dir, run_dir)
    entries = parse_log(run_dir / "train.log")
    seed = parse_number(find_message(entries, "乱数シード:"))
    params = parse_number(find_message(entries, "パラメータ数:"))
    detail = RunDetail(
        **summary.model_dump(),
        config=load_config(run_dir, "config.yaml"),
        seed=int(seed) if seed is not None else None,
        device=find_message(entries, "デバイス:"),
        parameter_count=int(params) if params is not None else None,
        model_structure=find_message(entries, "モデルの構造:"),
        optimizer=find_message(entries, "Optimizer:"),
        scheduler=find_message(entries, "Scheduler:"),
        env=parse_env(entries),
        packages=parse_packages(entries),
        files=list_files(run_dir),
        has_git_diff=(run_dir / "git_diff.patch").is_file()
    )

    return detail


def resolve_run_file(run_dir: Path, relative: str) -> Path:
    """
    実験のディレクトリの中のファイルのパスを取得する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    relative: str
        実験のディレクトリからの相対パス

    Returns
    ----------
    path: Path
        ファイルの絶対パス
    """
    # 実験のディレクトリの外とシンボリックリンクを拒否
    path = (run_dir / relative).resolve()
    if not path.is_relative_to(run_dir) or not path.is_file():
        raise FileNotFoundError(f"ファイルが見つかりません: {relative}")

    return path
