import json
import math
import os
import re
import stat
import threading
import unicodedata
from pathlib import Path
from typing import Any, Literal, Optional

from ml_dashboard.core.loader import import_ml_found
from ml_dashboard.core.models import (
    Better,
    CellValue,
    Evaluation,
    PolicyEnd,
    PolicyEndShare,
    PolicyGuards,
    PolicyOutcome,
    PolicySpace,
    RunLink,
    RunPolicy,
    RunResults,
    RunTask,
    Sample,
    SampleClass,
    SampleCloud,
    TaskOrigin,
)
from ml_dashboard.core.projects import (
    Project,
    ProjectError,
    ProjectStore,
    get_output_dirs,
)
from ml_dashboard.core.runs import (
    RunNotFoundError,
    is_run_dir,
    make_run_id,
    resolve_run_file,
)

# 守り付きの評価 (ML-Found の evaluate_policy の行) の終え方の並びと,
# 守りの結果ごとの数の列 (ML-Found の docs/DESIGN.md の「守り付きの評価」)
POLICY_ENDS: tuple[PolicyEnd, ...] = (
    "terminated", "truncated", "max_steps", "stop", "handover"
)
POLICY_STATUSES = ("ok", "clipped", "fallback", "stop", "handover")

# 守りが行動を返さずにエピソードを終えた終え方
POLICY_GUARDED_ENDS: tuple[PolicyEnd, ...] = ("stop", "handover")

# ML-Found の実験のディレクトリの任意のファイル (ML-Found の docs/FORMAT.md)
TASK_FILE = "task.yaml"
EVALUATIONS_DIR = "evaluations"
SAMPLES_DIR = "samples"
SAMPLES_INDEX = "index.json"

# 方策の一式 (ML-Found の docs/FORMAT.md の「方策の一式」)
POLICY_DIR = "policy"
POLICY_SPEC = "policy.json"

# 1 つの評価で返す行の上限 (多い場合は先頭だけ)
MAX_EVALUATION_ROWS = 2000

# 読む評価のファイルの大きさの上限
MAX_EVALUATION_BYTES = 20 * 1024 * 1024

# evaluations/ がリンクの実験の注意 (評価の無い実験と見分けるため)
EVALUATIONS_LINK_NOTICE = (
    "evaluations/ がシンボリックリンクなので, 評価を読んでいません"
)

# 出さなかった評価のファイルを注意に並べる数の上限と, 名前の長さの上限
MAX_SKIPPED_SHOWN = 10
MAX_SHOWN_NAME = 80

# 評価の名前の決まり (ML-Found の docs/FORMAT.md. 一覧の列の名前を
# <評価の名前>:<列> にするので, : を含む名前も除く)
EVALUATION_NAME = re.compile(r"[A-Za-z0-9_@-][A-Za-z0-9_.@-]*")

# 評価のファイルを, リンクを辿らず (O_NOFOLLOW) 待たずに (O_NONBLOCK) 開く旗.
# 旗の無い環境では 0
FILE_FLAGS = (
    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    | getattr(os, "O_BINARY", 0)
)
DIR_FLAGS = (
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
)

# 評価の種類 (曲線は横軸の列がある場合だけ)
EVALUATION_KINDS = ("table", "curve")

# 指標の向き (ML-Found の docs/FORMAT.md の「指標の向き」)
BETTER_VALUES = ("lower", "higher")

# 比べる相手との表の形で, 同じ指標の向きを持つ列の名前の終わり
# (<指標>, <指標>_baseline, <指標>_diff)
METRIC_SUFFIXES = ("_baseline", "_diff")

# 見本の種類 (知らない種類はその他のファイルとして扱う)
SAMPLE_KINDS = ("image", "text", "audio", "point_cloud", "mask", "file")

# 点群の見本で読む PLY の大きさの上限と, 返す点の数の上限
MAX_CLOUD_BYTES = 20 * 1024 * 1024
MAX_CLOUD_POINTS = 20000

# 正解の出どころの種類 (知らない種類は分からないものとして扱う)
ORIGIN_TYPES = ("process", "annotation", "measurement", "synthetic", "unknown")


def has_results(run_dir: Path) -> bool:
    """
    実験が task.yaml, evaluations/, samples/index.json のどれかを持つかを
    判定する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    found: bool
        どれかを持つかどうか. 持たない実験では ML-Found を読み込まない
    """
    found = (
        is_plain_file(run_dir / TASK_FILE)
        or is_plain_dir(run_dir / EVALUATIONS_DIR)
        or has_samples_index(run_dir)
        or has_policy(run_dir)
    )

    return found


def has_policy(run_dir: Path) -> bool:
    """
    方策の一式 (policy/policy.json) を持つかを判定する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    found: bool
        policy/ と policy.json がどちらもシンボリックリンクでなく, あるかどうか
    """
    folder = run_dir / POLICY_DIR
    found = is_plain_dir(folder) and is_plain_file(folder / POLICY_SPEC)

    return found


def has_samples_index(run_dir: Path) -> bool:
    """
    見本の一覧 (samples/index.json) を持つかを判定する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    found: bool
        samples/ と index.json がどちらもシンボリックリンクでなく, 一覧が
        あるかどうか
    """
    folder = run_dir / SAMPLES_DIR
    found = is_plain_dir(folder) and is_plain_file(folder / SAMPLES_INDEX)

    return found


def is_plain_file(path: Path) -> bool:
    """
    シンボリックリンクでないファイルかを判定する関数

    実験のディレクトリの外を読まないため (ファイルを返す API と同じ方針)

    Parameters
    ----------
    path: Path
        判定するパス

    Returns
    ----------
    plain: bool
        リンクでない, 普通のファイルかどうか
    """
    plain = not path.is_symlink() and path.is_file()

    return plain


def is_plain_dir(path: Path) -> bool:
    """
    シンボリックリンクでないディレクトリかを判定する関数

    Parameters
    ----------
    path: Path
        判定するパス

    Returns
    ----------
    plain: bool
        リンクでない, 普通のディレクトリかどうか
    """
    plain = not path.is_symlink() and path.is_dir()

    return plain


def text_or_none(value: Any) -> Optional[str]:
    """
    文字の値だけを取り出す関数

    Parameters
    ----------
    value: Any
        ファイルの値

    Returns
    ----------
    text: Optional[str]
        空でない文字, それ以外は None
    """
    text = value if isinstance(value, str) and value != "" else None

    return text


def int_or_none(value: Any) -> Optional[int]:
    """
    整数の値だけを取り出す関数

    Parameters
    ----------
    value: Any
        ファイルの値

    Returns
    ----------
    number: Optional[int]
        整数 (真偽値は除く), それ以外は None
    """
    number = (
        value if isinstance(value, int) and not isinstance(value, bool)
        else None
    )

    return number


def dict_or_empty(value: Any) -> dict[str, Any]:
    """
    辞書の値だけを取り出す関数

    Parameters
    ----------
    value: Any
        ファイルの値

    Returns
    ----------
    data: dict[str, Any]
        辞書, それ以外は空の辞書
    """
    data = value if isinstance(value, dict) else {}

    return data


def find_base_run(
    base: str, project: Project, store: ProjectStore
) -> Optional[RunLink]:
    """
    元にした実験のパスから, 登録したプロジェクトの実験を探す関数

    Parameters
    ----------
    base: str
        task.yaml の base.experiment (プロジェクトからの相対パスか絶対パス)
    project: Project
        task.yaml を持つ実験のプロジェクト
    store: ProjectStore
        登録したプロジェクト (同じプロジェクトに無い場合だけ読む)

    Returns
    ----------
    link: Optional[RunLink]
        見つかった実験のつなぎ, 無ければ None
    """
    # 相対パスは task.yaml を書いたプロジェクトから辿る
    path = Path(base).expanduser()
    if not path.is_absolute():
        path = Path(project.path) / path
    try:
        target = path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None

    # 同じプロジェクトを先に探し, 無ければ他の登録したプロジェクト
    link = find_in_project(target, project)
    if link is not None:
        return link
    try:
        projects = store.load()
    except ProjectError:
        return None
    for candidate in projects:
        if candidate.id == project.id:
            continue
        link = find_in_project(target, candidate)
        if link is not None:
            return link

    return None


def find_in_project(target: Path, candidate: Project) -> Optional[RunLink]:
    """
    1 つのプロジェクトの出力先から実験のディレクトリを探す関数

    Parameters
    ----------
    target: Path
        探す実験のディレクトリ (解決した絶対パス)
    candidate: Project
        探すプロジェクト

    Returns
    ----------
    link: Optional[RunLink]
        出力先の名前, 日付, 時刻の 3 階層の実験なら, そのつなぎ
    """
    try:
        output_dirs = get_output_dirs(Path(candidate.path))
    except ProjectError:
        return None
    for output_dir in output_dirs:
        try:
            root = output_dir.resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if not target.is_relative_to(root):
            continue
        if len(target.relative_to(root).parts) != 3:
            continue
        if is_run_dir(target, root):
            link = RunLink(
                project_id=candidate.id, run_id=make_run_id(root, target)
            )
            return link

    return None


def read_task(
    run_dir: Path, project: Project, store: ProjectStore,
    notices: list[str]
) -> Optional[RunTask]:
    """
    task.yaml を ML-Found の load_task で読み, 画面に出す形にする関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    project: Project
        実験のプロジェクト
    store: ProjectStore
        登録したプロジェクト (元にした実験を探すため)
    notices: list[str]
        読めなかった場合の注意を足すリスト

    Returns
    ----------
    task: Optional[RunTask]
        何の実験か, 無いか読めない場合は None
    """
    from ml_found.experiment.task import describe_origin, load_task

    # 新しい版は返す値 (newer_version) で画面に知らせる. ML-Found の警告は
    # サーバーのログに残るだけ (警告の抑止はプロセス全体に効くので使わない)
    if not is_plain_file(run_dir / TASK_FILE):
        return None
    try:
        data = load_task(run_dir)
    except Exception as error:
        notices.append(
            "task.yaml を読めませんでした: "
            f"{str(error).replace(str(run_dir), '<実験>')}"
        )
        return None
    if data is None:
        notices.append(
            "task.yaml を読めませんでした (YAML として読めないか, 辞書で"
            "ない)"
        )
        return None

    # 正解の出どころ. 知らない種類は分からないもの
    target = dict_or_empty(data.get("target"))
    origin = dict_or_empty(target.get("origin"))
    origin_type = origin.get("type")
    version = int_or_none(data.get("format_version")) or 1
    base = dict_or_empty(data.get("base"))
    dataset = dict_or_empty(data.get("dataset"))
    base_experiment = text_or_none(base.get("experiment"))

    task = RunTask(
        format_version=version,
        newer_version=data.get("newer_version") is True,
        role=text_or_none(data.get("role")),
        output=text_or_none(data.get("output")),
        what=text_or_none(data.get("what")),
        target_kind=text_or_none(target.get("kind")),
        origin=TaskOrigin(
            type=origin_type if origin_type in ORIGIN_TYPES else "unknown",
            name=text_or_none(origin.get("name")),
            settings=origin.get("settings")
        ),
        origin_note=describe_origin(origin, version),
        method=text_or_none(data.get("method")),
        base_experiment=base_experiment,
        base_weights=text_or_none(base.get("weights")),
        base_run=(
            find_base_run(base_experiment, project, store)
            if base_experiment else None
        ),
        dataset_name=text_or_none(dataset.get("name")),
        dataset_path=text_or_none(dataset.get("path"))
    )

    return task


def to_cell(value: Any) -> CellValue:
    """
    評価の表の値を, 画面に返せる値にする関数

    Parameters
    ----------
    value: Any
        JSON の値

    Returns
    ----------
    cell: CellValue
        数, 文字, 真偽値, None. nan と無限大は None, 辞書や並びは文字
    """
    cell: CellValue
    if value is None or isinstance(value, (bool, int, str)):
        cell = value
    elif isinstance(value, float):
        cell = value if math.isfinite(value) else None
    else:
        cell = json.dumps(value, ensure_ascii=False, default=str)

    return cell


def has_evaluation_shape(data: dict[str, Any]) -> bool:
    """
    評価のファイルの中身の形 (名前, 列, 行) を確かめる関数

    行は作らないので, 出さない評価の形を軽く確かめるのにも使う

    Parameters
    ----------
    data: dict[str, Any]
        evaluations/<名前>.json の中身

    Returns
    ----------
    shaped: bool
        名前 (空でない文字), 列 (文字のリスト), 行 (辞書のリスト) を
        持つかどうか
    """
    columns = data.get("columns")
    rows = data.get("rows")
    shaped = (
        text_or_none(data.get("name")) is not None
        and isinstance(columns, list)
        and all(isinstance(column, str) for column in columns)
        and isinstance(rows, list)
        and all(isinstance(row, dict) for row in rows)
    )

    return shaped


def same_file(first: Path, second: Path) -> bool:
    """
    2 つのパスが同じ普通のファイルを指すかを判定する関数

    Parameters
    ----------
    first: Path
        1 つ目のパス
    second: Path
        2 つ目のパス

    Returns
    ----------
    same: bool
        どちらもリンクでない普通のファイルで, デバイスと i-node が同じか
    """
    try:
        first_stat = first.lstat()
        second_stat = second.lstat()
    except OSError:
        return False
    same = (
        stat.S_ISREG(first_stat.st_mode)
        and (first_stat.st_dev, first_stat.st_ino)
        == (second_stat.st_dev, second_stat.st_ino)
    )

    return same


def evaluation_problem(
    folder: Optional[Path], stem: str, data: dict[str, Any]
) -> Optional[str]:
    """
    評価のファイルの形と名前の問題を返す関数

    評価のタブと一覧で同じ評価を出すため, どちらもこの関数で確かめる

    Parameters
    ----------
    folder: Optional[Path]
        evaluations/ (大文字と小文字を区別しない置き場で, 名前の大文字と
        小文字だけが違う同じファイルを確かめるため. None なら確かめない)
    stem: str
        ファイルの名前 (.json を除く)
    data: dict[str, Any]
        evaluations/<名前>.json の中身

    Returns
    ----------
    problem: Optional[str]
        形が違う, 中の name がファイルの名前と違う, 名前が決まりに合わない
        のどれか. 問題が無ければ None
    """
    if not has_evaluation_shape(data):
        return "形が違う"
    name: str = data["name"]

    # 大文字と小文字だけが違い, 同じファイルを指す名前 (大文字と小文字を
    # 区別しない置き場で書き直した場合) は同じ名前とみなす
    same = name == stem or (
        folder is not None and name.casefold() == stem.casefold()
        and EVALUATION_NAME.fullmatch(name) is not None
        and same_file(folder / f"{stem}.json", folder / f"{name}.json")
    )
    problem: Optional[str] = None
    if not same:
        problem = "中の name がファイルの名前と違う"
    elif EVALUATION_NAME.fullmatch(name) is None:
        problem = "名前が決まりに合わない"

    return problem


def shown_name(name: str) -> str:
    """
    注意の文に出すファイルの名前を整える関数

    UTF-8 にできない名前 (サロゲート) で応答の JSON を作れなくならず,
    制御文字や向きの変わる文字 (U+202E など) で文が読み違えられないため

    Parameters
    ----------
    name: str
        ファイルの名前

    Returns
    ----------
    shown: str
        制御文字などの種類 (unicodedata の category が C) の文字を \\uXXXX
        (BMP の外は \\UXXXXXXXX) にし, MAX_SHOWN_NAME 文字までに切った
        名前 (書き換えた文字の途中では切らない)
    """
    pieces: list[str] = []
    length = 0
    for char in name:
        code = ord(char)
        piece = (
            char if not unicodedata.category(char).startswith("C")
            else f"\\u{code:04x}" if code <= 0xFFFF else f"\\U{code:08x}"
        )
        if length + len(piece) > MAX_SHOWN_NAME:
            pieces.append("…")
            break
        pieces.append(piece)
        length += len(piece)
    shown = "".join(pieces)

    return shown


def skip_entry(name: str, reason: str) -> str:
    """
    出さなかったファイルの名前と理由を, 注意に並べる形にする関数

    Parameters
    ----------
    name: str
        ファイルの名前
    reason: str
        理由

    Returns
    ----------
    entry: str
        <ファイルの名前> (<理由>)
    """
    entry = f"{shown_name(name)} ({reason})"

    return entry


def skipped_notice(skipped: list[str]) -> Optional[str]:
    """
    出さなかった評価のファイルの注意の文を作る関数

    Parameters
    ----------
    skipped: list[str]
        出さなかったファイルの名前と理由 (<ファイルの名前> (<理由>))

    Returns
    ----------
    notice: Optional[str]
        注意の文. 名前の順に先頭の MAX_SKIPPED_SHOWN 個を並べる. 無ければ
        None
    """
    if not skipped:
        return None
    shown = sorted(skipped)[:MAX_SKIPPED_SHOWN]
    rest = len(skipped) - len(shown)
    notice = (
        f"evaluations/ の {len(skipped)} 個のファイルを出していません: "
        + ", ".join(shown) + (f" ほか {rest} 個" if rest > 0 else "")
        + ". 名前の決まりは, 中の name がファイルの名前と同じで, 英数字と "
        "_ . @ - だけ"
    )

    return notice


def skip_reason(path: Path) -> str:
    """
    読めなかった評価のファイルの理由を返す関数

    読んだ後に lstat で調べ直すので, 注意の文に出すためだけに使う

    Parameters
    ----------
    path: Path
        評価のファイル

    Returns
    ----------
    reason: str
        リンク, 普通のファイルでない, 大きすぎる, 読めない のどれか
    """
    try:
        link_stat = path.lstat()
    except OSError:
        return "読めない"
    if stat.S_ISLNK(link_stat.st_mode):
        reason = "シンボリックリンク"
    elif not stat.S_ISREG(link_stat.st_mode):
        reason = "普通のファイルでない (FIFO など)"
    elif link_stat.st_size > MAX_EVALUATION_BYTES:
        reason = "大きすぎる"
    else:
        reason = "読めない"

    return reason


def metric_family(column: str, columns: list[str]) -> list[str]:
    """
    比べる相手との表の形で, 列と同じ指標の列を集める関数

    Parameters
    ----------
    column: str
        列の名前
    columns: list[str]
        表の列

    Returns
    ----------
    family: list[str]
        <指標>, <指標>_baseline, <指標>_diff のうち表にある列 (列の順).
        列自体も含む. 終わりは 1 段だけ外す (acc_baseline_diff の指標は
        acc_baseline)
    """
    # 終わりを除いた名前を指標とし, 同じ指標の 3 つの列の候補を作成
    metric = column
    for suffix in METRIC_SUFFIXES:
        if column.endswith(suffix) and len(column) > len(suffix):
            metric = column[:-len(suffix)]
            break
    candidates = {metric} | {metric + suffix for suffix in METRIC_SUFFIXES}
    family = [
        item for item in columns if item in candidates or item == column
    ]

    return family


def read_better(data: dict[str, Any]) -> dict[str, Better]:
    """
    評価のファイルの中身から列ごとの指標の向きを読む関数

    ML-Found の docs/FORMAT.md の「指標の向き」と同じに読む

    Parameters
    ----------
    data: dict[str, Any]
        evaluations/<名前>.json の中身

    Returns
    ----------
    better: dict[str, Better]
        表の列のうち向きのあるもの (同じ指標の列に広げたもの, 列の順).
        better を持たないファイルは空. 表に無い列と知らない値の欄は除き,
        書いていない列に違う向きが届く場合は埋めない
    """
    # 列が文字のリストでない場合と better が辞書でない場合は向きが無い扱い
    columns = data.get("columns")
    raw = data.get("better")
    better: dict[str, Better] = {}
    if (
        not isinstance(columns, list)
        or not all(isinstance(column, str) for column in columns)
        or not isinstance(raw, dict)
    ):
        return better
    filled: dict[str, Better] = {
        column: value for column, value in raw.items()
        if column in columns and value in BETTER_VALUES
    }

    # 向きのある列から同じ指標の列へ届く向きを, 変化が無くなるまで広げる
    # (各回で全ての列から集めてから決めるので, 書いた順に頼らない)
    while True:
        arrivals: dict[str, set[Better]] = {}
        for column, value in filled.items():
            for item in metric_family(column, columns):
                arrivals.setdefault(item, set()).add(value)
        added = {
            item: next(iter(values)) for item, values in arrivals.items()
            if len(values) == 1 and item not in filled
        }
        if not added:
            break
        filled.update(added)
    better = {column: filled[column] for column in columns if column in filled}

    return better


def evaluation_kind(data: dict[str, Any]) -> str:
    """
    評価を曲線と表のどちらで出すかを返す関数

    評価のタブの出し方と守り付きの評価の判定で同じものを使う

    Parameters
    ----------
    data: dict[str, Any]
        形を確かめた evaluations/<名前>.json の中身

    Returns
    ----------
    kind: str
        横軸の列のある曲線は curve, それ以外は table
    """
    x = text_or_none(data.get("x"))
    kind = (
        "curve" if data.get("kind") == "curve" and x in data["columns"]
        else "table"
    )

    return kind


def to_evaluation(data: dict[str, Any]) -> Optional[Evaluation]:
    """
    評価のファイルの中身を, 画面に返す形にする関数

    Parameters
    ----------
    data: dict[str, Any]
        evaluations/<名前>.json の中身

    Returns
    ----------
    evaluation: Optional[Evaluation]
        評価, 名前, 列, 行の形が違う場合は None
    """
    # 名前, 列 (文字のリスト), 行 (辞書のリスト) を持つものだけ
    if not has_evaluation_shape(data):
        return None
    name: str = data["name"]
    columns: list[str] = data["columns"]
    rows: list[dict[str, Any]] = data["rows"]

    # 曲線は横軸の列がある場合だけ, それ以外は表として出す
    x = text_or_none(data.get("x"))
    kind = evaluation_kind(data)
    kept = [
        {column: to_cell(row.get(column)) for column in columns}
        for row in rows[:MAX_EVALUATION_ROWS]
    ]

    evaluation = Evaluation(
        name=name,
        split=text_or_none(data.get("split")),
        kind=kind,
        x=x if kind == "curve" else None,
        columns=columns,
        rows=kept,
        description=text_or_none(data.get("description")),
        baseline=text_or_none(data.get("baseline")),
        guard=data.get("guard") is True,
        better=read_better(data),
        epoch=int_or_none(data.get("epoch")),
        created_at=text_or_none(data.get("created_at")),
        total_rows=len(rows)
    )

    return evaluation


def is_policy_evaluation(data: dict[str, Any]) -> bool:
    """
    評価が守り付きの評価 (evaluate_policy の行の表) かを判定する関数

    Parameters
    ----------
    data: dict[str, Any]
        形を確かめた evaluations/<名前>.json の中身

    Returns
    ----------
    found: bool
        評価のタブで表として出す評価で, 列に end と守りの結果ごとの数の
        列を全て持つか
    """
    columns = data["columns"]
    found = (
        evaluation_kind(data) == "table" and "end" in columns
        and all(status in columns for status in POLICY_STATUSES)
    )

    return found


def share(count: int, total: int) -> Optional[float]:
    """
    数の割合を返す関数

    Parameters
    ----------
    count: int
        数
    total: int
        全体の数

    Returns
    ----------
    ratio: Optional[float]
        割合, 全体が 0 の場合は None
    """
    ratio = count / total if total > 0 else None

    return ratio


def to_policy_outcome(data: dict[str, Any]) -> Optional[PolicyOutcome]:
    """
    守り付きの評価の全ての行から, 終え方ごとの割合を数える関数

    画面に返す行は先頭だけなので, 割合はファイルの全ての行から求める

    Parameters
    ----------
    data: dict[str, Any]
        形を確かめた evaluations/<名前>.json の中身

    Returns
    ----------
    outcome: Optional[PolicyOutcome]
        終え方ごとの割合, 守り付きの評価でない場合は None
    """
    if not is_policy_evaluation(data):
        return None
    rows: list[dict[str, Any]] = data["rows"]

    # 終え方ごとの数. 知らない値と値の無い行は other
    counts: dict[PolicyEnd, int] = {end: 0 for end in POLICY_ENDS}
    other = 0
    for row in rows:
        end = row.get("end")
        if isinstance(end, str) and end in counts:
            counts[end] += 1
        else:
            other += 1
    total = len(rows)
    ends = [
        PolicyEndShare(end=end, count=count, ratio=share(count, total))
        for end, count in counts.items()
    ]
    if other > 0:
        ends.append(
            PolicyEndShare(end="other", count=other, ratio=share(other, total))
        )

    # 守りが止めたか元の制御に戻したエピソード
    guarded = sum(counts[end] for end in POLICY_GUARDED_ENDS)
    outcome = PolicyOutcome(
        name=data["name"],
        split=text_or_none(data.get("split")),
        description=text_or_none(data.get("description")),
        epoch=int_or_none(data.get("epoch")),
        episodes=total,
        ends=ends,
        guarded=guarded,
        guarded_ratio=share(guarded, total)
    )

    return outcome


def evaluation_order(evaluation: Evaluation) -> tuple[bool, str]:
    """
    評価を並べる順を返す関数

    Parameters
    ----------
    evaluation: Evaluation
        評価

    Returns
    ----------
    order: tuple[bool, str]
        守る指標を先にし, 次に名前の順
    """
    order = (not evaluation.guard, evaluation.name)

    return order


def evaluation_files(run_dir: Path) -> list[Path]:
    """
    evaluations/ の評価のファイルを集める関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    files: list[Path]
        一時ファイル (. で始まる) とディレクトリを除いた *.json.
        シンボリックリンクと普通でないファイル (FIFO など) も含む (読まずに
        数えるため). evaluations/ が無いか, リンクなら空
    """
    folder = run_dir / EVALUATIONS_DIR
    files: list[Path] = []
    if not is_plain_dir(folder):
        return files
    files = sorted(
        path for path in folder.glob("*.json")
        if not path.name.startswith(".")
        and (path.is_symlink() or not path.is_dir())
    )

    return files


def read_plain_file(
    path: Path, dir_fd: Optional[int], limit: int
) -> Optional[bytes]:
    """
    普通のファイルを, 上限の大きさまで読む関数

    確かめてから読むまでの間にリンクや FIFO に置き換えられても外を読まず
    止まらないように, リンクを辿らず (O_NOFOLLOW), 待たずに (O_NONBLOCK)
    開き, 開いたものが普通のファイルかを確かめてから読む. dir_fd を使えない
    環境では, lstat で確かめたファイルと開いたファイルが同じかも比べる

    Parameters
    ----------
    path: Path
        ファイルのパス
    dir_fd: Optional[int]
        開いた親のディレクトリ (使えない環境では None)
    limit: int
        読む大きさの上限 (バイト)

    Returns
    ----------
    content: Optional[bytes]
        中身. リンク, 普通でないファイル, 上限を超えるファイル, 読めない
        ファイルは None
    """
    # 開く先 (dir_fd があれば名前, 無ければ lstat で確かめたパス)
    expected: Optional[tuple[int, int]] = None
    try:
        if dir_fd is not None:
            fd = os.open(path.name, FILE_FLAGS, dir_fd=dir_fd)
        else:
            link_stat = path.lstat()
            if not stat.S_ISREG(link_stat.st_mode):
                return None
            expected = (link_stat.st_dev, link_stat.st_ino)
            fd = os.open(path, FILE_FLAGS)
    except (OSError, NotImplementedError):
        return None

    # 上限 + 1 バイトまでの読み込み (超えれば None)
    chunks: list[bytes] = []
    total = 0
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (
            expected is not None
            and (opened.st_dev, opened.st_ino) != expected
        ):
            return None
        while total <= limit:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
    except OSError:
        return None
    finally:
        os.close(fd)
    content = b"".join(chunks) if total <= limit else None

    return content


def can_use_dir_fd() -> bool:
    """
    ディレクトリをリンクを辿らずに開き, dir_fd から開けるかを判定する関数

    Parameters
    ----------
    None

    Returns
    ----------
    usable: bool
        os.open が dir_fd を使え, O_NOFOLLOW があるか (Windows などは偽)
    """
    usable = os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")

    return usable


def dir_identity(folder: Path) -> Optional[tuple[int, int]]:
    """
    リンクでないディレクトリのデバイスと i-node を返す関数

    Parameters
    ----------
    folder: Path
        ディレクトリ

    Returns
    ----------
    identity: Optional[tuple[int, int]]
        デバイスと i-node. リンクか, ディレクトリでないか, 無ければ None
    """
    try:
        folder_stat = folder.lstat()
    except OSError:
        return None
    identity = (
        (folder_stat.st_dev, folder_stat.st_ino)
        if stat.S_ISDIR(folder_stat.st_mode) else None
    )

    return identity


def open_plain_dir(folder: Path) -> Optional[int]:
    """
    ディレクトリをリンクを辿らずに開く関数

    Parameters
    ----------
    folder: Path
        ディレクトリ

    Returns
    ----------
    dir_fd: Optional[int]
        開いたディレクトリ. dir_fd を使えない環境と開けない場合は None
    """
    dir_fd: Optional[int] = None
    if not can_use_dir_fd():
        return dir_fd
    try:
        dir_fd = os.open(folder, DIR_FLAGS)
    except (OSError, NotImplementedError):
        dir_fd = None

    return dir_fd


def load_plain_evaluations(
    run_dir: Path, files: list[Path]
) -> tuple[list[tuple[str, dict[str, Any]]], list[str]]:
    """
    評価のファイルのうち, シンボリックリンクでない普通のファイルだけを読む関数

    ML-Found の load_evaluations はリンクと普通でないファイル (FIFO など) も
    辿って読むので, 実験のディレクトリの外を読まないようにここで読む.
    読み方 (JSON の辞書だけ, 読めないファイルは飛ばす) は load_evaluations と
    同じ. 実験のディレクトリより上の入れ替わりは確かめない (他のファイルの
    読み方と同じ)

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    files: list[Path]
        evaluation_files が集めたファイル

    Returns
    ----------
    loaded: list[tuple[str, dict[str, Any]]]
        ファイルの名前の順の, ファイルの名前 (.json を除く) と中身
    skipped: list[str]
        読まなかったファイルの名前と理由
    """
    # evaluations/ もリンクを辿らずに開き, 中のファイルはその dir_fd から.
    # dir_fd を使えない環境では, evaluations/ の入れ替わりをデバイスと
    # i-node で確かめる
    loaded: list[tuple[str, dict[str, Any]]] = []
    skipped: list[str] = []
    folder = run_dir / EVALUATIONS_DIR
    dir_fd = open_plain_dir(folder)
    identity = dir_identity(folder) if dir_fd is None else None
    if dir_fd is None and (can_use_dir_fd() or identity is None):
        skipped = [skip_entry(path.name, "読めない") for path in files]
        return loaded, skipped
    try:
        for path in files:
            content = (
                read_plain_file(path, dir_fd, MAX_EVALUATION_BYTES)
                if dir_fd is not None or dir_identity(folder) == identity
                else None
            )
            if content is None:
                skipped.append(skip_entry(path.name, skip_reason(path)))
                continue
            try:
                data = json.loads(content.decode("utf-8"))
            except (ValueError, RecursionError):
                data = None
            if isinstance(data, dict):
                loaded.append((path.stem, data))
            else:
                skipped.append(skip_entry(path.name, "JSON の辞書でない"))
    finally:
        if dir_fd is not None:
            os.close(dir_fd)

    return loaded, skipped


def load_checked_evaluations(
    run_dir: Path, files: list[Path]
) -> tuple[list[tuple[str, dict[str, Any]]], list[str]]:
    """
    評価のファイルを読み, 形と名前の合うものだけを返す関数

    評価のタブと一覧で同じ評価を出すため, どちらもこの関数で読む

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    files: list[Path]
        evaluation_files が集めたファイル

    Returns
    ----------
    checked: list[tuple[str, dict[str, Any]]]
        ファイルの名前の順の, 評価の名前と中身
    skipped: list[str]
        出さないファイルの名前と理由
    """
    # 読めたファイルのうち, 形と名前の合うものだけ
    loaded, skipped = load_plain_evaluations(run_dir, files)
    folder = run_dir / EVALUATIONS_DIR
    checked: list[tuple[str, dict[str, Any]]] = []
    # 大文字と小文字だけが違う name は, 一覧に <name>.json が別にあれば
    # (区別する置き場のハードリンクなど) 同じとみなさない (2 回出さないため)
    names = {path.name for path in files}
    for stem, data in loaded:
        problem = evaluation_problem(folder, stem, data)
        if problem is None and data["name"] != stem and (
            f"{data['name']}.json" in names
        ):
            problem = "中の name がファイルの名前と違う"
        if problem is None:
            checked.append((stem, data))
        else:
            skipped.append(skip_entry(f"{stem}.json", problem))

    return checked, skipped


def read_evaluations(
    run_dir: Path, notices: list[str],
    outcomes: Optional[list[PolicyOutcome]] = None
) -> list[Evaluation]:
    """
    evaluations/ の評価を読む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    notices: list[str]
        読めなかったファイルの注意を足すリスト
    outcomes: Optional[list[PolicyOutcome]] = None
        守り付きの評価の割合を評価と同じ順で足すリスト, None の場合は
        数えない

    Returns
    ----------
    evaluations: list[Evaluation]
        守る指標を先にした評価
    """
    # evaluations/ がリンクなら注意, 形と名前の合う評価だけを守る指標を先に
    evaluations: list[Evaluation] = []
    found: list[tuple[tuple[bool, str], PolicyOutcome]] = []
    if (run_dir / EVALUATIONS_DIR).is_symlink():
        notices.append(EVALUATIONS_LINK_NOTICE)
    checked, skipped = load_checked_evaluations(
        run_dir, evaluation_files(run_dir)
    )
    for _, data in checked:
        evaluation = to_evaluation(data)
        if evaluation is None:
            continue
        evaluations.append(evaluation)
        outcome = to_policy_outcome(data) if outcomes is not None else None
        if outcome is not None:
            found.append((evaluation_order(evaluation), outcome))
    notice = skipped_notice(skipped)
    if notice is not None:
        notices.append(notice)
    evaluations.sort(key=evaluation_order)

    # 守り付きの評価の割合も評価と同じ順
    if outcomes is not None:
        found.sort(key=lambda item: item[0])
        outcomes.extend(outcome for _, outcome in found)

    return evaluations


def to_sample(run_dir: Path, item: Any) -> Optional[Sample]:
    """
    見本の一覧の項目を, 画面に返す形にする関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    item: Any
        samples/index.json の 1 項目

    Returns
    ----------
    sample: Optional[Sample]
        見本, 形が違うか samples/ の中のファイルが無い場合は None
    """
    # ファイルは他のファイルと同じ確かめ (.., シンボリックリンクを拒否) で
    # samples/ の中に限る
    data = dict_or_empty(item)
    name = text_or_none(data.get("name"))
    file = text_or_none(data.get("file"))
    if name is None or file is None:
        return None
    try:
        path = resolve_run_file(run_dir, f"{SAMPLES_DIR}/{file}")
    except RunNotFoundError:
        return None
    kind = data.get("kind")
    kind = kind if kind in SAMPLE_KINDS else "file"

    sample = Sample(
        name=name,
        epoch=int_or_none(data.get("epoch")),
        kind=kind,
        path=path.relative_to(run_dir).as_posix(),
        size=path.stat().st_size,
        split=text_or_none(data.get("split")),
        caption=text_or_none(data.get("caption")),
        created_at=text_or_none(data.get("created_at")),
        classes=(
            sample_classes(data.get("classes")) if kind == "mask" else None
        ),
        newer_version=data.get("newer_version") is True
    )

    return sample


def sample_classes(value: Any) -> Optional[list[SampleClass]]:
    """
    領域の見本の番号の表から, 凡例の行を取り出す関数

    Parameters
    ----------
    value: Any
        一覧の項目の classes

    Returns
    ----------
    classes: Optional[list[SampleClass]]
        番号の順の凡例の行 (形の違う行は除く). リストでなければ None
    """
    if not isinstance(value, list):
        return None
    classes = []
    for row in value:
        data = dict_or_empty(row)
        class_id = int_or_none(data.get("id"))
        color = text_or_none(data.get("color"))
        if class_id is None or color is None or not is_hex_color(color):
            continue
        classes.append(SampleClass(
            id=class_id, name=text_or_none(data.get("name")), color=color
        ))
    classes.sort(key=class_order)

    return classes


def is_hex_color(text: str) -> bool:
    """
    #rrggbb の形の色かを判定する関数

    Parameters
    ----------
    text: str
        色の文字

    Returns
    ----------
    valid: bool
        # の後に 16 進の 6 文字が続くか (画面の style にそのまま使うため)
    """
    valid = (
        len(text) == 7 and text[0] == "#"
        and all(char in "0123456789abcdefABCDEF" for char in text[1:])
    )

    return valid


def class_order(row: SampleClass) -> int:
    """
    凡例の行を並べる順を返す関数

    Parameters
    ----------
    row: SampleClass
        凡例の行

    Returns
    ----------
    order: int
        番号
    """
    order = row.id

    return order


def read_samples(run_dir: Path, notices: list[str]) -> list[Sample]:
    """
    samples/ の一覧を ML-Found の load_samples で読む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    notices: list[str]
        出せない見本の注意を足すリスト

    Returns
    ----------
    samples: list[Sample]
        一覧の見本 (書いた順). samples/ の直下の番号付きの画像は, 画像の推移で
        見るので含めない
    """
    from ml_found import load_samples
    from ml_found.experiment.results import read_samples_index

    samples: list[Sample] = []
    index = run_dir / SAMPLES_DIR / SAMPLES_INDEX
    if not has_samples_index(run_dir):
        return samples

    # load_samples は壊れた一覧を空として読むので, 先に一覧だけを確かめ
    try:
        read_samples_index(index)
        loaded = load_samples(run_dir)
    except Exception as error:
        notices.append(f"samples/index.json を読めませんでした: {error}")
        return samples
    items = [
        item for item in loaded
        if not (isinstance(item, dict) and item.get("legacy") is True)
    ]
    for item in items:
        sample = to_sample(run_dir, item)
        if sample is not None:
            samples.append(sample)
    skipped = len(items) - len(samples)
    if skipped > 0:
        notices.append(
            f"samples/index.json の {skipped} 個の見本は, ファイルが無いか "
            "samples/ の外を指すので出していません"
        )

    return samples


class DigestCache:
    def __init__(self) -> None:
        # 重みのパスごとの, ファイルの見分け (大きさ, 更新と変更の時刻,
        # inode) と sha256
        self.entries: dict[str, tuple[tuple[int, ...], str]] = {}
        self.lock = threading.Lock()

    def digest(self, path: Path) -> str:
        """
        ファイルの sha256 を, 同じファイルなら覚えた値で返す関数

        Parameters
        ----------
        path: Path
            重みのファイル

        Returns
        ----------
        digest: str
            16 進の小文字 64 文字
        """
        from ml_found.rl.bundle import file_sha256

        # 同じファイルなら, 大きな重みの読み直しは省略
        file_stat = path.stat()
        identity = (
            file_stat.st_size, file_stat.st_mtime_ns, file_stat.st_ctime_ns,
            file_stat.st_ino
        )
        key = str(path)
        with self.lock:
            found = self.entries.get(key)
        if found is not None and found[0] == identity:
            digest = found[1]
            return digest
        digest = str(file_sha256(path))
        with self.lock:
            self.entries[key] = (identity, digest)

        return digest


# プロセスの中で共有する, 重みの sha256
DIGEST_CACHE = DigestCache()


def read_policy(run_dir: Path) -> Optional[RunPolicy]:
    """
    方策の一式 (policy/policy.json) を ML-Found の read_policy_spec で読む関数

    守りを読み違えないように, 版と形を確かめられない一式は中身を出さず,
    読めない理由だけを返す. 重みは sha256 を確かめるだけで読み込まない

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    policy: Optional[RunPolicy]
        方策の一式, 無い実験は None
    """
    from ml_found.rl.bundle import read_policy_spec

    policy = None
    if not has_policy(run_dir):
        return policy
    folder = run_dir / POLICY_DIR
    try:
        spec = read_policy_spec(folder)
        guards = PolicyGuards.model_validate(spec["guards"])
        observation_space = PolicySpace.model_validate(
            spec["observation_space"]
        )
        action_space = PolicySpace.model_validate(spec["action_space"])
    except Exception as error:
        policy = RunPolicy(
            path=POLICY_DIR,
            error=f"{POLICY_SPEC} を読めません: {type(error).__name__}: "
            f"{error}"
        )
        return policy

    # 重みは一式の中の決まったファイル (read_policy_spec が確かめ済み)
    weights = folder / spec["weights"]
    status: Literal["match", "mismatch", "missing"] = "missing"
    size = None
    # 確かめの間に消えたか読めない重みは, 無いものとして扱い
    if is_plain_file(weights):
        try:
            size = weights.stat().st_size
            digest = DIGEST_CACHE.digest(weights)
        except OSError:
            size, digest = None, None
        if digest is not None:
            status = (
                "match" if digest == spec["weights_sha256"] else "mismatch"
            )
    policy = RunPolicy(
        path=POLICY_DIR,
        format_version=spec["format_version"],
        head=text_or_none(spec.get("head")),
        observation_space=observation_space,
        action_space=action_space,
        guards=guards,
        weights=spec["weights"],
        weights_sha256=spec["weights_sha256"],
        weights_status=status,
        weights_size=size,
        model_class=text_or_none(spec.get("model_class")),
        created_at=text_or_none(spec.get("created_at")),
        metadata=dict_or_empty(spec.get("metadata"))
    )

    return policy


def read_results(
    run_dir: Path, project: Project, store: ProjectStore
) -> RunResults:
    """
    実験の任意のファイル (task.yaml, evaluations/, samples/) を読む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    project: Project
        実験のプロジェクト
    store: ProjectStore
        登録したプロジェクト (元にした実験を探すため)

    Returns
    ----------
    results: RunResults
        何の実験か, 評価, 見本, 方策の一式, 守り付きの評価の割合.
        無い実験は空 (ML-Found を読み込まない)
    """
    # evaluations/ がリンクなだけの実験も, 評価の無い実験と見分けられる注意
    notices: list[str] = []
    if not has_results(run_dir):
        results = RunResults(
            notices=(
                [EVALUATIONS_LINK_NOTICE]
                if (run_dir / EVALUATIONS_DIR).is_symlink() else []
            )
        )
        return results

    # 持つ実験だけ ML-Found (と PyTorch) を読み込み. 読み込めない環境は注意
    try:
        import_ml_found()
    except Exception as error:
        results = RunResults(notices=[
            "ML-Found を読み込めないので, task.yaml, evaluations/, samples/, "
            f"policy/ を出せません: {type(error).__name__}: {error}"
        ])
        return results

    outcomes: list[PolicyOutcome] = []
    results = RunResults(
        task=read_task(run_dir, project, store, notices),
        evaluations=read_evaluations(run_dir, notices, outcomes),
        samples=read_samples(run_dir, notices),
        policy=read_policy(run_dir),
        policy_outcomes=outcomes,
        notices=notices
    )

    return results


class SampleCloudError(Exception):
    pass


def parse_ascii_ply(text: str) -> tuple[int, list[list[float]]]:
    """
    ascii の PLY の頂点の座標を, 間引いて読む関数

    Parameters
    ----------
    text: str
        PLY のファイルの中身

    Returns
    ----------
    cloud: tuple[int, list[list[float]]]
        頂点の数と, 間引いた (MAX_CLOUD_POINTS まで) x, y, z の並び
        (数でない値を持つ点は除く)

    Raises
    ----------
    SampleCloudError
        ascii の PLY でない場合, 頂点の要素が先頭に無い場合, x, y, z の
        どれかが無い場合, 読める点が無い場合
    """
    # 頭の部分 (形式, 頂点の数, 頂点の性質の名前)
    lines = text.splitlines()
    if not lines or lines[0].strip() != "ply":
        raise SampleCloudError("PLY のファイルではありません")
    form = ""
    vertices = -1
    in_vertex = False
    properties: list[str] = []
    header_end = -1
    for index, line in enumerate(lines[1:], start=1):
        words = line.split()
        if not words:
            continue
        if words[0] == "format":
            form = words[1] if len(words) > 1 else ""
        elif words[0] == "element":
            in_vertex = len(words) > 2 and words[1] == "vertex"
            if in_vertex:
                vertices = int(words[2]) if words[2].isdigit() else -1
            elif vertices < 0:
                raise SampleCloudError("頂点の要素が先頭にありません")
        elif words[0] == "property" and in_vertex:
            properties.append(words[-1])
        elif words[0] == "end_header":
            header_end = index
            break
    if form != "ascii" or header_end < 0:
        raise SampleCloudError("ascii の PLY ではありません")
    if vertices <= 0 or not {"x", "y", "z"} <= set(properties):
        raise SampleCloudError("頂点の x, y, z がありません")

    # 決まった間隔で間引いた頂点 (頂点の要素は先頭にある前提)
    columns = [properties.index(axis) for axis in ("x", "y", "z")]
    step = max(1, -(-vertices // MAX_CLOUD_POINTS))
    points = []
    for index in range(0, vertices, step):
        position = header_end + 1 + index
        if position >= len(lines):
            break
        words = lines[position].split()
        try:
            point = [float(words[column]) for column in columns]
        except (IndexError, ValueError):
            continue
        if all(math.isfinite(value) for value in point):
            points.append(point)
    if not points:
        raise SampleCloudError("読める頂点がありません")
    cloud = (vertices, points)

    return cloud


def find_cloud_item(run_dir: Path, relative: str) -> dict[str, Any]:
    """
    見本の一覧から, パスの合う点群の見本の項目を探す関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    relative: str
        実験のディレクトリからの相対パス (samples/<名前>/epoch_0005.ply)

    Returns
    ----------
    item: dict[str, Any]
        load_samples が返した項目 (convention と newer_version を持つ)

    Raises
    ----------
    RunNotFoundError
        一覧が無いか読めない場合と, パスの合う点群の見本が無い場合
    """
    from ml_found import load_samples

    if not has_samples_index(run_dir):
        raise RunNotFoundError("見本の一覧 (samples/index.json) がありません")
    for loaded in load_samples(run_dir):
        data = dict_or_empty(loaded)
        file = text_or_none(data.get("file"))
        if (
            data.get("legacy") is not True
            and data.get("kind") == "point_cloud"
            and f"{SAMPLES_DIR}/{file}" == relative
        ):
            return data
    raise RunNotFoundError(f"点群の見本が見つかりません: {relative}")


def read_sample_cloud(run_dir: Path, relative: str) -> SampleCloud:
    """
    点群の見本の点を, ファイルのままの座標と元の座標で返す関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    relative: str
        見本の一覧の点群の見本の, 実験のディレクトリからの相対パス

    Returns
    ----------
    cloud: SampleCloud
        間引いた点と, ML-Found の original_coordinates で値の決まりから
        戻した元の座標と単位

    Raises
    ----------
    RunNotFoundError
        一覧に無い見本と, samples/ の外かファイルの無い見本の場合
    SampleCloudError
        大きすぎるか, 読めない形の PLY の場合
    """
    # ML-Found は 1 つのスレッドから読み込み (初めて使う場合)
    import_ml_found()
    from ml_found import original_coordinates

    # 一覧の点群の見本だけを, 他のファイルと同じ確かめで読む
    item = find_cloud_item(run_dir, relative)
    path = resolve_run_file(run_dir, relative)
    size = path.stat().st_size
    if size > MAX_CLOUD_BYTES:
        raise SampleCloudError(
            f"点群のファイルが大きすぎます ({size} バイト. 上限は "
            f"{MAX_CLOUD_BYTES} バイト)"
        )
    text = path.read_bytes().decode("utf-8", errors="replace")
    vertices, points = parse_ascii_ply(text)

    # 値の決まりの単位と, 正規化 (scale か shift) を戻した元の座標.
    # 新しい版の一覧の項目は値の決まりを読まない
    convention = item.get("convention")
    given = dict_or_empty(convention)
    units = text_or_none(given.get("units"))
    original = None
    reason = None
    if item.get("newer_version") is True:
        reason = (
            "見本の一覧 (samples/index.json) の版が, この画面の ML-Found の"
            "知っている版より新しいので, 値の決まりを読まず, 元の座標に"
            "戻せません. ファイルのままの座標で出します"
        )
    elif "scale" in given or "shift" in given:
        try:
            original = original_coordinates(points, convention).tolist()
        except ValueError as error:
            reason = f"元の座標に戻せません: {error}"

    # 戻せない場合はファイルのまま (正規化した) 座標なので, 単位を付けない
    if reason is not None:
        units = None
    cloud = SampleCloud(
        vertices=vertices, points=points, original=original, units=units,
        reason=reason
    )

    return cloud
