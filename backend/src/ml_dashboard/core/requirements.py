import json
import os
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from omegaconf import DictConfig, ListConfig, OmegaConf
from pydantic import ValidationError

from ml_dashboard.core.jobs import child_env
from ml_dashboard.core.models import (
    Requirement,
    RequirementCheck,
    RequirementReport,
    RequiresStatus,
)

# プロジェクトの Python で ML-Found の登録簿を確かめるスクリプト
# ML-Found の確かめ方は find_spec でモジュールを探すだけなので, Gymnasium
# などは読み込まない. 学習のスクリプトの出力と混ざらないように印を付けて出力
REPORT_MARK = "ML_DASHBOARD_REQUIREMENTS "
CHECK_SCRIPT = f"""\
import json
import sys

try:
    from ml_found import describe_requirements
except ImportError as error:
    payload = {{"error": f"{{type(error).__name__}}: {{error}}"}}
else:
    payload = {{"requirements": describe_requirements()}}
print({REPORT_MARK!r} + json.dumps(payload))
sys.stdout.flush()
"""

# 確かめの待ち時間の上限 (秒. ML-Found と PyTorch の読み込みを含む)
CHECK_TIMEOUT = 60

# 確かめた結果を覚えておく時間 (秒)
CACHE_SECONDS = 30.0

# エラーの文に添える標準エラー出力の文字数
STDERR_CHARS = 600

# config の一番上で要る機能を書く項目
REQUIRES_KEY = "requires"

# 入れ方の URL として出す前置き (javascript: などのリンクを作らないため)
URL_PREFIXES = ("https://", "http://")


class ReportCache:
    def __init__(self) -> None:
        # プロジェクトの Python とディレクトリごとの, 確かめた時刻と結果
        self.entries: dict[tuple[str, str], tuple[float, RequirementReport]]
        self.entries = {}
        self.lock = threading.Lock()
        # 同じ鍵の確かめを 1 つずつにするロック
        self.key_locks: dict[tuple[str, str], threading.Lock] = {}
        # Python ごとの, 覚えた結果を捨てた時刻 (それより前に始めた確かめ
        # の結果は覚えない)
        self.forgotten: dict[str, float] = {}

    def get(
        self, key: tuple[str, str], since: Optional[float] = None
    ) -> Optional[RequirementReport]:
        """
        覚えておく時間の中の結果を取り出す関数

        Parameters
        ----------
        key: tuple[str, str]
            プロジェクトの Python とディレクトリ
        since: Optional[float] = None
            この時刻 (time.monotonic) より後に確かめた結果だけを返す場合に
            指定

        Returns
        ----------
        report: Optional[RequirementReport]
            覚えた結果, 無いか古い場合は None
        """
        with self.lock:
            found = self.entries.get(key)
        report = None
        if found is None:
            return report
        fresh = time.monotonic() - found[0] < CACHE_SECONDS
        if (since is None and fresh) or (
            since is not None and found[0] >= since
        ):
            report = found[1]

        return report

    def key_lock(self, key: tuple[str, str]) -> threading.Lock:
        """
        鍵ごとの確かめのロックを取り出す関数

        Parameters
        ----------
        key: tuple[str, str]
            プロジェクトの Python とディレクトリ

        Returns
        ----------
        lock: threading.Lock
            同じ鍵の確かめを 1 つずつにするロック
        """
        with self.lock:
            lock = self.key_locks.setdefault(key, threading.Lock())

        return lock

    def put(
        self, key: tuple[str, str], report: RequirementReport,
        started: Optional[float] = None
    ) -> None:
        """
        確かめた結果を覚える関数

        Parameters
        ----------
        key: tuple[str, str]
            プロジェクトの Python とディレクトリ
        report: RequirementReport
            確かめた結果
        started: Optional[float] = None
            確かめを始めた時刻 (time.monotonic). 捨てた時刻より前なら
            覚えない (環境に入れている途中の結果を残さないため)

        Returns
        ----------
        None
        """
        with self.lock:
            forgotten = self.forgotten.get(key[0])
            if started is not None and forgotten is not None and (
                started < forgotten
            ):
                return
            self.entries[key] = (time.monotonic(), report)

    def forget(self, python: str) -> None:
        """
        ある Python で確かめた結果を捨てる関数 (環境に入れた後など)

        Parameters
        ----------
        python: str
            プロジェクトの Python

        Returns
        ----------
        None
        """
        with self.lock:
            self.forgotten[python] = time.monotonic()
            for key in [key for key in self.entries if key[0] == python]:
                del self.entries[key]

    def clear(self) -> None:
        """
        覚えた結果を全て捨てる関数 (テスト用)

        Parameters
        ----------
        None

        Returns
        ----------
        None
        """
        with self.lock:
            self.entries.clear()
            self.forgotten.clear()


# プロセスの中で共有する, 確かめた結果
REPORT_CACHE = ReportCache()


def to_requirement(item: Any) -> Optional[Requirement]:
    """
    ML-Found の describe_requirements の 1 項目を画面に返す形にする関数

    Parameters
    ----------
    item: Any
        1 つの機能の説明

    Returns
    ----------
    requirement: Optional[Requirement]
        機能の説明, 形が違う場合は None
    """
    result: Optional[Requirement] = None
    try:
        requirement = Requirement.model_validate(item)
    except ValidationError:
        return result

    # 入れ方の URL は http か https のものだけ
    url = requirement.install.url
    if url is not None and not url.startswith(URL_PREFIXES):
        requirement.install.url = None
    result = requirement

    return result


def parse_output(stdout: str) -> Optional[dict[str, Any]]:
    """
    確かめのスクリプトの出力から, 印を付けた行の JSON を取り出す関数

    Parameters
    ----------
    stdout: str
        標準出力

    Returns
    ----------
    payload: Optional[dict[str, Any]]
        結果の辞書, 見つからないか読めない場合は None
    """
    payload = None
    for line in reversed(stdout.splitlines()):
        if not line.startswith(REPORT_MARK):
            continue
        try:
            loaded = json.loads(line[len(REPORT_MARK):])
        except json.JSONDecodeError:
            return payload
        if isinstance(loaded, dict):
            payload = loaded
        return payload

    return payload


def to_report(
    python: str, checked_at: str, payload: dict[str, Any]
) -> RequirementReport:
    """
    確かめのスクリプトの結果を, 画面に返す形にする関数

    Parameters
    ----------
    python: str
        確かめた Python
    checked_at: str
        確かめた時刻
    payload: dict[str, Any]
        スクリプトが出した辞書

    Returns
    ----------
    report: RequirementReport
        機能ごとの説明と, 確かめられなかった理由
    """
    # ML-Found が無いか, describe_requirements を持たない版の場合
    if payload.get("error") is not None:
        report = RequirementReport(
            python=python, checked_at=checked_at, ml_found=False,
            error=(
                "プロジェクトの Python で ML-Found の describe_requirements "
                "を読み込めません (ML-Found が無いか, describe_requirements "
                f"を持たない版): {payload['error']}"
            )
        )
        return report

    items = payload.get("requirements")
    items = items if isinstance(items, list) else []
    requirements = [
        requirement for requirement in map(to_requirement, items)
        if requirement is not None
    ]
    error = None
    if not items:
        error = "ML-Found の登録簿の結果に機能がありません"
    elif len(requirements) < len(items):
        error = (
            "ML-Found の登録簿の結果の形が違います "
            f"({len(items) - len(requirements)} 個の項目を読めません)"
        )
    report = RequirementReport(
        python=python, checked_at=checked_at, requirements=requirements,
        error=error, ml_found=True
    )

    return report


def stop_group(process: subprocess.Popen[str]) -> None:
    """
    確かめのプロセスを, 子のプロセスごと止める関数 (待ち切りと, 終わった
    後に残った子のプロセスの片付けに使用)

    Parameters
    ----------
    process: subprocess.Popen[str]
        確かめのプロセス (別のグループで起動したもの)

    Returns
    ----------
    None
    """
    # 孫のプロセスが出力を持ったまま残らないように, グループごとに停止
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        process.kill()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def run_check(python: str, project_dir: Path) -> RequirementReport:
    """
    プロジェクトの Python の別のプロセスで ML-Found の登録簿を確かめる関数

    学習のスクリプトと同じくプロジェクトのディレクトリから動かすので,
    プロジェクトの中のモジュールも見つかる

    Parameters
    ----------
    python: str
        プロジェクトの Python
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    report: RequirementReport
        機能ごとの説明, 確かめられない場合は理由
    """
    checked_at = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        process = subprocess.Popen(
            [python, "-c", CHECK_SCRIPT], cwd=project_dir,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", env=child_env(), start_new_session=True
        )
    except OSError as error:
        report = RequirementReport(
            python=python, checked_at=checked_at,
            error=f"プロジェクトの Python を動かせません: {error}"
        )
        return report
    try:
        stdout, stderr = process.communicate(timeout=CHECK_TIMEOUT)
    except subprocess.TimeoutExpired:
        stop_group(process)
        report = RequirementReport(
            python=python, checked_at=checked_at,
            error=f"プロジェクトの Python の確かめが {CHECK_TIMEOUT} 秒で"
            "終わりませんでした"
        )
        return report

    # 印の付いた行が無い場合は, 標準エラー出力の末尾を理由に追加
    payload = parse_output(stdout)
    if payload is None:
        tail = stderr.strip()[-STDERR_CHARS:]
        report = RequirementReport(
            python=python, checked_at=checked_at,
            error=(
                "プロジェクトの Python で追加の依存を確かめられませんでした "
                f"(終了コード {process.returncode})"
                + (f": {tail}" if tail else "")
            )
        )
        return report
    report = to_report(python, checked_at, payload)

    return report


def check_requirements(
    python: str, project_dir: Path, refresh: bool = False
) -> RequirementReport:
    """
    プロジェクトの追加の依存を確かめる関数 (結果を少しの間覚えておく)

    Parameters
    ----------
    python: str
        プロジェクトの Python
    project_dir: Path
        プロジェクトのディレクトリ
    refresh: bool = False
        覚えた結果を使わずに確かめ直す場合は True

    Returns
    ----------
    report: RequirementReport
        機能ごとの説明, 確かめられない場合は理由
    """
    # 同じプロジェクトの確かめは 1 つずつ. 待つ間に他の要求が確かめた
    # 結果は, 確かめ直しでもそのまま使用
    key = (python, str(project_dir))
    started = time.monotonic()
    with REPORT_CACHE.key_lock(key):
        cached = REPORT_CACHE.get(key, since=started if refresh else None)
        if cached is not None:
            report = cached
            return report
        report = run_check(python, project_dir)
        REPORT_CACHE.put(key, report, started)

    return report


def read_requires(cfg: Any) -> tuple[list[str], Optional[str]]:
    """
    config の一番上の requires から, 学習に要る機能の名前を読む関数

    Parameters
    ----------
    cfg: Any
        default と合わせた config (DictConfig か辞書)

    Returns
    ----------
    names: list[str]
        機能の名前 (書いた順), 書いていない場合は空
    error: Optional[str]
        書き方の誤り, 無ければ None
    """
    names: list[str] = []
    error = None
    if not isinstance(cfg, (dict, DictConfig)):
        return names, error

    # 値の参照 (${...}) も学習と同じく解決. 解決できない参照は書き方の誤り
    try:
        value = cfg.get(REQUIRES_KEY)
        if isinstance(value, (DictConfig, ListConfig)):
            value = OmegaConf.to_container(value, resolve=True)
    except Exception as exception:
        error = f"requires を読めません: {exception}"
        return names, error
    if value is None:
        return names, error
    if not isinstance(value, list) or not all(
        isinstance(name, str) and name.strip() for name in value
    ):
        error = (
            "requires は機能の名前のリストで書いてください "
            f"(例: requires: [rl]): {value!r}"
        )
        return names, error
    if len(set(value)) != len(value):
        error = f"requires に同じ名前が 2 回以上あります: {value!r}"
        return names, error
    names = list(value)

    return names, error


def requires_status(
    names: list[str], report: RequirementReport
) -> RequiresStatus:
    """
    要る機能のうち, 足りないものと登録簿に無いものを分ける関数

    Parameters
    ----------
    names: list[str]
        config の requires に書いた機能の名前
    report: RequirementReport
        プロジェクトの Python で確かめた結果

    Returns
    ----------
    status: RequiresStatus
        足りない機能と登録簿に無い名前. 確かめられない場合は理由
    """
    if report.error is not None and not report.requirements:
        status = RequiresStatus(
            requires=names, python=report.python,
            check_error=report.error
        )
        return status
    known = {item.name: item for item in report.requirements}
    status = RequiresStatus(
        requires=names, python=report.python,
        missing=[
            known[name] for name in names
            if name in known and known[name].available is False
        ],
        unknown=[name for name in names if name not in known],
        unchecked=[
            name for name in names
            if name in known and known[name].available is None
        ],
        check_error=report.error
    )

    return status


def describe_next_step(requirement: Requirement) -> str:
    """
    足りない機能の次の一手 (入れ方) を文にする関数

    Parameters
    ----------
    requirement: Requirement
        足りない機能

    Returns
    ----------
    step: str
        入れ方の文
    """
    install = requirement.install
    if install.command:
        step = f"{requirement.name}: {install.command}"
        if install.extra_command:
            step += f" (ML-Found の追加の依存なら {install.extra_command})"
    elif install.url:
        step = (
            f"{requirement.name}: pip では入らないので, 公式の手順 "
            f"{install.url} に従って入れる"
        )
    else:
        step = (
            f"{requirement.name}: 入れ方は ML-Found の docs/DESIGN.md の"
            "「追加の依存」を見る"
        )

    return step


def old_checks(requirement: Requirement) -> list[RequirementCheck]:
    """
    入っているが版が下限より古い確かめ方を返す関数

    Parameters
    ----------
    requirement: Requirement
        確かめた機能

    Returns
    ----------
    checks: list[RequirementCheck]
        満たしていない (ok が False) で, 入っている版と下限のある確かめ方.
        版を書かない版の ML-Found の結果では空
    """
    checks = [
        check for check in requirement.checks
        if check.ok is False and check.version is not None
        and check.min_version is not None
    ]

    return checks


def is_old_version(requirement: Requirement) -> bool:
    """
    足りない機能が, 入っていないのではなく版が古いだけかを判定する関数

    Parameters
    ----------
    requirement: Requirement
        確かめた機能

    Returns
    ----------
    old: bool
        足りない機能で, 版の古い確かめ方を入れ替えれば満たせる場合は True.
        全てが要る (all) 機能は満たしていない確かめ方が全て版の古いもの,
        どれか 1 つ (any) の機能は版の古いものが 1 つでもある場合
    """
    if requirement.available is not False:
        return False
    old = old_checks(requirement)
    failed = [check for check in requirement.checks if check.ok is False]
    found = bool(old) and (
        requirement.match == "any" or len(old) == len(failed)
    )

    return found


def describe_old_version(requirement: Requirement) -> str:
    """
    版の古い確かめ方の, 入っている版と下限を文にする関数

    Parameters
    ----------
    requirement: Requirement
        版が古い機能

    Returns
    ----------
    text: str
        「gymnasium 0.29.1, 1.0 以上が要る」のような文. 複数は "; " で
        つなぐ
    """
    text = "; ".join(
        f"{check.name} {check.version}, {check.min_version} 以上が要る"
        for check in old_checks(requirement)
    )

    return text


def describe_missing(status: RequiresStatus) -> str:
    """
    足りない機能を, 起動を止める誤りの文にする関数

    入っていない機能と版が古い機能は分けて書く (何を直すかを取り違えない
    ため)

    Parameters
    ----------
    status: RequiresStatus
        足りない機能を含む結果

    Returns
    ----------
    message: str
        足りない機能の名前 (版が古いものは版と下限) と次の一手
    """
    absent = [item for item in status.missing if not is_old_version(item)]
    old = [item for item in status.missing if is_old_version(item)]
    parts = []
    if absent:
        names = ", ".join(item.name for item in absent)
        parts.append(f"{names} が入っていません")
    if old:
        names = ", ".join(item.name for item in old)
        details = "; ".join(describe_old_version(item) for item in old)
        parts.append(f"{names} は入っている版が古いです ({details})")
    steps = ". ".join(describe_next_step(item) for item in status.missing)
    message = (
        f"config の requires に書いた機能のうち, {'. '.join(parts)} "
        f"(プロジェクトの Python: {status.python}). 次の一手: {steps}"
    )

    return message


def describe_warnings(status: RequiresStatus) -> list[str]:
    """
    起動は止めない, 要る機能の注意を作る関数

    Parameters
    ----------
    status: RequiresStatus
        要る機能の結果

    Returns
    ----------
    warnings: list[str]
        登録簿に無い名前と, 確かめられない理由の注意
    """
    warnings = []
    if status.unknown:
        warnings.append(
            "requires の " + ", ".join(status.unknown) + " は ML-Found の"
            "登録簿に無いので, 入っているかを確かめていません"
        )
    unchecked = [
        name for name in status.unchecked if name not in status.unknown
    ]
    if unchecked:
        warnings.append(
            "requires の " + ", ".join(unchecked) + " は入っているかを"
            "確かめられませんでした"
        )
    if status.check_error is not None:
        warnings.append(
            "requires の機能が入っているかを確かめられませんでした: "
            f"{status.check_error}"
        )

    return warnings


def requires_from_text(
    default_path: Path, text: str
) -> tuple[list[str], Optional[str]]:
    """
    default の config と experiment の config の中身から, requires だけを
    読む関数 (ML-Found を読み込まない)

    ML-Found の config の合わせ方と同じく, experiment に書いた requires が
    default の requires を置き換える. YAML が読めない場合は, 起動の前の
    確認が誤りを出すので, 何も要らないものとして扱う

    Parameters
    ----------
    default_path: Path
        default の config
    text: str
        experiment の config の中身

    Returns
    ----------
    names: list[str]
        機能の名前
    error: Optional[str]
        requires の書き方の誤り, 無ければ None
    """
    names: list[str] = []
    error = None
    try:
        default_cfg = OmegaConf.load(default_path)
        experiment = OmegaConf.create(text if text.strip() else "{}")
    except Exception:
        return names, error
    # ML-Found と同じく default に重ねる (default の値の参照も解決できる)
    # 重ねられない形の違いは, 起動の前の確認が誤りを出す
    try:
        source = OmegaConf.merge(default_cfg, experiment)
    except Exception:
        return names, error
    names, error = read_requires(source)

    return names, error
