import importlib
from pathlib import Path
from types import ModuleType
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ml_dashboard.core.evaluation_summary import forget_missing_summaries
from ml_dashboard.core.model_candidates import describe_models, run_key
from ml_dashboard.core.models import (
    History,
    LogEntry,
    PolicyEstimate,
    ProblemProject,
    ProblemTrainings,
    ProjectCandidate,
    ProjectDetail,
    ProjectInfo,
    RecordedProjects,
    RunDetail,
    RunParams,
    RunResults,
    RunSummary,
    SampleCloud,
    TargetPolicy,
)
from ml_dashboard.core.policy_estimate import (
    PolicyEstimateError,
    estimate_trajectory,
)
from ml_dashboard.core.problems import (
    problem_project,
    problem_trainings,
    recorded_projects,
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
from ml_dashboard.core.results import (
    SampleCloudError,
    read_results,
    read_sample_cloud,
)
from ml_dashboard.core.runs import (
    AUDIO_SUFFIXES,
    IMAGE_SUFFIXES,
    TEXT_SUFFIXES,
    RunData,
    RunNotFoundError,
    collect_params,
    find_run_dirs,
    is_withheld_weights,
    make_run_id,
    read_source,
    resolve_run_dir,
    resolve_run_file,
    summarize_run,
)

router = APIRouter()

# 実験の ID (<name>/<日付>/<時刻>) を 3 つの部分で受けるパス
RUN_PATH = "/projects/{project_id}/runs/{name}/{date}/{time}"

# 任意の依存のライブラリの入れ方の案内
SETUP_HINT = "make setup (backend で uv sync --extra problem)"

# 任意の依存のライブラリの, 案内に出す名前
LIBRARY_NAMES = {"ml_quest": "ML-Quest"}

# 見つからない場合の応答の説明
NOT_FOUND: dict[int | str, dict[str, str]] = {
    404: {"description": "プロジェクトか実験が見つからない"}
}


class ProjectCreate(BaseModel):
    path: str
    name: Optional[str] = None
    python: Optional[str] = None


class ProjectMove(BaseModel):
    path: str


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
        raise HTTPException(
            404, f"プロジェクト {project_id} が見つかりません"
        )

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


@router.get("/problems/projects")
def list_recorded_projects(request: Request) -> RecordedProjects:
    """
    ML-Pathfinder の問題の設定に記録された, 登録していない学習の
    プロジェクトを返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    result: RecordedProjects
        今あり, default の config を持ち, 登録していないプロジェクト
        (更新の新しい順)
    """
    registered = {project.path for project in get_store(request).load()}
    problems_dir: Path = request.app.state.problems_dir
    result = recorded_projects(problems_dir, registered)

    return result


@router.get("/problems/{problem_id}/project", responses=NOT_FOUND)
def read_problem_project(request: Request, problem_id: str) -> ProblemProject:
    """
    識別子の問題の設定と, 記録した学習のプロジェクトとの対応を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    problem_id: str
        問題の設定の識別子 (置き場の problems の直下のディレクトリの名前)

    Returns
    ----------
    result: ProblemProject
        問題の設定の名前と場所, 記録したプロジェクトの場所と登録の ID,
        開けない理由

    Raises
    ----------
    HTTPException
        置き場に無い識別子は 404
    """
    # 殻で選んだ問題を, 登録したプロジェクトと対応させる
    registered = {
        project.path: project.id for project in get_store(request).load()
    }
    problems_dir: Path = request.app.state.problems_dir
    result = problem_project(problems_dir, problem_id, registered)
    if result is None:
        raise HTTPException(
            404, f"問題 {problem_id} が見つかりません"
        )

    return result


def load_library(name: str, attribute: str) -> ModuleType:
    """
    任意の依存のライブラリを読み込む関数

    Parameters
    ----------
    name: str
        モジュールの名前 (ml_quest)
    attribute: str
        使う関数の名前 (古い版で無い場合を見分けるため)

    Returns
    ----------
    module: ModuleType
        読み込んだモジュール

    Raises
    ----------
    HTTPException
        入っていない場合と, 使う関数の無い古い版の場合は 501
    """
    # 入っていなければ入れ方, 古ければ入れ直し方の案内
    label = LIBRARY_NAMES.get(name, name)
    try:
        module = importlib.import_module(name)
    except ImportError as error:
        raise HTTPException(
            501,
            f"{label} が入っていません. {SETUP_HINT} で入れてから起動し直して"
            "ください"
        ) from error
    if not hasattr(module, attribute):
        raise HTTPException(
            501,
            f"{label} が古く, {attribute} がありません. {SETUP_HINT} で入れ"
            "直してから起動し直してください"
        )

    return module


@router.get(
    "/problems/training",
    responses={501: {"description": "ML-Quest が入っていないか古い"}}
)
def list_problem_trainings(request: Request) -> ProblemTrainings:
    """
    ML-Pathfinder の問題の設定ごとの, 学習で監視する指標と向きを返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    result: ProblemTrainings
        問題の設定ごとの監視する指標と向きか, 渡せない理由 (更新の新しい
        順)
    """
    # 値は ML-Quest の受け渡しから受け取る (無ければ 501 で, 他の機能は
    # そのまま使える)
    quest = load_library("ml_quest", "handoff")
    problems_dir: Path = request.app.state.problems_dir
    result = problem_trainings(problems_dir, quest)

    return result


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


@router.patch("/projects/{project_id}", responses=NOT_FOUND)
def move_project(
    request: Request, project_id: str, body: ProjectMove
) -> ProjectInfo:
    """
    プロジェクトのディレクトリを付け替える関数 (メモとタグは残す)

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: ProjectMove
        新しいディレクトリ

    Returns
    ----------
    info: ProjectInfo
        付け替えたプロジェクト
    """
    # ディレクトリの誤りは 400, ID が無い場合は 404
    try:
        project = get_store(request).move(project_id, body.path)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if project is None:
        raise HTTPException(
            404, f"プロジェクト {project_id} が見つかりません"
        )
    info = to_info(project)

    return info


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
        raise HTTPException(
            404, f"プロジェクト {project_id} が見つかりません"
        )

    # 同じ ID を後から別のプロジェクトが使っても引き継がないようにメモも削除
    request.app.state.notes.remove(project_id)


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
    project = get_project(request, project_id)
    output_dirs = get_project_output_dirs(project)
    pairs = find_run_dirs(output_dirs)
    runs = [
        summarize_run(output_dir, run_dir) for output_dir, run_dir in pairs
    ]

    # 全ての実験の起動のしかたから, 使ったモデルの定義の名前
    models = describe_models(
        Path(project.path),
        {
            run_key(run_dir): run.source
            for (_, run_dir), run in zip(pairs, runs, strict=True)
        }
    )
    for (_, run_dir), run in zip(pairs, runs, strict=True):
        run.model = models.get(run_key(run_dir))

    # 消した実験の評価の覚えの破棄
    forget_missing_summaries()

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
    data = get_run_data(request, project_id, name, date, time)
    detail = data.detail()
    detail.path = str(data.run_dir)

    # モデルの定義の名前は, プロジェクトの全ての実験の source.yaml だけを
    # 読んで決定 (写しから起動し直した実験の元を辿るため)
    project = get_project(request, project_id)
    sources = {
        run_key(run_dir): read_source(run_dir)
        for _, run_dir in find_run_dirs(get_project_output_dirs(project))
    }
    sources[run_key(data.run_dir)] = detail.source
    detail.model = describe_models(Path(project.path), sources).get(
        run_key(data.run_dir)
    )

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


@router.get(RUN_PATH + "/results", responses=NOT_FOUND)
def get_results(
    request: Request, project_id: str, name: str, date: str, time: str
) -> RunResults:
    """
    実験の任意のファイル (task.yaml, evaluations/, samples/) を返す関数

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
    results: RunResults
        何の実験か, データ全体の評価, 見本. 無い実験は空
    """
    project = get_project(request, project_id)
    output_dirs = get_project_output_dirs(project)
    try:
        run_dir = resolve_run_dir(output_dirs, f"{name}/{date}/{time}")
    except RunNotFoundError as error:
        raise HTTPException(404, str(error)) from error

    results = read_results(run_dir, project, get_store(request))

    return results


@router.get(
    RUN_PATH + "/trajectories/{trajectory}/estimate",
    responses={
        **NOT_FOUND,
        422: {"description": "見積もれない軌跡 (理由の文)"}
    }
)
def get_policy_estimate(
    request: Request, project_id: str, name: str, date: str, time: str,
    trajectory: str, policy: TargetPolicy = "uniform",
    epsilon: float = Query(0.1, ge=0.0, le=1.0),
    gamma: float = Query(1.0, ge=0.0, le=1.0)
) -> PolicyEstimate:
    """
    記録した軌跡から, 決まった形の方策の良さを見積もる関数

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
    trajectory: str
        軌跡の名前 (trajectories/<名前>.csv)
    policy: TargetPolicy = "uniform"
        uniform (一様) か epsilon_greedy (記録で最も多い行動の ε-greedy)
    epsilon: float = Query(0.1, ge=0.0, le=1.0)
        ε-greedy の ε
    gamma: float = Query(1.0, ge=0.0, le=1.0)
        割引率

    Returns
    ----------
    estimate: PolicyEstimate
        ML-Found の estimate_policy_value の結果と, 見積もった方策
    """
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    try:
        run_dir = resolve_run_dir(output_dirs, f"{name}/{date}/{time}")
        estimate = estimate_trajectory(
            run_dir, trajectory, policy, epsilon, gamma
        )
    except RunNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    except PolicyEstimateError as error:
        raise HTTPException(422, str(error)) from error

    return estimate


@router.get(
    RUN_PATH + "/samples/cloud",
    responses={
        **NOT_FOUND,
        422: {"description": "読めない形か大きすぎる点群のファイル"}
    }
)
def get_sample_cloud(
    request: Request, project_id: str, name: str, date: str, time: str,
    path: str
) -> SampleCloud:
    """
    点群の見本の点を, ファイルのままの座標と元の座標で返す関数

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
    path: str
        見本の一覧の点群の見本の, 実験のディレクトリからの相対パス

    Returns
    ----------
    cloud: SampleCloud
        間引いた点, 元の座標, 単位, 元の座標に戻せない理由
    """
    output_dirs = get_project_output_dirs(get_project(request, project_id))
    try:
        run_dir = resolve_run_dir(output_dirs, f"{name}/{date}/{time}")
        cloud = read_sample_cloud(run_dir, path)
    except RunNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    except SampleCloudError as error:
        raise HTTPException(422, str(error)) from error

    return cloud


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

    # 方策の一式を持つ実験の重みは配らない (使ってよいかは画面の外で人が
    # 決めるため)
    if is_withheld_weights(run_dir, path):
        raise HTTPException(
            403, "方策の一式を持つ実験の重みはこの段階から配りません"
        )

    # 実験のファイルの中のスクリプトが API を呼べないように,
    # 画像と音はそのまま, 文字のファイルは text/plain, それ以外は保存させる
    # 形で返却
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'"
    }
    suffix = path.suffix.lower()
    if suffix in IMAGE_SUFFIXES or suffix in AUDIO_SUFFIXES:
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
