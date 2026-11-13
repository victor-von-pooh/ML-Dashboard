import csv
import json
import math
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, cast

from omegaconf import OmegaConf

from ml_dashboard.core.logs import (
    DEFAULT_FORMAT,
    find_message,
    parse_env,
    parse_epoch_metrics,
    parse_log,
    parse_number,
    parse_packages,
)
from ml_dashboard.core.models import (
    BestValue,
    FileKind,
    History,
    LogEntry,
    LrPoint,
    Mode,
    ModelParam,
    ParamValue,
    Progress,
    RunDetail,
    RunFile,
    RunParams,
    RunStatus,
    RunSummary,
)

# 実験のディレクトリの日付と時刻の名前
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^(\d{2})-(\d{2})-(\d{2})(?:_(\d+))?$")

# ファイルの種類の判定に使う拡張子
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
CHECKPOINT_SUFFIXES = {".pt", ".pth", ".ckpt", ".safetensors"}
TEXT_SUFFIXES = {".yaml", ".yml", ".csv", ".log", ".patch", ".json", ".txt"}

# run.json の final_weights の値 (final_model.pt の重み)
FINAL_WEIGHTS = ("best", "last", "partial")

# 更新ごとの学習率をグラフに渡す点の数の上限
MAX_LR_STEPS = 5000

# 詳細の画面に返す model_summary.csv の行数の上限
MAX_MODEL_SUMMARY_ROWS = 2000


class RunNotFoundError(Exception):
    pass


def is_valid_date(name: str) -> bool:
    """
    日付のディレクトリ名が実在する日付かを判定する関数

    Parameters
    ----------
    name: str
        ディレクトリ名

    Returns
    ----------
    valid: bool
        YYYY-MM-DD の形で実在する日付かどうか
    """
    if not DATE_PATTERN.match(name):
        return False
    try:
        datetime.strptime(name, "%Y-%m-%d")
    except ValueError:
        return False
    valid = True

    return valid


def run_sort_key(run_dir: Path) -> tuple[str, str, int]:
    """
    実験のディレクトリを開始した順に並べるための値を作る関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    key: tuple[str, str, int]
        日付, 時刻, 同じ秒に始めた実験の連番
    """
    match = TIME_PATTERN.match(run_dir.name)
    suffix = int(match.group(4)) if match and match.group(4) else 0
    key = (run_dir.parent.name, run_dir.name[:8], suffix)

    return key


def is_run_dir(path: Path, output_dir: Path) -> bool:
    """
    ML-Found の実験のディレクトリかを判定する関数

    Parameters
    ----------
    path: Path
        判定するディレクトリ
    output_dir: Path
        プロジェクトの出力先

    Returns
    ----------
    valid: bool
        出力先の中にあり, 日付と時刻の名前で config.yaml を持つかどうか
    """
    # シンボリックリンクで出力先の外を指すものは対象外
    try:
        inside = path.resolve().is_relative_to(output_dir.resolve())
    except OSError:
        return False
    valid = (
        inside and path.is_dir() and is_valid_date(path.parent.name)
        and TIME_PATTERN.match(path.name) is not None
        and (path / "config.yaml").is_file()
    )

    return valid


def find_run_dirs(output_dirs: list[Path]) -> list[tuple[Path, Path]]:
    """
    出力先から実験のディレクトリを探す関数

    Parameters
    ----------
    output_dirs: list[Path]
        プロジェクトの出力先 (experiment.output_dir) の候補

    Returns
    ----------
    runs: list[tuple[Path, Path]]
        出力先と実験のディレクトリの組, 新しい順
    """
    # 名前, 日付, 時刻の 3 階層で, ML-Found が書く config があるもの
    runs: list[tuple[Path, Path]] = []
    for output_dir in output_dirs:
        if not output_dir.is_dir():
            continue
        runs.extend(
            (output_dir, path) for path in output_dir.glob("*/*/*")
            if is_run_dir(path, output_dir)
        )
    runs.sort(key=lambda item: run_sort_key(item[1]), reverse=True)

    return runs


def make_run_id(output_dir: Path, run_dir: Path) -> str:
    """
    実験の ID を作る関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの出力先
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    run_id: str
        <name>/<日付>/<時刻> の形の ID
    """
    run_id = run_dir.relative_to(output_dir).as_posix()

    return run_id


def resolve_run_dir(output_dirs: list[Path], run_id: str) -> Path:
    """
    実験の ID からディレクトリを取得する関数

    Parameters
    ----------
    output_dirs: list[Path]
        プロジェクトの出力先の候補
    run_id: str
        <name>/<日付>/<時刻> の形の ID

    Returns
    ----------
    run_dir: Path
        実験のディレクトリ
    """
    # 3 階層の名前の形を先に確かめ, 出力先の外への移動を拒否
    parts = run_id.split("/")
    valid = (
        len(parts) == 3 and parts[0] not in ("", ".", "..")
        and is_valid_date(parts[1]) and TIME_PATTERN.match(parts[2])
    )
    if valid:
        for output_dir in output_dirs:
            run_dir = output_dir / run_id
            if is_run_dir(run_dir, output_dir):
                return run_dir

    raise RunNotFoundError(f"実験が見つかりません: {run_id}")


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
    started_at = datetime.strptime(
        f"{run_dir.parent.name} {run_dir.name[:8]}", "%Y-%m-%d %H-%M-%S"
    ).isoformat()

    return started_at


def to_float(value: Any) -> Optional[float]:
    """
    CSV や JSON の値を数値に変換する関数

    Parameters
    ----------
    value: Any
        変換する値

    Returns
    ----------
    number: Optional[float]
        数値, 変換できないか nan や inf の場合は None
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    # JSON で表せない値は欠損として扱い
    if not math.isfinite(number):
        return None

    return number


def read_history_csv(path: Path) -> History:
    """
    history.csv を読み込む関数

    Parameters
    ----------
    path: Path
        history.csv のパス

    Returns
    ----------
    history: History
        列の名前とエポックごとの値
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    reader = csv.DictReader(text.splitlines())
    columns = [str(name) for name in reader.fieldnames or []]

    # 見出しより多い列 (キーが None) は捨て, 見出しの列だけを数値に変換
    rows = [
        {key: to_float(row.get(key)) for key in columns} for row in reader
    ]
    history = History(columns=columns, rows=rows)

    return history


def thin_indices(values: list[float], limit: int) -> list[int]:
    """
    折れ線を間引くときに残す点の番号を選ぶ関数

    等しい幅の区間ごとに最小と最大の点を残すので, 周期の短い変化の山と谷も
    消えない. 最初と最後の点も残す

    Parameters
    ----------
    values: list[float]
        点の値, NaN は比べる対象外
    limit: int
        残す点の数の上限

    Returns
    ----------
    indices: list[int]
        残す点の番号 (小さい順)
    """
    count = len(values)
    if count <= limit:
        return list(range(count))

    # 最初と最後の 2 点を除いた数を, 区間ごとの 2 点で割り振り
    buckets = max((limit - 2) // 2, 1)
    chosen = {0, count - 1}
    for bucket in range(buckets):
        low = bucket * count // buckets
        high = max((bucket + 1) * count // buckets, low + 1)
        span = [
            index for index in range(low, high)
            if not math.isnan(values[index])
        ] or [low]
        chosen.add(min(span, key=lambda index: values[index]))
        chosen.add(max(span, key=lambda index: values[index]))
    indices = sorted(chosen)

    return indices


# 読み込んだ lr_steps.csv の点 (ファイルの更新時刻と大きさが同じ間は再利用)
LR_CACHE: dict[str, tuple[tuple[int, int, int], list[LrPoint]]] = {}


# 読み込んだ model_summary.csv (ファイルの更新時刻と大きさが同じ間は再利用)
SummaryResult = tuple[Optional[list[ModelParam]], Optional[int]]
SUMMARY_CACHE: dict[str, tuple[tuple[int, int, int], SummaryResult]] = {}

# model_summary.csv の必須の列
SUMMARY_COLUMNS = (
    "name", "kind", "module", "shape", "dtype", "numel", "requires_grad"
)


def read_model_summary(
    path: Path, limit: int = MAX_MODEL_SUMMARY_ROWS
) -> tuple[Optional[list[ModelParam]], Optional[int]]:
    """
    model_summary.csv (パラメータとバッファの一覧) を読み込む関数

    学習の開始時に 1 回だけ書かれるので, 学習中に詳細を取り直しても
    読み直さないように, 更新時刻と大きさが同じ間は前の結果を使う

    Parameters
    ----------
    path: Path
        model_summary.csv のパス
    limit: int = MAX_MODEL_SUMMARY_ROWS
        返す行数の上限, 超える場合は先頭から

    Returns
    ----------
    rows: Optional[list[ModelParam]]
        一覧, ファイルが無いか空か読めない場合は None
    total: Optional[int]
        ファイルの全体の行数
    """
    # 古い ML-Found の実験は表示なし, 同じファイルなら前の結果を使用
    try:
        stat = path.stat()
    except OSError:
        return None, None
    key = (stat.st_mtime_ns, stat.st_size, limit)
    cached = SUMMARY_CACHE.get(str(path))
    if cached is not None and cached[0] == key:
        return cached[1]

    # 必須の列が欠けた行 (書きかけや壊れたファイル) があれば表示なし
    rows: list[ModelParam] = []
    total = 0
    result: SummaryResult
    try:
        with path.open(encoding="utf-8-sig", newline="") as file:
            for record in csv.DictReader(file):
                if any(record.get(name) is None for name in SUMMARY_COLUMNS):
                    raise ValueError("model_summary.csv の列が足りません")
                total += 1
                if len(rows) >= limit:
                    continue
                rows.append(
                    ModelParam(
                        name=record["name"], kind=record["kind"],
                        module=record["module"], shape=record["shape"],
                        dtype=record["dtype"], numel=int(record["numel"]),
                        requires_grad=record["requires_grad"] == "True",
                        same_as=record.get("same_as") or ""
                    )
                )
        result = (rows, total) if total > 0 else (None, None)
    except (OSError, ValueError, TypeError, csv.Error):
        result = (None, None)
    SUMMARY_CACHE[str(path)] = (key, result)

    return result


def read_lr_steps(path: Path, limit: int = MAX_LR_STEPS) -> list[LrPoint]:
    """
    lr_steps.csv (更新ごとの学習率) を, エポックの軸の上の点にして読み込む関数

    エポック e の更新は, そのエポックの記録の数で e から e + 1 の間に等間隔に
    並べるので, エポックの最初の更新はエポックを始めた時点の学習率と同じ位置

    Parameters
    ----------
    path: Path
        lr_steps.csv のパス
    limit: int = MAX_LR_STEPS
        返す点の数の上限, 超える場合は区間ごとの最小と最大を残して間引く

    Returns
    ----------
    points: list[LrPoint]
        エポックの軸の上の位置と学習率, エポックの読めない行は除外
    """
    stat = path.stat()
    key = (stat.st_mtime_ns, stat.st_size, limit)
    cached = LR_CACHE.get(str(path))
    if cached is not None and cached[0] == key:
        return cached[1]

    # 大きなファイルでも軽く済むように, 1 行ずつ数だけを読み込み
    epochs: list[int] = []
    lrs: list[float] = []
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, [])
        if "epoch" not in header or "lr" not in header:
            return []
        epoch_column, lr_column = header.index("epoch"), header.index("lr")
        for row in reader:
            if len(row) <= max(epoch_column, lr_column):
                continue
            epoch = to_float(row[epoch_column])
            if epoch is None:
                continue
            lr = to_float(row[lr_column])
            epochs.append(int(epoch))
            lrs.append(math.nan if lr is None else lr)

    # エポックごとの記録の数で位置を決め, 間引いてから返却
    counts: dict[int, int] = {}
    for epoch in epochs:
        counts[epoch] = counts.get(epoch, 0) + 1
    seen: dict[int, int] = {}
    positions = []
    for epoch in epochs:
        index = seen.get(epoch, 0)
        seen[epoch] = index + 1
        positions.append(epoch + index / counts[epoch])
    points = [
        LrPoint(
            x=positions[index],
            lr=None if math.isnan(lrs[index]) else lrs[index]
        )
        for index in thin_indices(lrs, limit)
    ]
    LR_CACHE[str(path)] = (key, points)

    return points


def read_history(run_dir: Path, entries: list[LogEntry]) -> History:
    """
    実験の指標の推移を読み込む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    history: History
        列の名前とエポックごとの値
    """
    # 学習を終えると history.csv が書かれるので, あればそれを使用
    path = run_dir / "history.csv"
    if path.is_file():
        history = read_history_csv(path)
        lr_path = run_dir / "lr_steps.csv"
        if lr_path.is_file():
            history.lr_steps = read_lr_steps(lr_path)
        return history

    # 学習中や失敗した実験は, ログのエポックごとの指標から作り直し
    rows = parse_epoch_metrics(entries)
    columns: list[str] = []
    for row in rows:
        columns.extend(key for key in row if key not in columns)
    history = History(columns=columns, rows=rows)

    return history


def load_yaml(path: Path) -> dict[str, Any]:
    """
    YAML のファイルを辞書で読み込む関数

    Parameters
    ----------
    path: Path
        ファイルのパス

    Returns
    ----------
    config: dict[str, Any]
        ファイルの中身, 無いか辞書でない場合は空の辞書
    """
    if not path.is_file():
        return {}

    loaded = OmegaConf.to_container(OmegaConf.load(path), resolve=False)
    config = (
        {str(key): value for key, value in loaded.items()}
        if isinstance(loaded, dict) else {}
    )

    return config


def read_json(path: Path) -> dict[str, Any]:
    """
    JSON のファイルを辞書で読み込む関数

    Parameters
    ----------
    path: Path
        ファイルのパス

    Returns
    ----------
    data: dict[str, Any]
        ファイルの中身, 無いか壊れている場合は空の辞書
    """
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    data = loaded if isinstance(loaded, dict) else {}

    return data


def section(config: dict[str, Any], name: str) -> dict[str, Any]:
    """
    config の節を辞書で取得する関数

    Parameters
    ----------
    config: dict[str, Any]
        config
    name: str
        節の名前

    Returns
    ----------
    part: dict[str, Any]
        節の中身, 無いか辞書でない場合は空の辞書
    """
    value = config.get(name)
    part = value if isinstance(value, dict) else {}

    return part


def get_monitor(
    config: dict[str, Any], columns: list[str]
) -> tuple[str, Mode]:
    """
    ベストモデルの判定に使った指標と向きを取得する関数

    Parameters
    ----------
    config: dict[str, Any]
        実験の config
    columns: list[str]
        指標の推移の列の名前

    Returns
    ----------
    monitor: str
        監視する指標
    mode: Mode
        min か max
    """
    # 指定が無い場合は, ML-Found と同じく検証の損失か学習の損失
    trainer = section(config, "trainer")
    monitor = str(trainer.get("monitor") or "")
    if not monitor:
        monitor = "valid/loss" if "valid/loss" in columns else "train/loss"
    mode: Mode = "max" if trainer.get("mode") == "max" else "min"

    return monitor, mode


def compute_best(
    history: History, monitor: str, mode: Mode
) -> Optional[BestValue]:
    """
    指標の推移からベストのエポックを求める関数

    Parameters
    ----------
    history: History
        指標の推移
    monitor: str
        監視する指標
    mode: Mode
        min か max

    Returns
    ----------
    best: Optional[BestValue]
        ベストのエポックと値, 指標が無い場合は None
    """
    # 最初に最良値に達したエポックの選択
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


def value_at(history: History, monitor: str, epoch: float) -> Optional[float]:
    """
    指定したエポックの指標の値を取得する関数

    Parameters
    ----------
    history: History
        指標の推移
    monitor: str
        指標の名前
    epoch: float
        エポック

    Returns
    ----------
    value: Optional[float]
        値, 無い場合は None
    """
    value = next(
        (
            row.get(monitor) for row in history.rows
            if row.get("epoch") == epoch
        ),
        None
    )

    return value


def judge_status(entries: list[LogEntry]) -> RunStatus:
    """
    ログから実験の状態を判定する関数 (run.json が無い古い実験で使う)

    Parameters
    ----------
    entries: list[LogEntry]
        ログの記録

    Returns
    ----------
    status: RunStatus
        完了, 失敗, 不明のどれか
    """
    messages = {entry.message for entry in entries}
    if "学習完了" in messages:
        status: RunStatus = "completed"
    elif any(entry.level in ("ERROR", "CRITICAL") for entry in entries):
        status = "failed"
    else:
        status = "unknown"

    return status


def pid_alive(pid: Any) -> bool:
    """
    プロセスが動いているかを確かめる関数

    Parameters
    ----------
    pid: Any
        run.json に書かれたプロセスの ID

    Returns
    ----------
    alive: bool
        動いているかどうか
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    alive = True

    return alive


def read_progress(run_dir: Path) -> Optional[Progress]:
    """
    progress.json から学習の進み具合を読み込む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    progress: Optional[Progress]
        進み具合, 無い場合は None
    """
    data = read_json(run_dir / "progress.json")
    if not data:
        return None

    # 経過時間はこのプロセスの分なので, 再開した最初のエポックも追加
    start = read_json(run_dir / "run.json").get("start_epoch")
    if isinstance(start, int):
        data["start_epoch"] = start

    try:
        progress = Progress.model_validate(data)
    except ValueError:
        return None

    return progress


class RunData:
    def __init__(self, output_dir: Path, run_dir: Path):
        # 実験のディレクトリと出力先を保存
        self.output_dir = output_dir
        self.run_dir = run_dir

        # config, ML-Found の状態, ログ, 指標の推移の読み込み
        self.config = load_yaml(run_dir / "config.yaml")
        self.status = read_json(run_dir / "run.json")
        log_format = section(self.config, "experiment").get("log_format")
        self.entries = parse_log(
            run_dir / "train.log",
            log_format if isinstance(log_format, str) else DEFAULT_FORMAT
        )
        self.history = read_history(run_dir, self.entries)

    def run_status(self) -> RunStatus:
        """
        実験の状態を判定する関数

        Parameters
        ----------
        None

        Returns
        ----------
        status: RunStatus
            run.json があればその状態, 無ければログから判定した状態
        """
        value = self.status.get("status")
        if value not in ("running", "completed", "stopped", "failed"):
            status = judge_status(self.entries)
            return status

        # 実行中のまま残っていても, プロセスが無ければ強制終了として扱い
        if value == "running" and not pid_alive(self.status.get("pid")):
            status = "unknown"
            return status

        status = cast(RunStatus, value)

        return status

    def best(self) -> Optional[BestValue]:
        """
        ベストのエポックと値を求める関数

        Parameters
        ----------
        None

        Returns
        ----------
        best: Optional[BestValue]
            run.json かログの値, 無ければ指標の推移から計算した値.
            ベストモデルを選ばない設定 (select_best: false) の実験は None
        """
        # GAN のように損失で良し悪しを決められない実験には, ベストを出さない
        trainer = section(self.config, "trainer")
        if self.status.get("select_best") is False or (
            trainer.get("select_best") is False
        ):
            return None

        monitor, mode = get_monitor(self.config, self.history.columns)
        if isinstance(self.status.get("monitor"), str):
            monitor = self.status["monitor"]

        # ML-Found が記録したベストのエポック (同じ値の比べ方も反映済み)
        epoch = to_float(self.status.get("best_epoch"))
        if epoch is None:
            epoch = parse_number(
                find_message(self.entries, "ベストモデルのエポック:")
            )
        if epoch:
            value = value_at(self.history, monitor, epoch)
            if value is None:
                value = to_float(self.status.get("best_value"))
            if value is not None:
                logged = BestValue(
                    monitor=monitor, mode=mode, epoch=int(epoch), value=value
                )
                return logged

        best = compute_best(self.history, monitor, mode)

        return best

    def summary(self) -> RunSummary:
        """
        一覧に表示する実験の概要をまとめる関数

        Parameters
        ----------
        None

        Returns
        ----------
        summary: RunSummary
            実験の概要
        """
        # 最後のエポックの指標
        final_metrics = (
            dict(self.history.rows[-1]) if self.history.rows else {}
        )
        final_metrics.pop("epoch", None)

        # 学習時間と Early Stopping で止めたエポックは run.json を優先
        duration = to_float(self.status.get("duration_sec"))
        if duration is None:
            duration = parse_number(find_message(self.entries, "学習時間:"))
        early = to_float(self.status.get("early_stopped_epoch"))
        if early is None:
            early = parse_number(
                find_message(self.entries, "Early Stopping (エポック")
            )

        trainer = section(self.config, "trainer")
        experiment = section(self.config, "experiment")
        status = self.run_status()
        planned = to_float(
            self.status.get("planned_epochs", trainer.get("epochs"))
        )
        summary = RunSummary(
            id=make_run_id(self.output_dir, self.run_dir),
            name=str(
                experiment.get("name") or self.run_dir.parent.parent.name
            ),
            started_at=parse_started_at(self.run_dir),
            status=status,
            epochs=len(self.history.rows),
            planned_epochs=int(planned) if planned is not None else None,
            best=self.best(),
            duration_sec=duration,
            early_stopped_epoch=int(early) if early is not None else None,
            diff=load_yaml(self.run_dir / "diff.yaml"),
            final_metrics=final_metrics,
            progress=(
                read_progress(self.run_dir) if status == "running" else None
            ),
            error=self.status.get("error") if status == "failed" else None
        )

        return summary

    def detail(self) -> RunDetail:
        """
        詳細の画面に表示する実験の情報をまとめる関数

        Parameters
        ----------
        None

        Returns
        ----------
        detail: RunDetail
            実験の詳細
        """
        # 乱数シードとデバイスは config と run.json を優先, 無ければログを使用
        experiment = section(self.config, "experiment")
        seed = to_float(experiment.get("seed"))
        if seed is None:
            seed = parse_number(find_message(self.entries, "乱数シード:"))
        device = self.status.get("device") or find_message(
            self.entries, "デバイス:"
        )
        params = parse_number(find_message(self.entries, "パラメータ数:"))
        summary_rows, summary_total = read_model_summary(
            self.run_dir / "model_summary.csv"
        )
        detail = RunDetail(
            **self.summary().model_dump(),
            config=self.config,
            seed=int(seed) if seed is not None else None,
            device=str(device) if device else None,
            parameter_count=int(params) if params is not None else None,
            model_structure=find_message(self.entries, "モデルの構造:"),
            optimizer=find_message(self.entries, "Optimizer:"),
            scheduler=find_message(self.entries, "Scheduler:"),
            env=parse_env(self.entries),
            packages=parse_packages(self.entries),
            files=list_files(self.run_dir),
            has_git_diff=(self.run_dir / "git_diff.patch").is_file(),
            final_weights=(
                self.status["final_weights"]
                if self.status.get("final_weights") in FINAL_WEIGHTS
                else None
            ),
            model_summary=summary_rows,
            model_summary_rows=summary_total
        )

        return detail


def summarize_run(output_dir: Path, run_dir: Path) -> RunSummary:
    """
    実験の概要をまとめ, 読めない実験は最低限の情報で返す関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの出力先
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    summary: RunSummary
        一覧に表示する実験の情報
    """
    # 壊れた実験 1 つで一覧全体が読めなくならないように, 理由を残して返却
    try:
        summary = RunData(output_dir, run_dir).summary()
    except Exception as error:
        summary = RunSummary(
            id=make_run_id(output_dir, run_dir),
            name=run_dir.parent.parent.name,
            started_at=parse_started_at(run_dir), status="unknown",
            epochs=0, planned_epochs=None, best=None, duration_sec=None,
            early_stopped_epoch=None, diff={}, final_metrics={},
            progress=None,
            error=f"読み込めませんでした: {type(error).__name__}: {error}"
        )

    return summary


def classify_file(path: Path) -> FileKind:
    """
    ファイルの種類を判定する関数

    Parameters
    ----------
    path: Path
        ファイルのパス

    Returns
    ----------
    kind: FileKind
        image, checkpoint, text, other のどれか
    """
    suffix = path.suffix.lower()
    kind: FileKind
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
        相対パス, 大きさ, 種類, シンボリックリンクは対象外
    """
    files = []
    for root, dirs, names in os.walk(run_dir, followlinks=False):
        dirs.sort()
        for name in sorted(names):
            path = Path(root) / name
            if path.is_symlink() or not path.is_file():
                continue
            files.append(
                RunFile(
                    path=path.relative_to(run_dir).as_posix(),
                    size=path.stat().st_size, kind=classify_file(path)
                )
            )

    return files


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
        ファイルのパス
    """
    # 一覧と同じく, 途中も含めてシンボリックリンクと外への移動を拒否
    parts = Path(relative).parts
    path = run_dir
    for part in parts:
        if part in ("", ".", "..") or Path(part).is_absolute():
            raise RunNotFoundError(f"ファイルが見つかりません: {relative}")
        path = path / part
        if path.is_symlink():
            raise RunNotFoundError(f"ファイルが見つかりません: {relative}")
    if not parts or not path.is_file():
        raise RunNotFoundError(f"ファイルが見つかりません: {relative}")

    return path


def flatten_params(data: Any, prefix: str = "") -> dict[str, ParamValue]:
    """
    入れ子の config を分析に使える平らな辞書にする関数

    Parameters
    ----------
    data: Any
        config の値
    prefix: str = ""
        親の項目名

    Returns
    ----------
    flat: dict[str, ParamValue]
        . でつないだ項目名と, 数値, 文字列, 真偽値, None の値.
        nan と inf も None (欠損) として扱い
    """
    # 辞書は子の項目ごとに平らにして集約 (最上位の空の辞書は項目なし)
    if isinstance(data, dict) and (data or not prefix):
        flat: dict[str, ParamValue] = {}
        for key, item in data.items():
            child = f"{prefix}.{key}" if prefix else str(key)
            flat.update(flatten_params(item, child))
        return flat

    # 値は数値と真偽値はそのまま, 配列や空の辞書は JSON の文字列
    if isinstance(data, bool) or data is None or isinstance(data, str):
        value: ParamValue = data
    elif isinstance(data, (int, float)):
        value = to_float(data)
    else:
        value = json.dumps(data, ensure_ascii=False, default=str)
    flat = {prefix: value}

    return flat


def collect_params(output_dir: Path, run_dir: Path) -> Optional[RunParams]:
    """
    実験の config と結果を分析用にまとめる関数

    Parameters
    ----------
    output_dir: Path
        プロジェクトの出力先
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    params: Optional[RunParams]
        config の値と結果, 読めない実験は None
    """
    # 壊れた実験は分析から除外
    try:
        data = RunData(output_dir, run_dir)
        summary = data.summary()
        params = RunParams(
            id=summary.id, name=summary.name, started_at=summary.started_at,
            status=summary.status, best=summary.best,
            final_metrics=summary.final_metrics,
            params=flatten_params(data.config)
        )
    except Exception:
        return None

    return params
