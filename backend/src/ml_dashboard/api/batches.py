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
    BatchActiveError,
    BatchManager,
    is_active,
    is_batch_id,
)
from ml_dashboard.core.jobs import JobManager
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


def read_default_spec(path: Path) -> Optional[str]:
    """
    default の config の model.spec を読む関数

    Parameters
    ----------
    path: Path
        default の config

    Returns
    ----------
    spec: Optional[str]
        model.spec の値 (参照は解決しない), 無いか空なら None
    """
    try:
        loaded = OmegaConf.load(path)
    except Exception:
        return None
    value = raw_model_spec(loaded) if isinstance(loaded, DictConfig) else None
    spec = None if value is None or not str(value).strip() else str(value)

    return spec


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


def app_projects(app: Any) -> dict[str, Project]:
    """
    登録したプロジェクトを ID で引ける辞書にする関数 (要求の外でも使う)

    Parameters
    ----------
    app: Any
        アプリ (FastAPI)

    Returns
    ----------
    projects: dict[str, Project]
        ID ごとのプロジェクト
    """
    projects = {project.id: project for project in app.state.store.load()}

    return projects


def job_running(app: Any, job_id: str) -> bool:
    """
    ジョブが学習中かを, 状態を読み直して返す関数

    Parameters
    ----------
    app: Any
        アプリ (FastAPI)
    job_id: str
        ジョブの ID

    Returns
    ----------
    running: bool
        学習中かどうか, 無いジョブは False
    """
    job = app.state.jobs.get(job_id, app_projects(app))
    running = job is not None and job.status == "running"

    return running


class BatchRunner:
    # まとまりの進め方がジョブと起動の確かめに使う口 (BatchHooks) の実装.
    # 要求が終わった後も動くので, 要求でなくアプリの状態を使う
    def __init__(self, app: Any, batch: Batch):
        # アプリ, ジョブ, 環境のジョブとまとまりを保存
        self.app = app
        self.jobs: JobManager = app.state.jobs
        self.environments = app.state.environments
        self.batch = batch

    def project(self) -> Project:
        """
        まとまりのプロジェクトを今の登録から取得する関数

        Parameters
        ----------
        None

        Returns
        ----------
        project: Project
            プロジェクト
        """
        project = app_projects(self.app).get(self.batch.project_id)
        if project is None:
            raise ValueError("プロジェクトの登録が外されています")

        return project

    def busy(self) -> list[str]:
        """
        次の候補が待つものを返す関数

        Parameters
        ----------
        None

        Returns
        ----------
        waiting: list[str]
            環境のジョブの間は ENVIRONMENT_MARK, それ以外は学習中のジョブの
            ID (無ければ空)
        """
        if self.environments.running(self.batch.project_id):
            return [ENVIRONMENT_MARK]
        waiting = [
            job.id for job in self.jobs.list_jobs(app_projects(self.app))
            if job.project_id == self.batch.project_id
            and job.status == "running"
        ]

        return waiting

    def check(self, candidate: BatchCandidate, text: str) -> Optional[str]:
        """
        候補の config を起動の直前に確かめ直す関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補
        text: str
            候補の書き換えた config の中身

        Returns
        ----------
        reason: Optional[str]
            起動しない理由, 通れば None
        """
        # 追加の依存も覚えた結果を使わずに確かめ直す
        try:
            project = self.project()
            default = resolve_default(project, self.batch.default_config)
            require_valid(validate_text(
                project, text, self.batch.script, default,
                refresh_requires=True
            ))
        except HTTPException as error:
            return str(error.detail)
        except Exception as error:
            return f"config に誤りがあります: {describe(error)}"
        reason = check_copy_for_launch(Path(project.path), text)

        return reason

    def launch(self, candidate: BatchCandidate, text: str) -> Optional[str]:
        """
        学習中のジョブと環境のジョブが無ければ候補を起動する関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補
        text: str
            候補の書き換えた config の中身

        Returns
        ----------
        job_id: Optional[str]
            起動したジョブの ID, 学習中のジョブがあれば None
        """
        # 無いことの確かめと起動を同じ launch_lock の中で実行
        project = self.project()
        with self.environments.launch_lock:
            if self.busy():
                return None
            job_id = self.jobs.create()
            try:
                config = self.jobs.job_dir(job_id) / "experiment.yaml"
                config.write_text(text, encoding="utf-8")
                self.jobs.start(
                    job_id, project, self.batch.script, config,
                    self.batch.default_config
                )
            except Exception:
                self.jobs.discard(job_id)
                raise

        return job_id

    def finished(self, job_id: str) -> bool:
        """
        候補のジョブが終わったかを返す関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        finished: bool
            終わったか, 無いジョブは True
        """
        finished = not job_running(self.app, job_id)

        return finished

    def run_sha256(self, job_id: str) -> Optional[str]:
        """
        候補のジョブの実験に写した定義の sha256 を返す関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        sha256: Optional[str]
            写しの sha256, 実験がまだ無いか写していなければ None
        """
        projects = app_projects(self.app)
        job = self.jobs.get(job_id, projects)
        project = projects.get(self.batch.project_id)
        if job is None or project is None:
            return None
        run_dir = self.jobs.find_run(job, project)
        source = read_source(run_dir) if run_dir is not None else None
        spec = source.model_spec if source is not None else None
        copied = spec is not None and spec.status == "copied"
        sha256 = spec.sha256 if spec is not None and copied else None

        return sha256

    def current_sha256(self, candidate: BatchCandidate) -> Optional[str]:
        """
        候補の定義の今の sha256 を返す関数

        Parameters
        ----------
        candidate: BatchCandidate
            候補

        Returns
        ----------
        sha256: Optional[str]
            今の中身の sha256, 選べない場所か読めない場合は None
        """
        project_dir = Path(self.project().path)
        path = project_dir / candidate.path
        sha256 = (
            spec_sha256(path) if spec_problem(project_dir, path) is None
            else None
        )

        return sha256


def to_batch_info(request: Request, batch: Batch) -> BatchInfo:
    """
    まとまりを画面に返す形にする関数

    持ち主が他のプロセスのまとまりは, ジョブの状態から読み直す

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
    app = request.app
    refreshed = manager.refresh_foreign(
        batch.id, lambda job_id: job_running(app, job_id)
    ) or batch
    project = app_projects(app).get(refreshed.project_id)
    info = BatchInfo(
        **refreshed.model_dump(), finished=not is_active(refreshed),
        owned=manager.owned(refreshed),
        project_name=project.name if project is not None else None
    )

    return info


@router.get(
    "/projects/{project_id}/model-specs", responses=NOT_FOUND | BAD_REQUEST
)
def read_model_specs(
    request: Request, project_id: str, script: Optional[str] = None,
    default_config: Optional[str] = None
) -> ModelSpecList:
    """
    プロジェクトの models/ のモデルの定義の一覧を返す関数

    Parameters
    ----------
    request: Request
        リクエスト
    project_id: str
        プロジェクトの ID
    script: Optional[str] = None
        学習のスクリプト (default の config の選択に使用)
    default_config: Optional[str] = None
        起動の前の確認に使う default の config, None はスクリプトから選択

    Returns
    ----------
    specs: ModelSpecList
        定義の一覧, 一覧を作れない理由, default の config の model.spec
    """
    project = get_project(request, project_id)
    if script is not None and script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {script}"
        )
    specs = list_model_specs(Path(project.path))

    # 候補の欄を出すかを決める default の config の model.spec
    default = resolve_default(project, default_config) or default_config_for(
        Path(project.path), script
    )
    specs.default_spec = read_default_spec(default)

    return specs


def refuse_active(request: Request, project_id: str) -> None:
    """
    プロジェクトに進めている途中のまとまりがあれば 409 にする関数

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
    app = request.app
    active = get_batches(request).active_for(
        project_id, lambda job_id: job_running(app, job_id)
    )
    if active is not None:
        raise HTTPException(
            409,
            "このプロジェクトには進めている途中の候補のまとまり "
            f"({active.id}) があります. 終わるか取りやめてから作って"
            "ください"
        )


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
    refuse_active(request, project.id)
    if body.script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    # model.spec を読まないプロジェクトでは, 替えても同じモデルになる
    default = resolve_default(project, body.default_config)
    default_path = default or default_config_for(
        Path(project.path), body.script
    )
    if read_default_spec(default_path) is None:
        raise HTTPException(
            400,
            "default の config に model.spec が無いので, 学習のスクリプトは"
            "定義を替えても同じモデルで学習します"
        )
    candidates = build_candidates(project, body, default)

    # 確かめ直しと作るのを同じロックの中で行い, 2 つのまとまりを同時に
    # 作らない. 作ってから進め方のスレッドを開始
    manager = get_batches(request)
    with manager.create_lock:
        refuse_active(request, project.id)
        batch = manager.create(
            project.id, body.script, body.default_config, candidates
        )
    manager.start(batch, BatchRunner(request.app, batch))
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


@router.post("/batches/{batch_id}/stop", responses=NOT_FOUND | CONFLICT)
def stop_batch(
    request: Request, batch_id: str, force: bool = False
) -> BatchInfo:
    """
    候補のまとまりの残りを取りやめ, 学習中の候補を止める関数

    Parameters
    ----------
    request: Request
        リクエスト
    batch_id: str
        まとまりの ID
    force: bool = False
        別のプロセスが持ち主のまとまりも取りやめるか (持ち主が応答しない
        と利用者が確かめた場合)

    Returns
    ----------
    info: BatchInfo
        更新したまとまり
    """
    if not is_batch_id(batch_id):
        raise HTTPException(
            404, f"候補のまとまりが見つかりません: {batch_id}"
        )
    # 他のプロセスが進めているまとまりは, そのプロセスのロックの外から
    # 書き換えないので断る (持ち主が居なければ取りやめられる)
    manager = get_batches(request)
    found = manager.load(batch_id)
    if (
        found is not None and not force and not manager.owned(found)
        and not manager.orphaned(found)
    ):
        raise HTTPException(
            409,
            "別のダッシュボードのプロセス (" + found.owner.hostname
            + ") が進めているまとまりなので, そのプロセスで取りやめて"
            "ください. 持ち主が応答しない場合は, 確かめてから強制して"
            "取りやめられます"
        )
    projects = project_map(request)
    jobs = get_jobs(request)
    batch = manager.stop(
        batch_id, lambda job_id: stop_job(jobs, projects, job_id)
    )
    if batch is None:
        raise HTTPException(
            404, f"候補のまとまりが見つかりません: {batch_id}"
        )
    info = to_batch_info(request, batch)

    return info


# 記録を消す口の応答
DELETE_RESPONSES: dict[int | str, dict[str, str]] = {
    404: {"description": "候補のまとまりが見つからない"},
    409: {"description": "待つ候補か学習中の候補が残っている"},
    500: {"description": "記録のディレクトリを消せなかった"},
}


@router.delete(
    "/batches/{batch_id}", status_code=204, responses=DELETE_RESPONSES
)
def delete_batch(request: Request, batch_id: str) -> None:
    """
    終わった候補のまとまりの記録を消す関数, 候補のジョブと実験は消さない

    Parameters
    ----------
    request: Request
        リクエスト
    batch_id: str
        まとまりの ID

    Returns
    ----------
    None
    """
    if not is_batch_id(batch_id):
        raise HTTPException(
            404, f"候補のまとまりが見つかりません: {batch_id}"
        )

    # 持ち主の居ないまとまりは, ジョブの状態から読み直して保存してから消す
    manager = get_batches(request)
    manager.refresh_foreign(
        batch_id, lambda job_id: job_running(request.app, job_id)
    )
    try:
        removed = manager.remove(batch_id)
    except BatchActiveError as error:
        raise HTTPException(
            409,
            "進めている途中のまとまりは消せません. 終わるか取りやめてから"
            "消してください (別のプロセスが進めているまとまりは, その"
            "プロセスが終わりを記録してから消せます)"
        ) from error
    except OSError as error:
        raise HTTPException(
            500,
            f"候補のまとまりの記録を消せませんでした ({error}). 置き場の "
            f"batches/{batch_id} の権限を確かめてください"
        ) from error
    if not removed:
        raise HTTPException(
            404, f"候補のまとまりが見つかりません: {batch_id}"
        )


def stop_job(
    jobs: JobManager, projects: dict[str, Project], job_id: str
) -> None:
    """
    候補のジョブを普通に中断する関数 (エポックの区切りで止める)

    Parameters
    ----------
    jobs: JobManager
        ジョブの管理
    projects: dict[str, Project]
        ID ごとの登録したプロジェクト
    job_id: str
        ジョブの ID

    Returns
    ----------
    None
    """
    jobs.stop(job_id, projects, False)
