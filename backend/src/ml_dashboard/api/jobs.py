import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ml_dashboard.api.routes import NOT_FOUND, get_project
from ml_dashboard.core.jobs import Job, JobManager
from ml_dashboard.core.models import Progress, RunSummary
from ml_dashboard.core.projects import (
    DEFAULT_CONFIG,
    EXPERIMENT_DIR,
    Project,
    ProjectError,
    get_output_dirs,
    list_experiment_configs,
    list_scripts,
)
from ml_dashboard.core.runs import (
    RunNotFoundError,
    read_progress,
    resolve_run_dir,
    summarize_run,
)

router = APIRouter(prefix="/api")

# config の大きさの上限 (誤って大きなファイルを送った場合の保護)
MAX_CONFIG_BYTES = 200_000


class ConfigText(BaseModel):
    path: str
    text: str


class ValidateRequest(BaseModel):
    text: str


class ValidateResult(BaseModel):
    ok: bool
    error: Optional[str]
    diff: dict[str, dict[str, object]]


class JobCreate(BaseModel):
    script: str
    config_path: Optional[str] = None
    config_text: Optional[str] = None


class StopRequest(BaseModel):
    force: bool = False


class JobInfo(BaseModel):
    id: str
    project_id: str
    project_name: Optional[str]
    script: str
    config: str
    created_at: str
    finished_at: Optional[str]
    status: Literal["running", "finished"]
    return_code: Optional[int]
    stop_requested: bool
    run_id: Optional[str]
    run: Optional[RunSummary]
    progress: Optional[Progress]


class JobOutput(BaseModel):
    text: str


def get_jobs(request: Request) -> JobManager:
    """
    アプリに保存したジョブの管理を取得する関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    jobs: JobManager
        ジョブの管理
    """
    jobs: JobManager = request.app.state.jobs

    return jobs


def resolve_config(project: Project, relative: str) -> Path:
    """
    プロジェクトの experiment の config のパスを確かめる関数

    Parameters
    ----------
    project: Project
        プロジェクト
    relative: str
        プロジェクトのディレクトリからの相対パス

    Returns
    ----------
    path: Path
        config のパス
    """
    # 一覧にある experiment の config だけを受け付け
    if relative not in list_experiment_configs(Path(project.path)):
        raise HTTPException(
            404, f"experiment の config が見つかりません: {relative}"
        )
    path = Path(project.path) / relative

    return path


def check_config(project: Project, path: Path) -> dict[str, dict[str, object]]:
    """
    ML-Found で config を読み込み, 学習を始める前の確認をする関数

    Parameters
    ----------
    project: Project
        プロジェクト
    path: Path
        experiment の config のパス

    Returns
    ----------
    diff: dict[str, dict[str, object]]
        default との差分
    """
    # ML-Found の読み込みは PyTorch も読むので, 使うときだけ読み込み
    from ml_found.config import load_config
    from ml_found.experiment.setup import check_trainer_config
    from ml_found.training.optim import check_optim_config

    cfg, diff = load_config(
        str(Path(project.path) / DEFAULT_CONFIG), str(path)
    )
    check_optim_config(cfg)
    check_trainer_config(cfg)
    result = {
        str(key): {
            "default": value.get("default"),
            "experiment": value.get("experiment")
        }
        for key, value in diff.items()
    }

    return result


def to_job_info(job: Job, project: Optional[Project]) -> JobInfo:
    """
    ジョブに実験の概要と進み具合を加える関数

    Parameters
    ----------
    job: Job
        ジョブ
    project: Optional[Project]
        ジョブのプロジェクト, 登録を外した場合は None

    Returns
    ----------
    info: JobInfo
        画面に返すジョブの情報
    """
    run = None
    progress = None
    if project is not None and job.run_id is not None:
        try:
            output_dirs = get_output_dirs(Path(project.path))
            run_dir = resolve_run_dir(output_dirs, job.run_id)
            run = summarize_run(run_dir.parent.parent.parent, run_dir)
            if job.status == "running":
                progress = read_progress(run_dir)
        except (ProjectError, RunNotFoundError):
            pass
    data = asdict(job)
    info = JobInfo(
        **data, project_name=project.name if project else None, run=run,
        progress=progress
    )

    return info


@router.get(
    "/projects/{project_id}/configs/{config_path:path}", responses=NOT_FOUND
)
def read_config(
    request: Request, project_id: str, config_path: str
) -> ConfigText:
    """
    プロジェクトの experiment の config の中身を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    config_path: str
        プロジェクトのディレクトリからの相対パス

    Returns
    ----------
    config: ConfigText
        パスと中身
    """
    path = resolve_config(get_project(request, project_id), config_path)
    config = ConfigText(
        path=config_path, text=path.read_text(encoding="utf-8")
    )

    return config


@router.post("/projects/{project_id}/validate", responses=NOT_FOUND)
def validate_config(
    request: Request, project_id: str, body: ValidateRequest
) -> ValidateResult:
    """
    書き換えた experiment の config を学習の前に確かめる関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: ValidateRequest
        experiment の config の中身

    Returns
    ----------
    result: ValidateResult
        読み込めたかどうか, エラー, default との差分
    """
    project = get_project(request, project_id)
    if len(body.text.encode()) > MAX_CONFIG_BYTES:
        raise HTTPException(400, "config が大きすぎます")

    # 一時ファイルに書いて, 学習と同じ方法で読み込み
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "experiment.yaml"
        path.write_text(body.text, encoding="utf-8")
        try:
            diff = check_config(project, path)
        except Exception as error:
            result = ValidateResult(
                ok=False, error=f"{type(error).__name__}: {error}", diff={}
            )
            return result

    result = ValidateResult(ok=True, error=None, diff=diff)

    return result


@router.post(
    "/projects/{project_id}/jobs", status_code=201, responses=NOT_FOUND
)
def create_job(
    request: Request, project_id: str, body: JobCreate
) -> JobInfo:
    """
    プロジェクトの学習を起動する関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: JobCreate
        学習のスクリプトと, experiment の config のパスか中身

    Returns
    ----------
    info: JobInfo
        起動したジョブ
    """
    project = get_project(request, project_id)
    if body.script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    jobs = get_jobs(request)
    job_id = jobs.create()

    # 中身はジョブのディレクトリに保存し, パスの場合はそのまま使用
    if body.config_text is not None:
        if len(body.config_text.encode()) > MAX_CONFIG_BYTES:
            raise HTTPException(400, "config が大きすぎます")
        config_path = jobs.job_dir(job_id) / "experiment.yaml"
        config_path.write_text(body.config_text, encoding="utf-8")
    else:
        config_path = resolve_config(
            project,
            body.config_path or (EXPERIMENT_DIR / "train.yaml").as_posix()
        )

    # 起動する前に ML-Found で config の誤りを確認
    try:
        check_config(project, config_path)
    except Exception as error:
        raise HTTPException(
            400, f"config に誤りがあります: {type(error).__name__}: {error}"
        ) from error

    job = jobs.start(job_id, project, body.script, config_path)
    info = to_job_info(job, project)

    return info


@router.get("/jobs")
def list_jobs(request: Request) -> list[JobInfo]:
    """
    ジョブの一覧を新しい順に返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    jobs: list[JobInfo]
        ジョブの一覧
    """
    projects = {
        project.id: project for project in request.app.state.store.load()
    }
    jobs = [
        to_job_info(job, projects.get(job.project_id))
        for job in get_jobs(request).list(projects)
    ]

    return jobs


def load_job(request: Request, job_id: str) -> tuple[Job, Optional[Project]]:
    """
    ジョブを読み込み, 状態を更新する関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID

    Returns
    ----------
    job: Job
        ジョブ
    project: Optional[Project]
        ジョブのプロジェクト
    """
    jobs = get_jobs(request)
    job = jobs.load(job_id)
    if job is None:
        raise HTTPException(404, f"ジョブが見つかりません: {job_id}")
    project = request.app.state.store.get(job.project_id)
    job = jobs.refresh(job, project)

    return job, project


@router.get("/jobs/{job_id}", responses=NOT_FOUND)
def get_job(request: Request, job_id: str) -> JobInfo:
    """
    ジョブの状態を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID

    Returns
    ----------
    info: JobInfo
        ジョブの情報
    """
    job, project = load_job(request, job_id)
    info = to_job_info(job, project)

    return info


@router.post("/jobs/{job_id}/stop", responses=NOT_FOUND)
def stop_job(request: Request, job_id: str, body: StopRequest) -> JobInfo:
    """
    ジョブの学習を止める関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID
    body: StopRequest
        エポックの区切りを待たずに止めるかどうか

    Returns
    ----------
    info: JobInfo
        更新したジョブ
    """
    job, project = load_job(request, job_id)
    job = get_jobs(request).stop(job, project, body.force)
    info = to_job_info(job, project)

    return info


@router.get("/jobs/{job_id}/output", responses=NOT_FOUND)
def get_output(request: Request, job_id: str) -> JobOutput:
    """
    ジョブの標準出力の末尾を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID

    Returns
    ----------
    output: JobOutput
        出力の末尾
    """
    job, _ = load_job(request, job_id)
    output = JobOutput(text=get_jobs(request).output_tail(job))

    return output
