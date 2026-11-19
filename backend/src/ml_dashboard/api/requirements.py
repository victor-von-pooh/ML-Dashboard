from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ml_dashboard.api.jobs import (
    BAD_REQUEST,
    MAX_CONFIG_BYTES,
    resolve_default,
)
from ml_dashboard.api.routes import NOT_FOUND, get_project
from ml_dashboard.core.models import RequirementReport, RequiresStatus
from ml_dashboard.core.projects import default_config_for, list_scripts
from ml_dashboard.core.requirements import (
    check_requirements,
    requires_from_text,
    requires_status,
)

router = APIRouter(prefix="/api")


class RequiresRequest(BaseModel):
    # experiment の config の中身
    text: str
    # 学習のスクリプト, 元にする default の config の選択に使用
    script: Optional[str] = None
    # 元にする default の config (configs/default の中の相対パス)
    default_config: Optional[str] = None


@router.get("/projects/{project_id}/requirements", responses=NOT_FOUND)
def read_requirements(
    request: Request, project_id: str, refresh: bool = False
) -> RequirementReport:
    """
    プロジェクトの Python で, ML-Found の登録簿の追加の依存を確かめる関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    refresh: bool = False
        覚えた結果を使わずに確かめ直す場合は True

    Returns
    ----------
    report: RequirementReport
        機能ごとの要るもの, 入っているか, 入れ方
    """
    project = get_project(request, project_id)
    report = check_requirements(
        project.python, Path(project.path), refresh=refresh
    )

    return report


@router.post(
    "/projects/{project_id}/requires", responses=NOT_FOUND | BAD_REQUEST
)
def read_requires_status(
    request: Request, project_id: str, body: RequiresRequest
) -> RequiresStatus:
    """
    config の requires に書いた機能のうち, 足りないものを返す関数

    学習の起動の画面が開始のボタンを止めるのに使う. ML-Found を読み込まず,
    YAML の requires だけを読む

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: RequiresRequest
        experiment の config の中身と, 学習のスクリプト

    Returns
    ----------
    status: RequiresStatus
        要る機能, 足りない機能, 登録簿に無い名前
    """
    project = get_project(request, project_id)
    project_dir = Path(project.path)
    if body.script is not None and body.script not in list_scripts(
        project_dir
    ):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )
    if len(body.text.encode()) > MAX_CONFIG_BYTES:
        raise HTTPException(400, "config が大きすぎます")
    default = resolve_default(project, body.default_config)
    default_path = default or default_config_for(project_dir, body.script)

    # 何も要らない場合は, プロジェクトの Python を動かさずに返却
    names, error = requires_from_text(default_path, body.text)
    if error is not None or not names:
        status = RequiresStatus(requires=names, error=error)
        return status
    status = requires_status(
        names, check_requirements(project.python, project_dir)
    )

    return status
