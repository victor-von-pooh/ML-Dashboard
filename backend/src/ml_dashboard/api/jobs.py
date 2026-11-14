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
    # 学習を始めるときに ML-Found が補う値などのお知らせ
    notes: list[str] = []
    # 元にした default の config (プロジェクトのディレクトリからの相対パス)
    default_config: Optional[str] = None


class CheckedConfig(BaseModel):
    diff: dict[str, dict[str, object]]
    config: dict[str, Any]
    warnings: list[str]
    notes: list[str] = []
    default_config: str
    # 引数の値の誤り (読み込めた config をフォームで直せるように分けて返却)
    value_error: Optional[str] = None


class ParamSpec(BaseModel):
    name: str
    kind: str
    default: Any
    required: bool
    advanced: bool
    description: str
    minimum: Optional[float]
    maximum: Optional[float]
    # 範囲の端の値を含まないか (ML-Found の登録簿の指定)
    exclusive_minimum: bool = False
    exclusive_maximum: bool = False


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
    # エポックの途中でも止める (ML-Found が途中のエポックを捨てて止める)
    now: bool = False


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


def optim_views(cfg: Any) -> list[tuple[str, Any]]:
    """
    Optimizer と Scheduler の 1 組ごとの config を, 表示に付ける接頭辞と
    一緒に返す関数

    名前付きの複数の Optimizer (optimizers) の場合は名前ごとに, そうでない
    場合は config そのものを返す

    Parameters
    ----------
    cfg: Any
        学習に使う config

    Returns
    ----------
    views: list[tuple[str, Any]]
        接頭辞 (optimizers.<名前>: か空) と, optimizer, scheduler, trainer を
        持つ config の組
    """
    from ml_found.training.optim import named_views, uses_named_optimizers

    # 名前付きの Optimizer は, ML-Found と同じ形の名前ごとの config
    # (trainer の値の参照 ${...} も解決できるように, 元の config で解決)
    if uses_named_optimizers(cfg):
        trainer = OmegaConf.to_container(cfg.trainer, resolve=True)
        views = []
        for name, view in named_views(cfg):
            view.trainer = trainer
            views.append((f"optimizers.{name}: ", view))
    else:
        views = [("", cfg)]

    return views


def check_param_names(cfg: Any) -> list[str]:
    """
    Optimizer と Scheduler の引数の名前と値を確かめ, 必須の不足は注意にする関数

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
    from ml_found.training.optim import (
        resolve_optimizer_class,
        resolve_scheduler_class,
    )
    from ml_found.training.registry import (
        check_optim_params,
        check_param_values,
    )

    # 名前の誤りはエラーのまま, 必須の引数の不足だけを注意として返却
    # 名前付きの Optimizer は, 1 つの不足で他の名前の確認が止まらないように
    # 名前ごとに確認
    warnings = []
    for prefix, view in optim_views(cfg):
        try:
            check_optim_params(view)
        except ValueError as error:
            if "必須の引数がありません" not in str(error):
                if not prefix:
                    raise
                raise ValueError(f"{prefix}{error}") from None
            warnings.append(
                f"{prefix}{error} (学習のスクリプトが補う場合はそのまま起動"
                "できます)"
            )

            # ML-Found は不足で止まり値の範囲を確かめないので, 範囲だけを確認
            try:
                check_param_values(
                    resolve_optimizer_class(view.optimizer.name),
                    view.optimizer.params
                )
                if view.scheduler.name is not None:
                    check_param_values(
                        resolve_scheduler_class(view.scheduler.name),
                        view.scheduler.params
                    )
            except ValueError as value_error:
                if not prefix:
                    raise
                raise ValueError(f"{prefix}{value_error}") from None

    return warnings


def describe_filled(cfg: Any, missing: list[str]) -> list[str]:
    """
    学習を始めるときに ML-Found が補う Scheduler の引数を, お知らせにする関数

    Parameters
    ----------
    cfg: Any
        学習に使う config
    missing: list[str]
        補う引数の名前

    Returns
    ----------
    notes: list[str]
        引数ごとに, 何から補うかのお知らせ
    """
    # auto と書いた引数は学習全体のステップ数, OneCycleLR の引数は個別に
    total = (
        "trainer.epochs"
        if cfg.scheduler.interval == "epoch"
        else "trainer.epochs × 学習用データのバッチ数"
    )
    sources = {
        "epochs": "trainer.epochs",
        "steps_per_epoch": (
            "1 (エポックごとに進めるため)"
            if cfg.scheduler.interval == "epoch"
            else "学習用データのバッチ数"
        )
    }
    # warmup がある場合, auto は warmup の後の残りのステップ数
    warmup = cfg.scheduler.get("warmup_steps")
    ratio = cfg.scheduler.get("warmup_ratio")
    remaining = ""
    if warmup:
        remaining = f" - {warmup} (warmup の後の残り)"
    elif ratio is not None:
        remaining = " - warmup の回数 (warmup の後の残り)"
    for name in missing:
        if cfg.scheduler.params.get(name) == "auto":
            sources[name] = (
                f"{total}{remaining}" if remaining
                else f"{total} (学習全体のステップ数)"
            )
    notes = [
        f"{cfg.scheduler.name} の {name} は, 学習を始めるときに ML-Found が"
        f" {sources.get(name, name)} にします"
        for name in missing
    ]

    # 割合で書いた warmup は, 学習を始めるときに回数に直すことをお知らせ
    if ratio is not None and warmup is None:
        notes.append(
            f"warmup の回数は, 学習を始めるときに ML-Found が {total} の "
            f"{ratio} 倍 (四捨五入) にします"
        )

    return notes


def check_one_cycle_epochs(cfg: Any) -> tuple[Optional[str], Optional[str]]:
    """
    OneCycleLR のエポック数と trainer.epochs の食い違いを確かめる関数

    総ステップ数を書いていない場合は, バッチ数が分からなくてもエポック数の
    大小で結果が決まる. 足りないと ML-Found が学習の直前にエラーにし,
    多いと学習率が下がりきらない

    Parameters
    ----------
    cfg: Any
        学習に使う config

    Returns
    ----------
    error: Optional[str]
        総ステップ数が足りない場合の誤り
    warning: Optional[str]
        総ステップ数が多い場合の注意
    """
    from ml_found.training.optim import resolve_scheduler_class
    from torch import optim

    # OneCycleLR で総ステップ数を書かず, 1 エポックの数が決まる場合だけ判定
    name = cfg.scheduler.name
    if name is None or not issubclass(
        resolve_scheduler_class(name), optim.lr_scheduler.OneCycleLR
    ):
        return None, None
    params = cfg.scheduler.params
    if params.get("total_steps") is not None:
        return None, None
    epochs = params.get("epochs") or cfg.trainer.epochs
    per_epoch = params.get("steps_per_epoch")
    if cfg.scheduler.interval == "epoch":
        planned, total = cfg.trainer.epochs, epochs * (per_epoch or 1)
    elif per_epoch is None:
        planned, total = cfg.trainer.epochs, epochs
    else:
        return None, None
    if total == planned:
        return None, None

    message = (
        f"{name} の epochs ({epochs}) が trainer.epochs ({cfg.trainer.epochs})"
        " と違います"
    )
    if total < planned:
        error = (
            message + " (学習の途中で総ステップ数を超えるので, "
            "学習を始める前にエラーになります)"
        )
        return error, None
    warning = message + " (学習率は最後まで下がりきりません)"

    return None, warning


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
    import torch
    from ml_found.config import load_config
    from ml_found.experiment.setup import (
        check_name,
        check_resume_path,
        check_trainer_config,
    )
    from ml_found.training.optim import (
        check_optim_config,
        missing_data_size_params,
        try_build_optim,
    )
    from ml_found.utils.device import get_device

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
        # 引数の値の誤り (範囲の外など) は, 残りの確認を済ませてから返却
        value_error = None
        try:
            warnings = check_param_names(cfg)
        except ValueError as error:
            if "引数の値に誤りがあります" not in str(error):
                raise
            warnings, value_error = [], str(error)
        check_trainer_config(cfg)
        check_resume_path(cfg, project_dir)

        # デバイスは start_experiment と同じく必ず確認
        try:
            get_device(cfg.experiment.device)
        except ValueError as error:
            if value_error is None:
                value_error = f"experiment.device の誤り: {error}"

        # 範囲を持たない引数の誤りも, 仮のパラメータで作ってみて確認
        # ダッシュボードのサーバーが GPU のメモリを持ち続けないように cpu で
        # 作成. 必須の引数が足りない場合 (スクリプトが補う) と, 値の誤りが
        # 既にある場合は作れないので対象外
        if not warnings and value_error is None:
            try:
                try_build_optim(cfg, torch.device("cpu"))
            except ValueError as error:
                value_error = str(error)

        # データの量で決まる Scheduler の引数は, 学習を始めるときに
        # ML-Found が補うのでお知らせし, エポック数の食い違いを確認
        # (名前付きの Optimizer は名前ごとに確かめ, 名前を付けて表示)
        notes = []
        for prefix, view in optim_views(cfg):
            notes += [
                f"{prefix}{note}" for note in describe_filled(
                    view, missing_data_size_params(view.scheduler)
                )
            ]
            mismatch, note = check_one_cycle_epochs(view)
            if mismatch is not None and value_error is None:
                value_error = f"{prefix}{mismatch}"
            if note is not None:
                warnings.append(f"{prefix}{note}")
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
        notes=notes,
        default_config=default_path.relative_to(project_dir).as_posix(),
        value_error=value_error
    )

    return checked


def require_valid(checked: CheckedConfig) -> None:
    """
    引数の値に誤りがあれば, 学習を始めないようにエラーにする関数

    Parameters
    ----------
    checked: CheckedConfig
        確かめた config

    Returns
    ----------
    None
    """
    if checked.value_error is not None:
        raise ValueError(checked.value_error)


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
    # 文の中に元のエラーの種類が既に入っている場合は付けない
    cause = error.__cause__ if isinstance(error.__cause__, Exception) else None
    if cause is not None and f"{type(cause).__name__}:" in str(error):
        cause = None
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

    # 値の誤りは, フォームで直せるように読み込めた config と一緒に返却
    result = ValidateResult(
        ok=checked.value_error is None, error=checked.value_error,
        diff=checked.diff, config=checked.config, warnings=checked.warnings,
        notes=checked.notes, default_config=checked.default_config
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
            require_valid(
                validate_text(project, body.config_text, body.script)
            )
        else:
            # config を指定しない場合は, スクリプトに対応する experiment の
            # config (train_hf.py なら hf.yaml, 無ければ train.yaml)
            config_path = resolve_config(
                project, body.config_path
                or experiment_config_for(Path(project.path), body.script)
            )
            require_valid(check_config(project, config_path, body.script))
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
    job = get_jobs(request).stop(job_id, projects, body.force, body.now)
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
