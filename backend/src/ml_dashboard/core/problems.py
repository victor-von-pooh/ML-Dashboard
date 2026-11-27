"""
ML-Pathfinder の置き場の問題の設定から, 書き出した学習のプロジェクトの
場所と, 学習で監視する指標と向きを読む

書き出したプロジェクトの一覧は ML-Quest に依らずに出すので, 記録の
`project.path` と名前だけを読む. 知らない新しい版は読まずに理由を返す.
監視する指標と向きは, 任意の依存の ML-Quest の受け渡し (`handoff`) から
受け取る (値の求め方は ML-Quest の約束のため)
"""

from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

import yaml

from ml_dashboard.core.models import (
    ProblemProject,
    ProblemTraining,
    ProblemTrainings,
    RecordedProject,
    RecordedProjects,
)
from ml_dashboard.core.projects import is_project_dir

# 問題の設定のファイルの名前 (problems/<識別子>/problem.yaml)
PROBLEM_FILE = "problem.yaml"

# 読める問題の設定の最も新しい版 (ML-Quest の FORMAT_VERSION)
PROBLEM_VERSION = 2


def modified_at(path: Path) -> Optional[str]:
    """
    ファイルの更新時刻を ISO 8601 の文字にする関数

    Parameters
    ----------
    path: Path
        ファイル

    Returns
    ----------
    stamp: Optional[str]
        手元の時刻帯の更新時刻 (読めなければ None)
    """
    # 一覧の並べ替えと表示の時刻 (ML-Fathom の一覧と同じ)
    try:
        moment = datetime.fromtimestamp(path.stat().st_mtime)
    except OSError:
        stamp = None
        return stamp
    stamp = moment.astimezone().isoformat(timespec="seconds")

    return stamp


def read_record(path: Path) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """
    問題の設定を読み, 名前とプロジェクトの記録を取り出す関数

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    record: Optional[dict[str, Any]]
        name と project_path (記録の無いもの, 読めないものは None)
    skipped: Optional[str]
        知らない新しい版で読まなかった理由 (無ければ None)
    """
    # 読めないファイルと問題の設定でないものは黙って除く (プロジェクトの
    # 記録ではないため)
    record = None
    try:
        problem = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError):
        return record, None
    if not isinstance(problem, dict):
        return record, None
    version = problem.get("format_version")
    if not isinstance(version, int) or isinstance(version, bool):
        return record, None

    # 知らない新しい版は読み違えないように読まず, 理由を返す
    if version > PROBLEM_VERSION:
        skipped = (
            f"{path} は新しい版 (format_version {version}) の問題の設定"
            "なので読みません. ML-Dashboard を新しくしてください"
        )
        return record, skipped

    # 記録は絶対パスの文字だけ (ML-Quest の handoff と同じ)
    project = problem.get("project")
    value = project.get("path") if isinstance(project, dict) else None
    if not isinstance(value, str) or not Path(value).is_absolute():
        return record, None
    name = problem.get("name")
    record = {
        "name": name if isinstance(name, str) else path.parent.name,
        "project_path": value
    }

    return record, None


def updated_of(project: RecordedProject | ProblemTraining) -> str:
    """
    一覧の 1 件の更新時刻を, 並べ替えの鍵にする関数

    Parameters
    ----------
    project: RecordedProject | ProblemTraining
        一覧の 1 件

    Returns
    ----------
    key: str
        更新時刻の文字 (無ければ空)
    """
    # 時刻の無いものは後ろ
    key = project.updated_at or ""

    return key


def recorded_projects(root: Path, registered: set[str]) -> RecordedProjects:
    """
    問題の設定に記録された, 登録していない学習のプロジェクトを集める関数

    Parameters
    ----------
    root: Path
        ML-Pathfinder の置き場の problems
    registered: set[str]
        登録したプロジェクトのディレクトリ

    Returns
    ----------
    result: RecordedProjects
        今もあり, default の config を持ち, 登録していないプロジェクト
        (同じ場所は更新の新しい問題の設定の 1 件), 読まなかった理由,
        置き場を読めない理由
    """
    # problems/<識別子>/problem.yaml (置き場が無ければ空)
    files, error = problem_files(root)

    # 記録の場所をたどった先が, 今ある登録していないプロジェクトのもの
    found: list[RecordedProject] = []
    skipped: list[str] = []
    for file in files:
        record, reason = read_record(file)
        if reason is not None:
            skipped.append(reason)
        if record is None:
            continue
        try:
            place = Path(record["project_path"]).resolve()
            usable = place.is_dir() and is_project_dir(place)
        except (OSError, RuntimeError):
            continue
        if not usable or str(place) in registered:
            continue
        found.append(RecordedProject(
            path=str(place), name=place.name, problem=record["name"],
            problem_path=str(file), updated_at=modified_at(file)
        ))

    # 新しい順にし, 同じ場所は最初の 1 件だけ
    found.sort(key=updated_of, reverse=True)
    seen: set[str] = set()
    projects: list[RecordedProject] = []
    for project in found:
        if project.path not in seen:
            seen.add(project.path)
            projects.append(project)
    result = RecordedProjects(
        root=str(root), projects=projects, skipped=skipped, error=error
    )

    return result


def unrecorded_problem(path: Path) -> tuple[str, str]:
    """
    プロジェクトの記録を読めなかった問題の設定の名前と理由を決める関数

    Parameters
    ----------
    path: Path
        problem.yaml

    Returns
    ----------
    name: str
        問題の設定の名前 (読めないか書いていなければディレクトリの名前)
    reason: str
        読めない (壊れた, 問題の設定でない) か, 記録が無いかの理由
    """
    # 読めないものと記録の無いものとで, 次の一手が違うため分ける
    name = path.parent.name
    try:
        problem = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        reason = f"{path} を読めません: {error}"
        return name, reason
    if not isinstance(problem, dict):
        reason = f"{path} は問題の設定の形ではありません"
        return name, reason
    title = problem.get("name")
    if isinstance(title, str) and title:
        name = title
    version = problem.get("format_version")
    if not isinstance(version, int) or isinstance(version, bool):
        reason = f"{path} は問題の設定の形ではありません"
        return name, reason
    reason = (
        "プロジェクトの記録がありません. ML-Pathfinder で学習の"
        "プロジェクトを書き出してください"
    )

    return name, reason


def problem_project(
    root: Path, problem_id: str, registered: dict[str, str]
) -> Optional[ProblemProject]:
    """
    識別子の問題の設定 1 件を読み, 記録した学習のプロジェクトと対応させる
    関数

    Parameters
    ----------
    root: Path
        ML-Pathfinder の置き場の problems
    problem_id: str
        問題の設定の識別子 (problems の直下のディレクトリの名前)
    registered: dict[str, str]
        登録したプロジェクトのディレクトリから登録の ID への対応

    Returns
    ----------
    result: Optional[ProblemProject]
        問題の設定と記録したプロジェクトの対応, 開けない理由 (置き場に
        無い識別子は None)
    """
    # 直下のディレクトリの名前 1 つだけ (置き場の外を読まないため)
    result = None
    if problem_id in ("", ".", "..") or any(
        mark in problem_id for mark in ("/", "\\", "\0")
    ):
        return result
    # 置き場の外を指すリンクも読まない (一覧と違い, 外から識別子を受け取るため)
    folder = root / problem_id
    path = folder / PROBLEM_FILE
    try:
        inside = folder.resolve().parent == root.resolve()
        if not inside or not path.is_file():
            return result
    except (OSError, RuntimeError):
        return result

    # 記録の無いもの, 読めないもの, 新しい版は理由だけを返す
    record, skipped = read_record(path)
    if record is None:
        name, reason = unrecorded_problem(path)
        result = ProblemProject(
            id=problem_id, problem=name, problem_path=str(path),
            reason=skipped or reason
        )
        return result

    # 記録の場所が今あり, ML-Found のプロジェクトのときだけ開ける
    name = record["name"]
    try:
        place = Path(record["project_path"]).resolve()
        usable = place.is_dir() and is_project_dir(place)
    except (OSError, RuntimeError):
        place, usable = Path(record["project_path"]), False
    if not usable:
        result = ProblemProject(
            id=problem_id, problem=name, problem_path=str(path),
            reason=(
                f"記録したプロジェクト {place} が無いか, ML-Found の"
                "プロジェクト (configs/default/train.yaml を持つもの) では"
                "ありません"
            )
        )
        return result
    result = ProblemProject(
        id=problem_id, problem=name, problem_path=str(path),
        project_path=str(place), project_id=registered.get(str(place))
    )

    return result


def problem_files(root: Path) -> tuple[list[Path], Optional[str]]:
    """
    置き場の problems の下の問題の設定のファイルを集める関数

    Parameters
    ----------
    root: Path
        ML-Pathfinder の置き場の problems

    Returns
    ----------
    files: list[Path]
        problems/<識別子>/problem.yaml (置き場が無ければ空)
    error: Optional[str]
        置き場を読めない理由 (読めれば None)
    """
    # 識別子の順. 置き場が無いのは問題の設定がまだ無いだけ
    files: list[Path] = []
    error = None
    try:
        if root.is_dir():
            files = [
                child / PROBLEM_FILE for child in sorted(root.iterdir())
                if (child / PROBLEM_FILE).is_file()
            ]
    except OSError as failure:
        error = f"{root} を読めません: {failure}"

    return files, error


def resolved_path(value: str) -> str:
    """
    記録の場所を, ホームを展開してリンクを辿った場所にする関数

    Parameters
    ----------
    value: str
        記録の場所

    Returns
    ----------
    path: str
        辿った場所 (辿れなければ書いたまま)
    """
    # 登録したプロジェクトの場所 (expanduser と resolve) と同じ形
    try:
        path = str(Path(value).expanduser().resolve())
    except (OSError, RuntimeError):
        path = value

    return path


def training_of(path: Path, quest: ModuleType) -> ProblemTraining:
    """
    問題の設定 1 件の, 学習で監視する指標と向きを ML-Quest で求める関数

    Parameters
    ----------
    path: Path
        problem.yaml
    quest: ModuleType
        ML-Quest のモジュール (load_problem と handoff を持つもの)

    Returns
    ----------
    training: ProblemTraining
        監視する指標と向き. 渡せない場合は理由 (読めない, 渡せる答えが
        そろっていない, 既製のモデルをそのまま使うなど)
    """
    # 読み方, 版の移し方, 渡せるかの確かめは ML-Quest に任せる. 読めない
    # 場合の名前はディレクトリの名前
    updated_at = modified_at(path)
    try:
        problem = quest.load_problem(path)
    except Exception as error:
        training = ProblemTraining(
            problem=path.parent.name, problem_path=str(path),
            reason=f"読めません: {error}", updated_at=updated_at
        )
        return training
    name = problem.get("name") if isinstance(problem, dict) else None
    title = name if isinstance(name, str) and name else path.parent.name
    try:
        stages = quest.handoff(problem)
    except Exception as error:
        training = ProblemTraining(
            problem=title, problem_path=str(path),
            reason=f"後ろの段階に渡せません: {error}", updated_at=updated_at
        )
        return training

    # 記録したプロジェクトの場所 (記録が無ければ None). 登録したプロジェクト
    # と同じく, リンクを辿った場所にして比べられるようにする
    project = stages.get("project") if isinstance(stages, dict) else None
    recorded = project.get("path") if isinstance(project, dict) else None
    project_path = resolved_path(recorded) if isinstance(
        recorded, str
    ) else None

    # 既製のモデルをそのまま使う (学習しない) 問題の設定は値が None
    values = stages.get("training") if isinstance(stages, dict) else None
    monitor = values.get("monitor") if isinstance(values, dict) else None
    mode = values.get("mode") if isinstance(values, dict) else None
    if monitor is None:
        reason = (
            "学習しない (既製のモデルをそのまま使う) 問題の設定なので, "
            "監視する指標がありません"
        )
        training = ProblemTraining(
            problem=title, problem_path=str(path), project_path=project_path,
            reason=reason, updated_at=updated_at
        )
        return training
    if not isinstance(monitor, str) or mode not in ("min", "max"):
        training = ProblemTraining(
            problem=title, problem_path=str(path), project_path=project_path,
            reason=(
                f"監視する指標か向きの形が違います ({monitor!r}, {mode!r}). "
                "ML-Quest の版を確かめてください"
            ),
            updated_at=updated_at
        )
        return training
    training = ProblemTraining(
        problem=title, problem_path=str(path), project_path=project_path,
        monitor=monitor, mode=mode, updated_at=updated_at
    )

    return training


def problem_trainings(root: Path, quest: ModuleType) -> ProblemTrainings:
    """
    置き場の問題の設定ごとに, 学習で監視する指標と向きを集める関数

    Parameters
    ----------
    root: Path
        ML-Pathfinder の置き場の problems
    quest: ModuleType
        ML-Quest のモジュール

    Returns
    ----------
    result: ProblemTrainings
        問題の設定ごとの値か渡せない理由 (更新の新しい順), 置き場を読めない
        理由
    """
    # 渡せないものも理由と一緒に並べる (選べない理由が分かるように)
    files, error = problem_files(root)
    problems = [training_of(file, quest) for file in files]
    problems.sort(key=updated_of, reverse=True)
    result = ProblemTrainings(
        root=str(root), problems=problems, error=error
    )

    return result
