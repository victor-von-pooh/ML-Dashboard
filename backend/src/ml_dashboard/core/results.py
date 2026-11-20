import json
import math
import threading
from pathlib import Path
from typing import Any, Literal, Optional

from ml_dashboard.core.loader import import_ml_found
from ml_dashboard.core.models import (
    CellValue,
    Evaluation,
    PolicyGuards,
    PolicySpace,
    RunLink,
    RunPolicy,
    RunResults,
    RunTask,
    Sample,
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

# 評価の種類 (曲線は横軸の列がある場合だけ)
EVALUATION_KINDS = ("table", "curve")

# 見本の種類 (知らない種類はその他のファイルとして扱う)
SAMPLE_KINDS = ("image", "text", "audio", "point_cloud", "file")

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
    name = text_or_none(data.get("name"))
    columns = data.get("columns")
    rows = data.get("rows")
    if (
        name is None or not isinstance(columns, list)
        or not all(isinstance(column, str) for column in columns)
        or not isinstance(rows, list)
        or not all(isinstance(row, dict) for row in rows)
    ):
        return None

    # 曲線は横軸の列がある場合だけ, それ以外は表として出す
    x = text_or_none(data.get("x"))
    kind = data.get("kind")
    if kind != "curve" or x not in columns:
        kind = "table"
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
        epoch=int_or_none(data.get("epoch")),
        created_at=text_or_none(data.get("created_at")),
        total_rows=len(rows)
    )

    return evaluation


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


def read_evaluations(run_dir: Path, notices: list[str]) -> list[Evaluation]:
    """
    evaluations/ を ML-Found の load_evaluations で読む関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ
    notices: list[str]
        読めなかったファイルの注意を足すリスト

    Returns
    ----------
    evaluations: list[Evaluation]
        守る指標を先にした評価
    """
    from ml_found.experiment.results import load_evaluations

    evaluations: list[Evaluation] = []
    folder = run_dir / EVALUATIONS_DIR
    if not is_plain_dir(folder):
        return evaluations

    # 一時ファイル (. で始まる) を除いたファイル. シンボリックリンクの
    # ファイル (実験のディレクトリの外を指しうる) の名前は出さない
    files = [
        path for path in folder.glob("*.json")
        if not path.name.startswith(".")
        and (path.is_symlink() or path.is_file())
    ]
    linked = {path.stem for path in files if path.is_symlink()}
    try:
        loaded = load_evaluations(run_dir)
    except Exception as error:
        notices.append(f"evaluations/ を読めませんでした: {error}")
        return evaluations
    for data in loaded:
        evaluation = to_evaluation(data)
        if evaluation is not None and evaluation.name not in linked:
            evaluations.append(evaluation)
    skipped = len(files) - len(evaluations)
    if skipped > 0:
        notices.append(
            f"evaluations/ の {skipped} 個のファイルは形が違うので"
            "出していません"
        )
    evaluations.sort(key=evaluation_order)

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

    sample = Sample(
        name=name,
        epoch=int_or_none(data.get("epoch")),
        kind=kind if kind in SAMPLE_KINDS else "file",
        path=path.relative_to(run_dir).as_posix(),
        size=path.stat().st_size,
        split=text_or_none(data.get("split")),
        caption=text_or_none(data.get("caption")),
        created_at=text_or_none(data.get("created_at"))
    )

    return sample


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
    from ml_found.experiment.results import load_samples, read_samples_index

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
        stat = path.stat()
        identity = (
            stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino
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
        何の実験か, 評価, 見本. 無い実験は空 (ML-Found を読み込まない)
    """
    notices: list[str] = []
    if not has_results(run_dir):
        results = RunResults()
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

    results = RunResults(
        task=read_task(run_dir, project, store, notices),
        evaluations=read_evaluations(run_dir, notices),
        samples=read_samples(run_dir, notices),
        policy=read_policy(run_dir),
        notices=notices
    )

    return results
