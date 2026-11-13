import importlib
import sys
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from omegaconf import DictConfig, OmegaConf
from pydantic import BaseModel, model_validator

from ml_dashboard.api.routes import NOT_FOUND, get_project
from ml_dashboard.core.jobs import Job, JobManager
from ml_dashboard.core.models import Progress, RunSummary
from ml_dashboard.core.projects import (
    Project,
    ProjectError,
    default_config_for,
    experiment_config_for,
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

# 受け付けられない場合の応答の説明
BAD_REQUEST: dict[int | str, dict[str, str]] = {
    400: {"description": "受け付けられないリクエスト"}
}


# ML-Found のモジュールを初めて読み込むときの排他
# ML-Found のモジュールは互いに読み込み合うので, 別々のスレッドの要求が
# 同時に違うモジュールから読み込むと, Python の読み込みのロックが互いを
# 待つ状態を検出してエラー (_DeadlockError)
ML_FOUND_IMPORT_LOCK = threading.Lock()


def import_ml_found() -> None:
    """
    ML-Found のパッケージを 1 つのスレッドから読み込む関数

    PyTorch も読み込むので, 起動時ではなく初めて使うときに読み込む.
    読み込んだ後は sys.modules から取り出すだけなので, 関数の中の
    import は待たずに済む

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # パッケージの最上位から読み込み, 中のモジュールを決まった順で読み込み
    with ML_FOUND_IMPORT_LOCK:
        # ml_found の __init__ が中のモジュールを全て読み込むので, これで十分
        importlib.import_module("ml_found")


class ConfigText(BaseModel):
    path: str
    text: str


class ValidateRequest(BaseModel):
    text: str
    # 学習のスクリプト, 元にする default の config の選択に使用
    script: Optional[str] = None


class ValidateResult(BaseModel):
    ok: bool
    error: Optional[str]
    diff: dict[str, dict[str, object]]
    # default と合わせた学習に使う config (フォームの今の値に使う)
    config: dict[str, Any] = {}
    # 学習のスクリプトが補う可能性があるので, エラーにしない注意
    warnings: list[str] = []
    # 元にした default の config (プロジェクトのディレクトリからの相対パス)
    default_config: Optional[str] = None


class CheckedConfig(BaseModel):
    diff: dict[str, dict[str, object]]
    config: dict[str, Any]
    warnings: list[str]
    default_config: str


class ParamSpec(BaseModel):
    name: str
    kind: str
    default: Any
    required: bool
    advanced: bool
    description: str
    minimum: Optional[float]
    maximum: Optional[float]


class ClassSpec(BaseModel):
    name: str
    description: str
    params: list[ParamSpec]
    supported: bool
    note: str


class Registry(BaseModel):
    optimizers: list[ClassSpec]
    schedulers: list[ClassSpec]


class JobCreate(BaseModel):
    script: str
    config_path: Optional[str] = None
    config_text: Optional[str] = None

    @model_validator(mode="after")
    def check_one_config(self) -> "JobCreate":
        """
        config のパスと中身の片方だけが指定されていることを確かめる関数

        Parameters
        ----------
        None

        Returns
        ----------
        body: JobCreate
            確かめたリクエスト
        """
        if self.config_path is not None and self.config_text is not None:
            raise ValueError("config_path と config_text はどちらか片方だけ")
        body = self

        return body


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
    force_count: int
    hostname: str
    return_code: Optional[int]
    stop_requested: bool
    run_id: Optional[str]
    run: Optional[RunSummary]
    progress: Optional[Progress]
    config_text: Optional[str]


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


def check_param_names(cfg: Any) -> list[str]:
    """
    Optimizer と Scheduler の引数の名前を確かめ, 必須の不足は注意にする関数

    Parameters
    ----------
    cfg: Any
        学習に使う config

    Returns
    ----------
    warnings: list[str]
        必須の引数の不足 (学習のスクリプトが start_experiment の前に補う
        場合があるので, エラーにはしない)
    """
    import_ml_found()
    from ml_found.training.registry import check_optim_params

    # 名前の誤りはエラーのまま, 必須の引数の不足だけを注意として返却
    warnings = []
    try:
        check_optim_params(cfg)
    except ValueError as error:
        if "必須の引数がありません" not in str(error):
            raise
        warnings.append(
            f"{error} (学習のスクリプトが補う場合はそのまま起動できます)"
        )

    return warnings


def check_config(
    project: Project, path: Path, script: Optional[str] = None
) -> CheckedConfig:
    """
    ML-Found で config を読み込み, 学習を始める前の確認をする関数

    Parameters
    ----------
    project: Project
        プロジェクト
    path: Path
        experiment の config のパス
    script: Optional[str] = None
        学習のスクリプト, 元にする default の config の選択に使用

    Returns
    ----------
    checked: CheckedConfig
        default との差分と, 学習に使う config 全体
    """
    # ML-Found の読み込みは PyTorch も読むので, 使うときだけ読み込み
    # ダッシュボードの submodule の ML-Found で確かめるので, プロジェクトの
    # ML-Found の版が違う場合は, 学習を始めてからのエラーの可能性あり
    import_ml_found()
    from ml_found.config import load_config
    from ml_found.experiment.setup import (
        check_name,
        check_resume_path,
        check_trainer_config,
    )
    from ml_found.training.optim import check_optim_config

    # start_experiment が出力先を作る前に行う確認と同じものを実行
    # 自作の Optimizer (custom_optim.Lion など) を読めるように,
    # 学習のスクリプトと同じくプロジェクトのディレクトリから読み込む
    project_dir = Path(project.path)
    default_path = default_config_for(project_dir, script)
    sys.path.insert(0, str(project_dir))
    try:
        cfg, diff = load_config(str(default_path), str(path))
        check_name(cfg.experiment.name)
        check_optim_config(cfg)
        warnings = check_param_names(cfg)
        check_trainer_config(cfg)
        check_resume_path(cfg, project_dir)
    finally:
        sys.path.remove(str(project_dir))
    config = OmegaConf.to_container(cfg, resolve=True)
    checked = CheckedConfig(
        diff={
            str(key): {
                "default": value.get("default"),
                "experiment": value.get("experiment")
            }
            for key, value in diff.items()
        },
        config=(
            {str(key): value for key, value in config.items()}
            if isinstance(config, dict) else {}
        ),
        warnings=warnings,
        default_config=default_path.relative_to(project_dir).as_posix()
    )

    return checked


def describe(error: Exception) -> str:
    """
    確認のエラーを表示する文にする関数

    Parameters
    ----------
    error: Exception
        起きたエラー

    Returns
    ----------
    message: str
        元のエラーの種類と内容, 文に変えたエラーは内容だけ
    """
    cause = error.__cause__ if isinstance(error.__cause__, Exception) else None
    if type(error) is ValueError and cause is not None:
        message = f"{type(cause).__name__}: {error}"
    elif type(error) is ValueError:
        message = str(error)
    else:
        message = f"{type(error).__name__}: {error}"

    return message


def validate_text(
    project: Project, text: str, script: Optional[str] = None
) -> CheckedConfig:
    """
    書き換えた config の中身を一時ファイルに書いて確かめる関数

    Parameters
    ----------
    project: Project
        プロジェクト
    text: str
        experiment の config の中身
    script: Optional[str] = None
        学習のスクリプト, 元にする default の config の選択に使用

    Returns
    ----------
    diff: dict[str, dict[str, object]]
        default との差分
    """
    if len(text.encode()) > MAX_CONFIG_BYTES:
        raise ValueError("config が大きすぎます")

    # 「項目: 値」の形でない場合は, ML-Found の長いエラーの前に分かりやすく通知
    loaded: object = OmegaConf.create(text) if text.strip() else {}
    if not isinstance(loaded, (dict, DictConfig)):
        raise ValueError(
            "experiment の config は「項目: 値」の形 (YAML の辞書) で"
            "書いてください"
        )

    # 出力先を変えた実験は実験の一覧に出せないので, 画面からの起動では変更不可
    experiment = loaded.get("experiment") if isinstance(
        loaded, (dict, DictConfig)
    ) else None
    if isinstance(experiment, (dict, DictConfig)) and (
        "output_dir" in experiment
    ):
        raise ValueError(
            "画面から起動する学習では experiment.output_dir を変えられません "
            "(プロジェクトの実験の一覧に表示できないため)"
        )

    # 一時ファイルの場所はエラーの文から除去
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "experiment.yaml"
        path.write_text(text, encoding="utf-8")
        try:
            checked = check_config(project, path, script)
        except Exception as error:
            message = str(error).replace(str(path), "experiment.yaml")
            raise ValueError(message) from error

    return checked


def to_job_info(
    jobs: JobManager, job: Job, project: Optional[Project]
) -> JobInfo:
    """
    ジョブに実験の概要と進み具合を加える関数

    Parameters
    ----------
    jobs: JobManager
        ジョブの管理
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
            output_dirs = jobs.output_dirs(job, project)
            run_dir = resolve_run_dir(output_dirs, job.run_id)
            run = summarize_run(run_dir.parent.parent.parent, run_dir)
            if job.status == "running":
                progress = read_progress(run_dir)
        except (ProjectError, RunNotFoundError):
            pass
    # 画面で書き換えた config は, 何で学習したかが分かるように中身も返却
    config_text = None
    config_path = Path(job.config)
    if config_path.parent.name == job.id and config_path.is_file():
        config_text = config_path.read_text(encoding="utf-8")
    data = asdict(job)
    info = JobInfo(
        **data, project_name=project.name if project else None, run=run,
        progress=progress, config_text=config_text
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


@router.post(
    "/projects/{project_id}/validate", responses=NOT_FOUND | BAD_REQUEST
)
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
        experiment の config の中身と, 学習のスクリプト

    Returns
    ----------
    result: ValidateResult
        読み込めたかどうか, エラー, 元にした default の config と差分
    """
    project = get_project(request, project_id)
    if body.script is not None and body.script not in list_scripts(
        Path(project.path)
    ):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    # 学習と同じ方法で読み込み, 失敗した場合は理由と元にした default を返却
    try:
        checked = validate_text(project, body.text, body.script)
    except Exception as error:
        project_dir = Path(project.path)
        default_path = default_config_for(project_dir, body.script)
        result = ValidateResult(
            ok=False, error=describe(error), diff={},
            default_config=default_path.relative_to(project_dir).as_posix()
        )
        return result

    result = ValidateResult(
        ok=True, error=None, diff=checked.diff, config=checked.config,
        warnings=checked.warnings, default_config=checked.default_config
    )

    return result


@router.post(
    "/projects/{project_id}/jobs", status_code=201,
    responses=NOT_FOUND | BAD_REQUEST
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
    # 一覧にあるスクリプトだけを受け付け
    project = get_project(request, project_id)
    if body.script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    # 起動する前に ML-Found で config の誤りを確認
    # ジョブのディレクトリは確認が通ってから作り, 失敗した起動は残さない設定
    config_path = None
    try:
        if body.config_text is not None:
            validate_text(project, body.config_text, body.script)
        else:
            # config を指定しない場合は, スクリプトに対応する experiment の
            # config (train_hf.py なら hf.yaml, 無ければ train.yaml)
            config_path = resolve_config(
                project, body.config_path
                or experiment_config_for(Path(project.path), body.script)
            )
            check_config(project, config_path, body.script)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            400, f"config に誤りがあります: {describe(error)}"
        ) from error

    # 中身を渡された場合はジョブのディレクトリに保存して起動
    jobs = get_jobs(request)
    job_id = jobs.create()
    try:
        if config_path is None:
            config_path = jobs.job_dir(job_id) / "experiment.yaml"
            config_path.write_text(body.config_text or "", encoding="utf-8")
        job = jobs.start(job_id, project, body.script, config_path)
    except OSError as error:
        jobs.discard(job_id)
        raise HTTPException(
            400, f"学習を起動できませんでした: {error}"
        ) from error
    info = to_job_info(get_jobs(request), job, project)

    return info


def project_map(request: Request) -> dict[str, Project]:
    """
    登録したプロジェクトを ID で引ける辞書にする関数

    Parameters
    ----------
    request: Request
        リクエスト

    Returns
    ----------
    projects: dict[str, Project]
        ID ごとのプロジェクト
    """
    projects = {
        project.id: project for project in request.app.state.store.load()
    }

    return projects


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
    projects = project_map(request)
    jobs = [
        to_job_info(get_jobs(request), job, projects.get(job.project_id))
        for job in get_jobs(request).list_jobs(projects)
    ]

    return jobs


def load_job(request: Request, job_id: str) -> tuple[Job, Optional[Project]]:
    """
    ジョブを読み込み, 無ければ 404 にする関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        ジョブの ID

    Returns
    ----------
    job: Job
        状態を更新したジョブ
    project: Optional[Project]
        ジョブのプロジェクト
    """
    projects = project_map(request)
    job = get_jobs(request).get(job_id, projects)
    if job is None:
        raise HTTPException(404, f"ジョブが見つかりません: {job_id}")
    project = projects.get(job.project_id)

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
    info = to_job_info(get_jobs(request), job, project)

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
    projects = project_map(request)
    job = get_jobs(request).stop(job_id, projects, body.force)
    if job is None:
        raise HTTPException(404, f"ジョブが見つかりません: {job_id}")
    info = to_job_info(get_jobs(request), job, projects.get(job.project_id))

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


@router.get("/registry")
def read_registry() -> Registry:
    """
    選べる Optimizer と Scheduler と引数の仕様を返す関数

    Parameters
    ----------
    None

    Returns
    ----------
    registry: Registry
        ML-Found の登録簿の内容
    """
    # ML-Found の読み込みは PyTorch も読むので, 使うときだけ読み込み
    import_ml_found()
    from ml_found.training.registry import (
        describe_optimizers,
        describe_schedulers,
    )

    registry = Registry.model_validate({
        "optimizers": describe_optimizers(),
        "schedulers": describe_schedulers()
    })

    return registry
