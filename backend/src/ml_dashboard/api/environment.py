from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ml_dashboard.api.routes import NOT_FOUND, get_project
from ml_dashboard.core.environment import EnvironmentJobs, check_readiness
from ml_dashboard.core.models import EnvironmentJob, ProjectReadiness

router = APIRouter(prefix="/api")

# 環境のジョブを始められない場合の応答
CONFLICT: dict[int | str, dict[str, str]] = {
    400: {"description": "入れるものが無い"},
    409: {"description": "動いているか, 確かめた後に変わった"}
}


class EnvironmentRequest(BaseModel):
    # 利用者が画面で確かめたコマンド (学習の準備の commands と同じもの)
    commands: list[list[str]]


def get_environment_jobs(request: Request) -> EnvironmentJobs:
    """
    アプリの環境のジョブの管理を取り出す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    jobs: EnvironmentJobs
        環境のジョブの管理
    """
    jobs: EnvironmentJobs = request.app.state.environments

    return jobs


@router.get("/projects/{project_id}/readiness", responses=NOT_FOUND)
def read_readiness(
    request: Request, project_id: str, refresh: bool = False
) -> ProjectReadiness:
    """
    プロジェクトの学習の準備 (データセット, モデルの定義, 環境) を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    refresh: bool = False
        覚えた確かめの結果を使わずに確かめ直す場合は True

    Returns
    ----------
    readiness: ProjectReadiness
        確かめた結果, 入れるコマンド, 最後の環境のジョブ
    """
    project = get_project(request, project_id)
    readiness = check_readiness(project, refresh=refresh)
    readiness.job = get_environment_jobs(request).get(project.id)

    return readiness


@router.get("/projects/{project_id}/environment", responses=NOT_FOUND)
def read_environment_job(
    request: Request, project_id: str
) -> Optional[EnvironmentJob]:
    """
    プロジェクトの最後の環境のジョブと出力の末尾を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    job: Optional[EnvironmentJob]
        ジョブ, 無い場合は null
    """
    project = get_project(request, project_id)
    job = get_environment_jobs(request).get(project.id)

    return job


@router.post(
    "/projects/{project_id}/environment", status_code=201,
    responses=NOT_FOUND | CONFLICT
)
def start_environment_job(
    request: Request, project_id: str, body: EnvironmentRequest
) -> EnvironmentJob:
    """
    プロジェクトの .venv を作るか, 足りないものを入れるジョブを始める関数

    画面で利用者が確かめたコマンドが, 今の確かめの結果と同じ場合だけ
    動かす (確かめた内容と違うものを入れないため)

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: EnvironmentRequest
        利用者が確かめたコマンド

    Returns
    ----------
    job: EnvironmentJob
        始めたジョブ
    """
    project = get_project(request, project_id)
    try:
        job = get_environment_jobs(request).start(project, body.commands)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except (RuntimeError, LookupError) as error:
        raise HTTPException(409, str(error)) from error

    return job
