from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ml_dashboard.core.logs import parse_log
from ml_dashboard.core.models import (
    History,
    LogEntry,
    ProjectCandidate,
    ProjectDetail,
    ProjectInfo,
    RunDetail,
    RunSummary,
)
from ml_dashboard.core.projects import (
    Project,
    ProjectStore,
    find_projects,
    is_project_dir,
    list_experiment_configs,
    list_scripts,
    read_output_dir,
)
from ml_dashboard.core.runs import (
    detail_run,
    find_run_dirs,
    read_history,
    resolve_run_dir,
    resolve_run_file,
    summarize_run,
)

router = APIRouter(prefix="/api")


class ProjectCreate(BaseModel):
    path: str
    name: Optional[str] = None
    python: Optional[str] = None


class ScanRequest(BaseModel):
    path: str


def get_store(request: Request) -> ProjectStore:
    """
    アプリに保存したプロジェクトの登録簿を取得する関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    store: ProjectStore
        プロジェクトの登録簿
    """
    store: ProjectStore = request.app.state.store

    return store


def get_project(request: Request, project_id: str) -> Project:
    """
    ID からプロジェクトを取得し, 無ければ 404 にする関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    project: Project
        登録したプロジェクト
    """
    project = get_store(request).get(project_id)
    if project is None:
        raise HTTPException(404, f"プロジェクトが見つかりません: {project_id}")

    return project


def get_run_dir(project: Project, run_id: str) -> tuple[Path, Path]:
    """
    実験のディレクトリを取得し, 無ければ 404 にする関数

    Parameters
    ----------
    project: Project
        登録したプロジェクト
    run_id: str
        実験の ID

    Returns
    ----------
    output_dir: Path
        プロジェクトの出力先
    run_dir: Path
        実験のディレクトリ
    """
    output_dir = read_output_dir(Path(project.path))
    try:
        run_dir = resolve_run_dir(output_dir, run_id)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error

    return output_dir, run_dir


def to_info(project: Project) -> ProjectInfo:
    """
    プロジェクトに実験の数と最新の実験を加える関数

    Parameters
    ----------
    project: Project
        登録したプロジェクト

    Returns
    ----------
    info: ProjectInfo
        一覧に表示するプロジェクトの情報
    """
    # ディレクトリが消えている場合も一覧には出す
    project_dir = Path(project.path)
    run_dirs = (
        find_run_dirs(read_output_dir(project_dir))
        if is_project_dir(project_dir) else []
    )
    latest = None
    if run_dirs:
        latest = f"{run_dirs[0].parent.name} {run_dirs[0].name}"
    info = ProjectInfo(
        **project.__dict__, run_count=len(run_dirs), latest_run=latest
    )

    return info


@router.get("/projects")
def list_projects(request: Request) -> list[ProjectInfo]:
    """
    登録したプロジェクトの一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    projects: list[ProjectInfo]
        プロジェクトの一覧
    """
    projects = [to_info(project) for project in get_store(request).load()]

    return projects


@router.post("/projects", status_code=201)
def create_project(request: Request, body: ProjectCreate) -> ProjectInfo:
    """
    プロジェクトを登録する関数

    Parameters
    ----------
    request: Request
        リクエスト
    body: ProjectCreate
        プロジェクトのディレクトリ, 名前, Python

    Returns
    ----------
    info: ProjectInfo
        登録したプロジェクト
    """
    try:
        project = get_store(request).add(body.path, body.name, body.python)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    info = to_info(project)

    return info


@router.post("/projects/scan")
def scan_projects(
    request: Request, body: ScanRequest
) -> list[ProjectCandidate]:
    """
    ディレクトリの下の ML-Found のプロジェクトを探す関数

    Parameters
    ----------
    request: Request
        リクエスト
    body: ScanRequest
        探し始めるディレクトリ

    Returns
    ----------
    candidates: list[ProjectCandidate]
        見つけたプロジェクトと, 登録済みかどうか
    """
    root = Path(body.path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(400, f"ディレクトリが見つかりません: {root}")

    registered = {project.path for project in get_store(request).load()}
    candidates = [
        ProjectCandidate(
            path=str(path), name=path.name,
            registered=str(path) in registered
        )
        for path in find_projects(root)
    ]

    return candidates


@router.get("/projects/{project_id}")
def read_project(request: Request, project_id: str) -> ProjectDetail:
    """
    プロジェクトの詳細を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    detail: ProjectDetail
        出力先, 学習のスクリプト, experiment の config を加えた情報
    """
    project = get_project(request, project_id)
    project_dir = Path(project.path)
    if not is_project_dir(project_dir):
        raise HTTPException(
            404, f"プロジェクトのディレクトリが見つかりません: {project_dir}"
        )

    detail = ProjectDetail(
        **to_info(project).model_dump(),
        output_dir=str(read_output_dir(project_dir)),
        scripts=list_scripts(project_dir),
        experiment_configs=list_experiment_configs(project_dir)
    )

    return detail


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(request: Request, project_id: str) -> None:
    """
    プロジェクトの登録を外す関数, 実験のファイルは消さない

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    None
    """
    if not get_store(request).remove(project_id):
        raise HTTPException(404, f"プロジェクトが見つかりません: {project_id}")


@router.get("/projects/{project_id}/runs")
def list_runs(request: Request, project_id: str) -> list[RunSummary]:
    """
    プロジェクトの実験の一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    runs: list[RunSummary]
        実験の概要, 新しい順
    """
    project = get_project(request, project_id)
    output_dir = read_output_dir(Path(project.path))
    runs = [
        summarize_run(output_dir, run_dir)
        for run_dir in find_run_dirs(output_dir)
    ]

    return runs


@router.get("/projects/{project_id}/runs/{run_id:path}/history")
def get_history(request: Request, project_id: str, run_id: str) -> History:
    """
    実験の指標の推移を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    run_id: str
        実験の ID

    Returns
    ----------
    history: History
        history.csv の中身
    """
    _, run_dir = get_run_dir(get_project(request, project_id), run_id)
    history = read_history(run_dir)

    return history


@router.get("/projects/{project_id}/runs/{run_id:path}/log")
def get_log(request: Request, project_id: str, run_id: str) -> list[LogEntry]:
    """
    実験のログを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    run_id: str
        実験の ID

    Returns
    ----------
    entries: list[LogEntry]
        train.log の記録
    """
    _, run_dir = get_run_dir(get_project(request, project_id), run_id)
    entries = parse_log(run_dir / "train.log")

    return entries


@router.get("/projects/{project_id}/runs/{run_id:path}/files/{file_path:path}")
def get_file(
    request: Request, project_id: str, run_id: str, file_path: str
) -> FileResponse:
    """
    実験のディレクトリの中のファイルを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    run_id: str
        実験の ID
    file_path: str
        実験のディレクトリからの相対パス

    Returns
    ----------
    response: FileResponse
        ファイルの中身
    """
    _, run_dir = get_run_dir(get_project(request, project_id), run_id)
    try:
        path = resolve_run_file(run_dir, file_path)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    response = FileResponse(path)

    return response


@router.get("/projects/{project_id}/runs/{run_id:path}")
def get_run(request: Request, project_id: str, run_id: str) -> RunDetail:
    """
    実験の詳細を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    run_id: str
        実験の ID

    Returns
    ----------
    detail: RunDetail
        実験の詳細
    """
    output_dir, run_dir = get_run_dir(
        get_project(request, project_id), run_id
    )
    detail = detail_run(output_dir, run_dir)

    return detail

