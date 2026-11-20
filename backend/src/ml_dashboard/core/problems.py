"""
ML-Pathfinder の置き場の問題の設定から, 書き出した学習のプロジェクトの
場所を読む

ダッシュボードは ML-Quest に依らないので, 問題の設定のうち記録の
`project.path` と名前だけを読む. 知らない新しい版は読まずに理由を返す
"""

from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import yaml

from ml_dashboard.core.models import RecordedProject, RecordedProjects
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


def updated_of(project: RecordedProject) -> str:
    """
    一覧の 1 件の更新時刻を, 並べ替えの鍵にする関数

    Parameters
    ----------
    project: RecordedProject
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
