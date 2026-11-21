from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from omegaconf import DictConfig, OmegaConf
from pydantic import BaseModel

from ml_dashboard.api.jobs import (
    BAD_REQUEST,
    INSTALLING,
    describe,
    get_jobs,
    project_map,
    require_valid,
    resolve_config,
    resolve_default,
    validate_text,
)
from ml_dashboard.api.routes import NOT_FOUND, get_project
from ml_dashboard.core.batches import (
    BatchHooks,
    BatchManager,
    is_active,
    is_batch_id,
)
from ml_dashboard.core.model_candidates import (
    list_model_specs,
    spec_problem,
    spec_sha256,
)
from ml_dashboard.core.model_spec import (
    check_copy_for_launch,
    raw_model_spec,
    set_model_spec,
)
from ml_dashboard.core.models import (
    Batch,
    BatchCandidate,
    BatchInfo,
    ModelSpecList,
)
from ml_dashboard.core.projects import (
    Project,
    default_config_for,
    experiment_config_for,
    list_scripts,
)
from ml_dashboard.core.runs import read_source

router = APIRouter(prefix="/api")

# まとめて起動する候補の数 (1 つだけなら普通の起動)
MIN_CANDIDATES = 2
MAX_CANDIDATES = 20

# 環境のジョブを待っていることを表す, 待っているジョブの印
ENVIRONMENT_MARK = "environment"

# まとまりが進めている途中で断る応答
CONFLICT: dict[int | str, dict[str, str]] = {
    409: {"description": "進めている途中のまとまりか, 環境のジョブがある"}
}


class BatchCreate(BaseModel):
    script: str
    config_path: Optional[str] = None
    config_text: Optional[str] = None
    # 起動の前の確認に使う default の config, None はスクリプトから選択
    default_config: Optional[str] = None
    # 候補の定義の場所 (候補の一覧の path), 選んだ順に学習する
    specs: list[str]


def get_batches(request: Request) -> BatchManager:
    """
    アプリのまとまりの管理を取得する関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    batches: BatchManager
        まとまりの管理
    """
    batches: BatchManager = request.app.state.batches

    return batches


def default_has_spec(path: Path) -> bool:
    """
    default の config が model.spec を持つかを確かめる関数

    Parameters
    ----------
    path: Path
        default の config

    Returns
    ----------
    found: bool
        model.spec に空でない値があるかどうか
    """
    try:
        loaded = OmegaConf.load(path)
    except Exception:
        return False
    value = raw_model_spec(loaded) if isinstance(loaded, DictConfig) else None
    found = value is not None and str(value).strip() != ""

    return found


def base_text(project: Project, body: BatchCreate) -> str:
    """
    候補の config の元にする experiment の config の中身を取得する関数

    Parameters
    ----------
    project: Project
        プロジェクト
    body: BatchCreate
        まとまりの要求

    Returns
    ----------
    text: str
        書き換えた中身か, プロジェクトの config のファイルの中身
    """
    if body.config_text is not None:
        return body.config_text
    path = resolve_config(
        project, body.config_path
        or experiment_config_for(Path(project.path), body.script)
    )
    text = path.read_text(encoding="utf-8")

    return text


def build_candidates(
    project: Project, body: BatchCreate, default: Optional[Path]
) -> list[tuple[BatchCandidate, str]]:
    """
    候補ごとに model.spec を書き換えた config を作り, 起動と同じ確認に通す
    関数

    Parameters
    ----------
    project: Project
        プロジェクト
    body: BatchCreate
        まとまりの要求
    default: Optional[Path]
        起動の前の確認に使う default の config

    Returns
    ----------
    candidates: list[tuple[BatchCandidate, str]]
        候補と書き換えた config の中身 (選んだ順)
    """
    # 数と重なり, 候補の一覧にあって選べるものだけ
    if not MIN_CANDIDATES <= len(body.specs) <= MAX_CANDIDATES:
        raise HTTPException(
            400,
            f"候補は {MIN_CANDIDATES} 個から {MAX_CANDIDATES} 個まで選んで"
            "ください"
        )
    if len(set(body.specs)) != len(body.specs):
        raise HTTPException(400, "同じ候補を 2 回選んでいます")
    listing = {
        spec.path: spec for spec in list_model_specs(Path(project.path)).specs
    }
    text = base_text(project, body)

    # 全ての候補を先に確かめ, 1 つでも誤りがあれば何も起動しない
    candidates: list[tuple[BatchCandidate, str]] = []
    errors: list[str] = []
    for index, path in enumerate(body.specs):
        spec = listing.get(path)
        if spec is None:
            errors.append(f"{path}: models/ の定義の一覧にありません")
            continue
        if spec.reason is not None or spec.sha256 is None:
            errors.append(f"{path}: {spec.reason or '読めません'}")
            continue
        try:
            changed = set_model_spec(text, path)
            require_valid(validate_text(
                project, changed, body.script, default,
                refresh_requires=index == 0
            ))
        except Exception as error:
            errors.append(f"{path}: {describe(error)}")
            continue
        candidates.append((
            BatchCandidate(path=path, name=spec.name, sha256=spec.sha256),
            changed
        ))
    if errors:
        raise HTTPException(
            400, "候補の config に誤りがあります: " + " / ".join(errors)
        )

    return candidates


def running_jobs(request: Request, project_id: str) -> list[str]:
    """
    プロジェクトの学習中のジョブを集める関数

    Parameters
    ----------
    request: Request
        リクエスト (アプリの状態を読む)

    project_id: str
        プロジェクトの ID

    Returns
    ----------
    job_ids: list[str]
        学習中のジョブの ID
    """
    job_ids = [
        job.id for job in get_jobs(request).list_jobs(project_map(request))
        if job.project_id == project_id and job.status == "running"
    ]

    return job_ids


def make_hooks(request: Request, batch: Batch) -> BatchHooks:
    """
    まとまりの進め方が使う, 起動と確かめの関数を作る関数

    Parameters
    ----------
    request: Request
        リクエスト (アプリの状態を読む. 要求が終わった後も使う)
    batch: Batch
        まとまり

    Returns
    ----------
    hooks: BatchHooks
        起動と確かめの関数
    """
    jobs = get_jobs(request)
    environments = request.app.state.environments

    def current_project() -> Project:
        project = project_map(request).get(batch.project_id)
        if project is None:
            raise ValueError("プロジェクトの登録が外されています")
        return project

    def busy() -> list[str]:
        if environments.running(batch.project_id):
            return [ENVIRONMENT_MARK]
        return running_jobs(request, batch.project_id)

    def check(candidate: BatchCandidate, text: str) -> Optional[str]:
        # 起動の直前の確かめ直し (追加の依存も覚えた結果を使わない)
        try:
            project = current_project()
            default = resolve_default(project, batch.default_config)
            require_valid(validate_text(
                project, text, batch.script, default, refresh_requires=True
            ))
        except HTTPException as error:
            return str(error.detail)
        except Exception as error:
            return f"config に誤りがあります: {describe(error)}"
        reason = check_copy_for_launch(Path(project.path), text)

        return reason

    def launch(candidate: BatchCandidate, text: str) -> Optional[str]:
        # 学習中のジョブと環境のジョブが無いことの確かめと起動を同じロックで
        project = current_project()
        with environments.launch_lock:
            if busy():
                return None
            job_id = jobs.create()
            try:
                config = jobs.job_dir(job_id) / "experiment.yaml"
                config.write_text(text, encoding="utf-8")
                job = jobs.start(
                    job_id, project, batch.script, config,
                    batch.default_config
                )
            except Exception:
                jobs.discard(job_id)
                raise
        return job.id

    def finished(job_id: str) -> bool:
        job = jobs.get(job_id, project_map(request))
        return job is None or job.status != "running"

    def run_sha256(job_id: str) -> Optional[str]:
        # 学習を始めた実験の写しの sha256 (写していなければ None)
        projects = project_map(request)
        job = jobs.get(job_id, projects)
        project = projects.get(batch.project_id)
        if job is None or project is None:
            return None
        run_dir = jobs.find_run(job, project)
        source = read_source(run_dir) if run_dir is not None else None
        spec = source.model_spec if source is not None else None
        if spec is None or spec.status != "copied":
            return None
        return spec.sha256

    def stop(job_id: str) -> None:
        jobs.stop(job_id, project_map(request), False)

    def current_sha256(candidate: BatchCandidate) -> Optional[str]:
        project = current_project()
        path = Path(project.path) / candidate.path
        if spec_problem(Path(project.path), path) is not None:
            return None
        return spec_sha256(path)

    hooks = BatchHooks(
        busy=busy, check=check, launch=launch, finished=finished,
        run_sha256=run_sha256, stop=stop, current_sha256=current_sha256
    )

    return hooks


def to_batch_info(request: Request, batch: Batch) -> BatchInfo:
    """
    まとまりを画面に返す形にする関数

    持ち主が他のプロセスのまとまりの学習中の候補は, ジョブの状態を読み直す

    Parameters
    ----------
    request: Request
        リクエスト
    batch: Batch
        まとまり

    Returns
    ----------
    info: BatchInfo
        まとまり, 終わったか, 持ち主がこのプロセスか, プロジェクトの名前
    """
    manager = get_batches(request)
    owned = manager.owned(batch)
    projects = project_map(request)

    # 進め方が居ないまとまりの学習中の候補は, ジョブが終われば終わった
    if not owned and manager.orphaned(batch):
        changed = False
        for candidate in batch.candidates:
            if candidate.state != "running" or candidate.job_id is None:
                continue
            job = get_jobs(request).get(candidate.job_id, projects)
            if job is None or job.status != "running":
                candidate.state = "finished"
                changed = True
        if changed:
            with manager.lock(batch.id):
                manager.save(batch)
    project = projects.get(batch.project_id)
    info = BatchInfo(
        **batch.model_dump(), finished=not is_active(batch), owned=owned,
        project_name=project.name if project is not None else None
    )

    return info


@router.get(
    "/projects/{project_id}/model-specs", responses=NOT_FOUND
)
def read_model_specs(request: Request, project_id: str) -> ModelSpecList:
    """
    プロジェクトの models/ のモデルの定義の一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    specs: ModelSpecList
        定義の一覧と, 一覧を作れない理由
    """
    project = get_project(request, project_id)
    specs = list_model_specs(Path(project.path))

    return specs


@router.post(
    "/projects/{project_id}/batches", status_code=201,
    responses=NOT_FOUND | BAD_REQUEST | INSTALLING | CONFLICT
)
def create_batch(
    request: Request, project_id: str, body: BatchCreate
) -> BatchInfo:
    """
    モデルの定義の候補を, 同じスクリプトと config で順に学習する関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    body: BatchCreate
        スクリプト, config, default, 候補の定義の場所

    Returns
    ----------
    info: BatchInfo
        作ったまとまり
    """
    # 環境のジョブと, 進めている途中のまとまりがある間は断る
    project = get_project(request, project_id)
    if body.config_path is not None and body.config_text is not None:
        raise HTTPException(
            400, "config_path と config_text はどちらか片方だけ"
        )
    if request.app.state.environments.running(project.id):
        raise HTTPException(
            409, "学習の準備で環境に入れている間は学習を起動できません"
        )
    manager = get_batches(request)
    active = manager.active_for(project.id)
    if active is not None:
        raise HTTPException(
            409,
            "このプロジェクトには進めている途中の候補のまとまり "
            f"({active.id}) があります. 終わるか取りやめてから作って"
            "ください"
        )
    if body.script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    # model.spec を読まないプロジェクトでは, 替えても同じモデルになる
    default = resolve_default(project, body.default_config)
    default_path = default or default_config_for(
        Path(project.path), body.script
    )
    if not default_has_spec(default_path):
        raise HTTPException(
            400,
            "default の config に model.spec が無いので, 学習のスクリプトは"
            "定義を替えても同じモデルで学習します"
        )
    candidates = build_candidates(project, body, default)

    # 記録を作ってから, 進め方のスレッドを開始
    batch = manager.create(
        project.id, body.script, body.default_config, candidates
    )
    manager.start(batch, make_hooks(request, batch))
    info = to_batch_info(request, batch)

    return info


@router.get("/batches")
def list_batches(request: Request) -> list[BatchInfo]:
    """
    候補のまとまりの一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    batches: list[BatchInfo]
        まとまり (新しい順)
    """
    batches = [
        to_batch_info(request, batch)
        for batch in get_batches(request).list_batches()
    ]

    return batches


@router.post("/batches/{batch_id}/stop", responses=NOT_FOUND)
def stop_batch(request: Request, batch_id: str) -> BatchInfo:
    """
    候補のまとまりの残りを取りやめ, 学習中の候補を止める関数

    Parameters
    ----------
    request: Request
        リクエスト
    batch_id: str
        まとまりの ID

    Returns
    ----------
    info: BatchInfo
        更新したまとまり
    """
    if not is_batch_id(batch_id):
        raise HTTPException(404, f"候補のまとまりが見つかりません: {batch_id}")
    projects = project_map(request)
    batch = get_batches(request).stop(
        batch_id,
        lambda job_id: _stop_job(request, job_id, projects)
    )
    if batch is None:
        raise HTTPException(404, f"候補のまとまりが見つかりません: {batch_id}")
    info = to_batch_info(request, batch)

    return info


def _stop_job(request: Request, job_id: str, projects: dict[str, Any]) -> None:
    """
    候補のジョブを普通に中断する関数 (エポックの区切りで止める)

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID
    projects: dict[str, Any]
        ID ごとの登録したプロジェクト

    Returns
    ----------
    None
    """
    get_jobs(request).stop(job_id, projects, False)
