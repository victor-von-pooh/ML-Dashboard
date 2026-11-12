from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ml_dashboard.core.models import (
    History,
    LogEntry,
    ProjectCandidate,
    ProjectDetail,
    ProjectInfo,
    RunDetail,
    RunParams,
    RunSummary,
)
from ml_dashboard.core.projects import (
    Project,
    ProjectError,
    ProjectStore,
    find_projects,
    get_output_dirs,
    list_experiment_configs,
    list_scripts,
)
from ml_dashboard.core.runs import (
    IMAGE_SUFFIXES,
    TEXT_SUFFIXES,
    RunData,
    RunNotFoundError,
    collect_params,
    find_run_dirs,
    make_run_id,
    resolve_run_dir,
    resolve_run_file,
    summarize_run,
)

router = APIRouter(prefix="/api")

# 実験の ID (<name>/<日付>/<時刻>) を 3 つの部分で受けるパス
RUN_PATH = "/projects/{project_id}/runs/{name}/{date}/{time}"

# 見つからない場合の応答の説明
NOT_FOUND: dict[int | str, dict[str, str]] = {
    404: {"description": "プロジェクトか実験が見つからない"}
}


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


def get_project_output_dirs(project: Project) -> list[Path]:
    """
    プロジェクトの出力先を取得し, ディレクトリが無ければ 404 にする関数

    Parameters
    ----------
    project: Project
        登録したプロジェクト

    Returns
    ----------
    output_dirs: list[Path]
        出力先の候補
    """
    try:
        output_dirs = get_output_dirs(Path(project.path))
    except ProjectError as error:
        raise HTTPException(404, str(error)) from error

    return output_dirs


def get_run_data(
    request: Request, project_id: str, name: str, date: str, time: str
) -> RunData:
    """
    パスから実験を読み込み, 無ければ 404 にする関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名

    Returns
    ----------
    data: RunData
        読み込んだ実験
    """
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    try:
        run_dir = resolve_run_dir(output_dirs, f"{name}/{date}/{time}")
    except RunNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    data = RunData(run_dir.parent.parent.parent, run_dir)

    return data


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
    # ディレクトリが消えているなど読めない場合も, 理由を付けて一覧には表示
    try:
        runs = find_run_dirs(get_output_dirs(Path(project.path)))
        error = None
    except (ProjectError, OSError) as caught:
        runs = []
        error = str(caught)
    latest = make_run_id(*runs[0]) if runs else None
    info = ProjectInfo(
        **project.__dict__, run_count=len(runs), latest_run=latest,
        error=error
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


@router.get("/projects/{project_id}", responses=NOT_FOUND)
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
    output_dirs = get_project_output_dirs(project)
    detail = ProjectDetail(
        **to_info(project).model_dump(),
        output_dirs=[str(path) for path in output_dirs],
        scripts=list_scripts(project_dir),
        experiment_configs=list_experiment_configs(project_dir)
    )

    return detail


@router.delete(
    "/projects/{project_id}", status_code=204, responses=NOT_FOUND
)
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


@router.get("/projects/{project_id}/runs", responses=NOT_FOUND)
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
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    runs = [
        summarize_run(output_dir, run_dir)
        for output_dir, run_dir in find_run_dirs(output_dirs)
    ]

    return runs


@router.get(RUN_PATH, responses=NOT_FOUND)
def get_run(
    request: Request, project_id: str, name: str, date: str, time: str
) -> RunDetail:
    """
    実験の詳細を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名

    Returns
    ----------
    detail: RunDetail
        実験の詳細
    """
    detail = get_run_data(request, project_id, name, date, time).detail()

    return detail


@router.get(RUN_PATH + "/history", responses=NOT_FOUND)
def get_history(
    request: Request, project_id: str, name: str, date: str, time: str
) -> History:
    """
    実験の指標の推移を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名

    Returns
    ----------
    history: History
        history.csv の中身, 無い場合はログから作り直したもの
    """
    history = get_run_data(request, project_id, name, date, time).history

    return history


@router.get(RUN_PATH + "/log", responses=NOT_FOUND)
def get_log(
    request: Request, project_id: str, name: str, date: str, time: str
) -> list[LogEntry]:
    """
    実験のログを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名

    Returns
    ----------
    entries: list[LogEntry]
        train.log の記録
    """
    entries = get_run_data(request, project_id, name, date, time).entries

    return entries


@router.get(
    RUN_PATH + "/files/{file_path:path}", response_class=FileResponse,
    responses=NOT_FOUND
)
def get_file(
    request: Request, project_id: str, name: str, date: str, time: str,
    file_path: str
) -> FileResponse:
    """
    実験のディレクトリの中のファイルを返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    name: str
        実験の名前
    date: str
        日付のディレクトリ名
    time: str
        時刻のディレクトリ名
    file_path: str
        実験のディレクトリからの相対パス

    Returns
    ----------
    response: FileResponse
        ファイルの中身
    """
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    try:
        run_dir = resolve_run_dir(output_dirs, f"{name}/{date}/{time}")
        path = resolve_run_file(run_dir, file_path)
    except RunNotFoundError as error:
        raise HTTPException(404, str(error)) from error

    # 実験のファイルの中のスクリプトが API を呼べないように,
    # 画像はそのまま, 文字のファイルは text/plain, それ以外は保存させる形で返却
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'"
    }
    suffix = path.suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        response = FileResponse(path, headers=headers)
        return response
    if suffix in TEXT_SUFFIXES:
        response = FileResponse(
            path, headers=headers, media_type="text/plain; charset=utf-8"
        )
        return response

    response = FileResponse(
        path, headers=headers, filename=path.name,
        media_type="application/octet-stream"
    )

    return response


@router.get("/projects/{project_id}/params", responses=NOT_FOUND)
def list_params(request: Request, project_id: str) -> list[RunParams]:
    """
    プロジェクトの実験の config と結果を分析用に返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    params: list[RunParams]
        実験ごとの平らな config と結果, 読めない実験は除外
    """
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    params = [
        item for item in (
            collect_params(output_dir, run_dir)
            for output_dir, run_dir in find_run_dirs(output_dirs)
        )
        if item is not None
    ]

    return params
