import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, Optional

import yaml
from fastapi import APIRouter, HTTPException, Request
from omegaconf import DictConfig, OmegaConf
from pydantic import BaseModel, model_validator

from ml_dashboard.api.routes import (
    NOT_FOUND,
    RUN_PATH,
    get_project,
    get_run_data,
)
from ml_dashboard.core.env_refs import (
    config_without_env,
    diff_without_env,
    env_replacements,
    flatten,
    read_texts,
    redact,
)
from ml_dashboard.core.jobs import Job, JobManager
from ml_dashboard.core.loader import import_ml_found
from ml_dashboard.core.model_spec import (
    CopyRefusedError,
    check_copy_for_launch,
    compare_current,
    default_model_spec,
    find_model_spec_copy,
    load_mapping,
    raw_model_spec,
    run_of_copy,
    set_model_spec,
)
from ml_dashboard.core.models import Progress, RunSource, RunSummary
from ml_dashboard.core.projects import (
    Project,
    ProjectError,
    default_config_for,
    experiment_config_for,
    list_default_configs,
    list_experiment_configs,
    list_scripts,
)
from ml_dashboard.core.requirements import (
    check_requirements,
    describe_missing,
    describe_warnings,
    read_requires,
    requires_status,
)
from ml_dashboard.core.runs import (
    RunNotFoundError,
    read_progress,
    read_source,
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

# 学習の準備で環境に入れている間の応答
INSTALLING: dict[int | str, dict[str, str]] = {
    409: {"description": "学習の準備で環境に入れている"}
}

# 起動の前にあるかを確かめるパスの項目の名前の最後の語 (_ か - で区切った語.
# 大文字と小文字は区別なし. profile などの語の一部とは不一致)
PATH_KEY_WORDS = frozenset({"path", "dir", "file"})

# Hugging Face の model_name_or_path などの, パスでなくてもよい項目の名前の末尾
NAME_OR_PATH_SUFFIX = "name_or_path"

# パスの確認から外す項目 (ML-Found が作る出力先と, ML-Found が確かめる再開元と
# 始める前に読む重み)
SKIPPED_PATH_KEYS = frozenset({
    "experiment.output_dir", "trainer.resume_from", "trainer.init_weights.path"
})


class ConfigText(BaseModel):
    path: str
    text: str


class ValidateRequest(BaseModel):
    text: str
    # 学習のスクリプト, 元にする default の config の選択に使用
    script: Optional[str] = None
    # 元にする default の config (configs/default の中の相対パス).
    # 指定しない場合はスクリプトから選択
    default_config: Optional[str] = None


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
    # 元にした default の config が trainer.monitor を書いているか (書いて
    # いなければ, 画面で問題の設定の監視する指標と向きを選べる)
    monitor_in_default: bool = False
    # 元にした default の config が trainer.mode を書いているか (書いて
    # いれば, 問題の設定の値を初めに入れるときに向きを書かない)
    mode_in_default: bool = False


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
    # 起動の前の確認に使う default の config (configs/default の中の
    # 相対パス). 指定しない場合はスクリプトから選択
    default_config: Optional[str] = None

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
    # 起動の前の確認に使った default の config, None はスクリプトから選択
    default_config: Optional[str] = None


class JobOutput(BaseModel):
    text: str


class RelaunchPlan(BaseModel):
    # 起動できない理由, 起動できる場合は None
    reason: Optional[str] = None
    script: Optional[str] = None
    # 起動の前の確認に使う default の config (configs/default の中)
    default_config: Optional[str] = None
    # 選ぶプロジェクトの experiment の config, 一覧に無い場合は None
    config_path: Optional[str] = None
    # experiment の config の中身 (上書きを重ねたもの)
    config_text: Optional[str] = None
    # 起動に使う, 実験に写したモデルの定義 (プロジェクトからの相対パス).
    # 写しを使わない場合は None
    model_spec: Optional[str] = None
    # 写しを使うことのお知らせ (config_text の model.spec が写しを指す間だけ
    # 画面に出す)
    model_spec_note: Optional[str] = None
    # 今の定義に戻すときの experiment の config の model.spec. None は消して
    # default の値に戻す
    model_spec_original: Optional[str] = None
    # 実験の時と違うかもしれない点などのお知らせ
    notes: list[str] = []


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


def resolve_default(
    project: Project, relative: Optional[str]
) -> Optional[Path]:
    """
    指定された default の config のパスを確かめる関数

    Parameters
    ----------
    project: Project
        プロジェクト
    relative: Optional[str]
        プロジェクトのディレクトリからの相対パス

    Returns
    ----------
    path: Optional[Path]
        default の config のパス, 指定が無い場合は None
    """
    if relative is None:
        return None

    # configs/default の中の YAML だけを受け付け
    if relative not in list_default_configs(Path(project.path)):
        raise HTTPException(
            400, f"default の config が見つかりません: {relative}"
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
    from ml_found.training import named_views, uses_named_optimizers

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
    from ml_found.training import (
        check_optim_params,
        check_param_values,
        resolve_optimizer_class,
        resolve_scheduler_class,
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
    from ml_found.training import resolve_scheduler_class
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


def find_missing_paths(cfg: Any, project_dir: Path) -> list[str]:
    """
    config のパスの項目のうち, ファイルやディレクトリが無いものを注意にする関数

    名前の最後の語が path, dir, file の項目の, 空でない文字列の値を対象にする.
    学習のスクリプトが作るものもあるので, エラーにはしない

    Parameters
    ----------
    cfg: Any
        学習に使う config
    project_dir: Path
        プロジェクトのディレクトリ (相対パスの基準)

    Returns
    ----------
    warnings: list[str]
        見つからないパスごとの注意
    """
    # 値の参照 (${...}) は解決せずに対象外にするので, 解決しない形で走査
    container = OmegaConf.to_container(cfg, resolve=False)
    warnings: list[str] = []
    stack: list[tuple[str, Any]] = [("", container)]
    while stack:
        prefix, node = stack.pop()
        if not isinstance(node, dict):
            continue
        for key, value in node.items():
            name = f"{prefix}{key}"
            if isinstance(value, dict):
                stack.append((f"{name}.", value))
                continue
            message = describe_missing_path(name, value, project_dir)
            if message is not None:
                warnings.append(message)
    warnings.sort()

    return warnings


def describe_missing_path(
    name: str, value: Any, project_dir: Path
) -> Optional[str]:
    """
    1 つの項目のパスが無い場合に, 注意の文を作る関数

    Parameters
    ----------
    name: str
        項目の名前 (data.train_path など)
    value: Any
        項目の値
    project_dir: Path
        プロジェクトのディレクトリ (相対パスの基準)

    Returns
    ----------
    message: Optional[str]
        パスが無い場合の注意, 対象外かパスがある場合は None
    """
    # 名前の最後の語がパスを表す, 空でない文字列の項目だけが対象
    key = name.rsplit(".", 1)[-1].lower()
    word = key.replace("-", "_").rsplit("_", 1)[-1]
    if word not in PATH_KEY_WORDS or key.endswith(NAME_OR_PATH_SUFFIX):
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    # ML-Found が作るもの, 確かめるもの, URL, 値の参照, 必須の印は対象外
    if name in SKIPPED_PATH_KEYS or value == "???":
        return None
    if "://" in value or "${" in value:
        return None

    # 相対パスは ML-Found の出力先や再開元と同じくプロジェクトのディレクトリ
    # から (ダッシュボードの学習もプロジェクトのディレクトリで起動)
    given = Path(value)
    try:
        given = given.expanduser()
        resolved = given if given.is_absolute() else project_dir / given
        if resolved.exists():
            return None
    except (OSError, RuntimeError, ValueError):
        # 無いユーザーの ~ や NUL 文字など, 確かめられない値も見つからない扱い
        pass
    kind = "ディレクトリ" if word == "dir" else "ファイル"
    base = "" if given.is_absolute() else " (プロジェクトのディレクトリから)"
    message = f"{name} の{kind}が見つかりません: {value}{base}"

    return message


def check_config(
    project: Project, path: Path, script: Optional[str] = None,
    default: Optional[Path] = None, refresh_requires: bool = False
) -> CheckedConfig:
    """
    学習を始める前の確認をし, 環境変数の値を文から除く関数

    Parameters
    ----------
    project: Project
        プロジェクト
    path: Path
        experiment の config のパス
    script: Optional[str] = None
        学習のスクリプト, 元にする default の config の選択に使用
    default: Optional[Path] = None
        元にする default の config, None の場合はスクリプトから選択
    refresh_requires: bool = False
        requires の機能を, 覚えた結果を使わずに確かめる場合は True (起動)

    Returns
    ----------
    checked: CheckedConfig
        default との差分と, 学習に使う config 全体 (どちらも環境変数を引く
        値は書いたまま. 警告, お知らせ, 誤りの文の値は参照の書き方に置換)
    """
    # 確かめは解決した値で行い, 画面に返す文から環境変数の値を除去
    default_path = default or default_config_for(Path(project.path), script)
    texts = read_texts([default_path, path])
    try:
        checked, cfg = run_checks(
            project, path, default_path, refresh_requires
        )
    except Exception as error:
        # 読み込めない場合, 名前を参照で決める環境変数は安全側に全て消す
        message = redact(str(error), env_replacements(texts))
        if message == str(error):
            raise
        raise rebuild_error(error, message) from error.__cause__
    replacements = env_replacements(texts, cfg)
    checked.warnings = [
        redact(text, replacements) for text in checked.warnings
    ]
    checked.notes = [redact(text, replacements) for text in checked.notes]
    if checked.value_error is not None:
        checked.value_error = redact(checked.value_error, replacements)

    return checked


def rebuild_error(error: Exception, message: str) -> Exception:
    """
    エラーを, 種類を変えずに文だけ置き換えたものにする関数

    Parameters
    ----------
    error: Exception
        元のエラー
    message: str
        置き換える文

    Returns
    ----------
    rebuilt: Exception
        同じ種類のエラー, 文だけで作れない種類の場合は ValueError
    """
    try:
        rebuilt = type(error)(message)
    except Exception:
        rebuilt = ValueError(message)
    if str(rebuilt) != message:
        rebuilt = ValueError(message)

    return rebuilt


def run_checks(
    project: Project, path: Path, default_path: Path,
    refresh_requires: bool = False
) -> tuple[CheckedConfig, DictConfig]:
    """
    ML-Found で config を読み込み, 学習を始める前の確認をする関数

    Parameters
    ----------
    project: Project
        プロジェクト
    path: Path
        experiment の config のパス
    default_path: Path
        元にする default の config
    refresh_requires: bool = False
        requires の機能を, 覚えた結果を使わずに確かめる場合は True (起動)

    Returns
    ----------
    checked: CheckedConfig
        default との差分と, 学習に使う config 全体 (環境変数を引く値は
        書いたまま)
    cfg: DictConfig
        学習に使う config (解決していないもの)
    """
    # ML-Found の読み込みは PyTorch も読むので, 使うときだけ読み込み
    # ダッシュボードの submodule の ML-Found で確かめるので, プロジェクトの
    # ML-Found の版が違う場合は, 学習を始めてからのエラーの可能性あり
    import_ml_found()
    import torch
    from ml_found.config import load_config
    from ml_found.experiment import (
        check_experiment_name,
        check_init_weights,
        check_precision,
        check_resume_path,
        check_trainer_config,
    )
    from ml_found.training import (
        check_optim_config,
        missing_data_size_params,
        try_build_optim,
    )
    from ml_found.utils import get_device

    # start_experiment が出力先を作る前に行う確認と同じものを実行
    # 自作の Optimizer (custom_optim.Lion など) を読めるように,
    # 学習のスクリプトと同じくプロジェクトのディレクトリから読み込む
    project_dir = Path(project.path)
    sys.path.insert(0, str(project_dir))
    try:
        cfg, diff = load_config(str(default_path), str(path))
        check_experiment_name(cfg.experiment.name)
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
        check_init_weights(cfg, project_dir)

        # デバイスは start_experiment と同じく必ず確認
        # bf16 はデバイスで使えるかも確認 (フォームで fp32 に戻せるように
        # 値の誤り)
        try:
            device = get_device(cfg.experiment.device)
        except ValueError as error:
            if value_error is None:
                value_error = f"experiment.device の誤り: {error}"
        else:
            try:
                check_precision(cfg, device)
            except ValueError as error:
                if value_error is None:
                    value_error = str(error)

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

        # データなどのパスの書き誤りは, 起動を止めずに注意
        warnings += find_missing_paths(cfg, project_dir)
    finally:
        sys.path.remove(str(project_dir))

    # config の requires に書いた機能をプロジェクトの Python で確かめ,
    # 足りなければ次の一手を添えた誤り (起動では覚えた結果を使わない確かめ)
    requires_error, requires_warnings = check_requires(
        cfg, project, refresh_requires
    )
    warnings += requires_warnings
    if requires_error is not None:
        value_error = (
            requires_error if value_error is None
            else f"{value_error}\n{requires_error}"
        )

    # 画面に返す config と差分は, 環境変数を引く値を書いたままにした形
    # (環境変数に入れた秘密の値を画面に出さないため)
    config = config_without_env(cfg)
    default_config = config_without_env(load_default(default_path))
    checked = CheckedConfig(
        diff=diff_without_env(
            diff, flatten(default_config), flatten(config)
        ),
        config=config,
        warnings=warnings,
        notes=notes,
        default_config=default_path.relative_to(project_dir).as_posix(),
        value_error=value_error
    )

    return checked, cfg


def load_default(default_path: Path) -> DictConfig:
    """
    ML-Found の既定値に default を重ねた config を読み込む関数

    Parameters
    ----------
    default_path: Path
        元にする default の config

    Returns
    ----------
    cfg: DictConfig
        空の experiment を重ねた config (差分の default の側に使用)
    """
    from ml_found.config import load_config

    # 公開の load_config で読むために, 空の experiment を一時ファイルに作成
    with tempfile.TemporaryDirectory() as directory:
        empty = Path(directory) / "experiment.yaml"
        empty.write_text("{}\n", encoding="utf-8")
        loaded, _ = load_config(str(default_path), str(empty))
    cfg: DictConfig = loaded

    return cfg


def check_requires(
    cfg: Any, project: Project, refresh: bool = False
) -> tuple[Optional[str], list[str]]:
    """
    config の requires に書いた機能が入っているかを確かめる関数

    Parameters
    ----------
    cfg: Any
        default と合わせた config
    project: Project
        プロジェクト
    refresh: bool = False
        覚えた結果を使わずに確かめる場合は True

    Returns
    ----------
    error: Optional[str]
        起動を止める誤り (書き方の誤りか足りない機能), 無ければ None
    warnings: list[str]
        起動は止めない注意 (登録簿に無い名前, 確かめられない理由)
    """
    warnings: list[str] = []
    names, error = read_requires(cfg)
    if error is not None or not names:
        return error, warnings
    status = requires_status(
        names,
        check_requirements(project.python, Path(project.path), refresh)
    )
    warnings = describe_warnings(status)
    if status.missing:
        error = describe_missing(status)

    return error, warnings


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


def check_output_dir(loaded: object) -> None:
    """
    experiment の config が出力先を変えていればエラーにする関数

    Parameters
    ----------
    loaded: object
        読み込んだ experiment の config

    Returns
    ----------
    None
    """
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


def writes_monitor(path: Path) -> tuple[bool, bool]:
    """
    default の config が監視する指標と向き (trainer.monitor と
    trainer.mode) を書いているかを確かめる関数

    Parameters
    ----------
    path: Path
        default の config

    Returns
    ----------
    monitor: bool
        null でない trainer.monitor があれば True (読めない場合は False)
    mode: bool
        null でない trainer.mode があれば True (読めない場合は False)
    """
    # 書いたままの値を見る (環境変数の参照なども書いたものとみなす)
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError):
        return False, False
    trainer = loaded.get("trainer") if isinstance(loaded, dict) else None
    if not isinstance(trainer, dict):
        return False, False
    monitor = trainer.get("monitor") is not None
    mode = trainer.get("mode") is not None

    return monitor, mode


def validate_text(
    project: Project, text: str, script: Optional[str] = None,
    default: Optional[Path] = None, refresh_requires: bool = False
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
    default: Optional[Path] = None
        元にする default の config, None の場合はスクリプトから選択
    refresh_requires: bool = False
        requires の機能を, 覚えた結果を使わずに確かめる場合は True (起動)

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

    check_output_dir(loaded)

    # 一時ファイルの場所はエラーの文から除去
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "experiment.yaml"
        path.write_text(text, encoding="utf-8")
        try:
            checked = check_config(
                project, path, script, default, refresh_requires
            )
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

    default = resolve_default(project, body.default_config)
    project_dir = Path(project.path)
    default_path = default or default_config_for(project_dir, body.script)
    monitor_in_default, mode_in_default = writes_monitor(default_path)

    # 学習と同じ方法で読み込み, 失敗した場合は理由と元にした default を返却
    try:
        checked = validate_text(project, body.text, body.script, default)
    except Exception as error:
        result = ValidateResult(
            ok=False, error=describe(error), diff={},
            default_config=default_path.relative_to(project_dir).as_posix(),
            monitor_in_default=monitor_in_default,
            mode_in_default=mode_in_default
        )
        return result

    # 値の誤りは, フォームで直せるように読み込めた config と一緒に返却
    result = ValidateResult(
        ok=checked.value_error is None, error=checked.value_error,
        diff=checked.diff, config=checked.config, warnings=checked.warnings,
        notes=checked.notes, default_config=checked.default_config,
        monitor_in_default=monitor_in_default,
        mode_in_default=mode_in_default
    )

    return result


@router.post(
    "/projects/{project_id}/jobs", status_code=201,
    responses=NOT_FOUND | BAD_REQUEST | INSTALLING
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
    if request.app.state.environments.running(project.id):
        raise HTTPException(
            409, "学習の準備で環境に入れている間は学習を起動できません"
        )
    if body.script not in list_scripts(Path(project.path)):
        raise HTTPException(
            400, f"学習のスクリプトが見つかりません: {body.script}"
        )

    default = resolve_default(project, body.default_config)

    # 起動する前に ML-Found で config の誤りを確認
    # ジョブのディレクトリは確認が通ってから作り, 失敗した起動は残さない設定
    config_path = None
    try:
        if body.config_text is not None:
            require_valid(validate_text(
                project, body.config_text, body.script, default,
                refresh_requires=True
            ))
        else:
            # config を指定しない場合は, スクリプトに対応する experiment の
            # config (train_hf.py なら hf.yaml, 無ければ train.yaml)
            config_path = resolve_config(
                project, body.config_path
                or experiment_config_for(Path(project.path), body.script)
            )
            require_valid(check_config(
                project, config_path, body.script, default,
                refresh_requires=True
            ))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            400, f"config に誤りがあります: {describe(error)}"
        ) from error

    # model.spec が実験に写した定義を指す場合は, 写しが今も記録の中身かを
    # 確かめ直し (起動の画面を開いた後に書き換わった写しで学習しないため)
    launched = body.config_text or ""
    if body.config_text is None and config_path is not None:
        try:
            launched = config_path.read_text(encoding="utf-8")
        except OSError:
            launched = ""
    spec_reason = check_copy_for_launch(Path(project.path), launched)
    if spec_reason is not None:
        raise CopyRefusedError(spec_reason)

    # 中身を渡された場合はジョブのディレクトリに保存して起動
    jobs = get_jobs(request)
    job_id = jobs.create()
    try:
        if config_path is None:
            config_path = jobs.job_dir(job_id) / "experiment.yaml"
            config_path.write_text(body.config_text or "", encoding="utf-8")
        # 確かめの後に環境のジョブが始まった場合は起動しない. 確かめと
        # 起動は, 環境のジョブの開始と共有するロックの中で行う
        environments = request.app.state.environments
        with environments.launch_lock:
            if environments.running(project.id):
                jobs.discard(job_id)
                raise HTTPException(
                    409,
                    "学習の準備で環境に入れている間は学習を起動できません"
                )
            job = jobs.start(
                job_id, project, body.script, config_path,
                body.default_config
            )
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


@router.post(
    "/jobs/{job_id}/rerun", status_code=201,
    responses=NOT_FOUND | INSTALLING
)
def rerun_job(request: Request, job_id: str) -> JobInfo:
    """
    終わったジョブと同じスクリプトと config で, もう一度学習を起動する関数

    Parameters
    ----------
    request: Request
        リクエスト
    job_id: str
        元のジョブの ID

    Returns
    ----------
    info: JobInfo
        起動したジョブ
    """
    # 画面で書き換えた config (ジョブのディレクトリの中) は中身を, プロジェクト
    # の config はプロジェクトからの相対パスを渡し, 起動と同じ確認を通す
    job, project = load_job(request, job_id)
    if project is None:
        raise HTTPException(
            404, f"プロジェクトが見つかりません: {job.project_id}"
        )
    # 記録した default が無くなった場合は, スクリプトから選ぶ形に戻す設定
    default_config = job.default_config
    if default_config not in list_default_configs(Path(project.path)):
        default_config = None
    config = Path(job.config)
    if config.is_relative_to(get_jobs(request).job_dir(job_id)):
        if not config.is_file():
            raise HTTPException(400, f"config が見つかりません: {config}")
        body = JobCreate(
            script=job.script,
            config_text=config.read_text(encoding="utf-8"),
            default_config=default_config
        )
    elif config.is_relative_to(Path(project.path)):
        body = JobCreate(
            script=job.script,
            config_path=config.relative_to(project.path).as_posix(),
            default_config=default_config
        )
    else:
        raise HTTPException(400, f"config の場所が分かりません: {config}")
    info = create_job(request, project.id, body)

    return info


def is_inside(path: Path, root: Path) -> bool:
    """
    パスがディレクトリの中にあるかを, リンクを辿った先で確かめる関数

    Parameters
    ----------
    path: Path
        確かめるパス
    root: Path
        ディレクトリ

    Returns
    ----------
    inside: bool
        中にあるかどうか
    """
    try:
        inside = path.resolve().is_relative_to(root.resolve())
    except (OSError, RuntimeError):
        inside = False

    return inside


def find_run_experiment(
    project_dir: Path, jobs_dir: Path, experiment: str
) -> tuple[Optional[str], Path]:
    """
    実験が使った experiment の config のファイルを探す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    jobs_dir: Path
        ダッシュボードのジョブの置き場
    experiment: str
        source.yaml の experiment (プロジェクトの中なら相対パス)

    Returns
    ----------
    config_path: Optional[str]
        プロジェクトの experiment の config の一覧にあればその相対パス
    path: Path
        中身を読むファイル
    """
    # 一覧にある config は, 起動の画面でそのまま選べる形で返却
    if experiment in list_experiment_configs(project_dir):
        return experiment, project_dir / experiment

    # 画面から起動した学習の config (ジョブの置き場) とプロジェクトの
    # configs の中の他の YAML は中身だけを使用. それ以外の場所のファイルと,
    # リンクの先が YAML でないものは読まない設定
    path = Path(experiment)
    if not path.is_absolute():
        path = project_dir / path
    allowed = path.resolve().suffix in (".yaml", ".yml") and (
        is_inside(path, project_dir / "configs") or is_inside(path, jobs_dir)
    )
    if not allowed:
        raise ValueError(
            "experiment の config は, プロジェクトの configs の中か画面から"
            f"起動した学習の YAML だけを読みます: {experiment}"
        )
    if not path.is_file():
        raise ValueError(
            f"experiment の config が見つかりません: {experiment}"
        )

    return None, path


def apply_overrides(text: str, overrides: list[str]) -> str:
    """
    experiment の config の中身に「項目=値」の上書きを重ねる関数

    ML-Found の merge_experiment と同じく, 上書きでクラスを変える項目は
    experiment に書いた引数を捨てる

    Parameters
    ----------
    text: str
        experiment の config の中身
    overrides: list[str]
        「項目=値」の上書き

    Returns
    ----------
    merged: str
        上書きを重ねた YAML (元のコメントは消える)
    """
    import_ml_found()
    from ml_found.config import params_sections, parse_overrides

    loaded = OmegaConf.create(text) if text.strip() else OmegaConf.create({})
    if not isinstance(loaded, DictConfig):
        raise ValueError(
            "experiment の config が「項目: 値」の形ではありません"
        )
    override = parse_overrides(overrides)
    for section in params_sections(OmegaConf.merge(loaded, override)):
        name = OmegaConf.select(override, f"{section}.name", default=None)
        old = OmegaConf.select(loaded, f"{section}.name", default=None)
        if name is not None and name != old and OmegaConf.select(
            loaded, f"{section}.params", default=None
        ) is not None:
            OmegaConf.select(loaded, section).params = {}
    merged = OmegaConf.to_yaml(OmegaConf.merge(loaded, override))

    return merged


def newer_than(path: Path, reference: Path) -> bool:
    """
    ファイルが基準のファイルより後に書き換えられたかを確かめる関数

    Parameters
    ----------
    path: Path
        確かめるファイル
    reference: Path
        基準のファイル (実験の source.yaml)

    Returns
    ----------
    newer: bool
        後に書き換えられたかどうか, 確かめられない場合は False
    """
    try:
        newer = path.stat().st_mtime > reference.stat().st_mtime
    except OSError:
        newer = False

    return newer


class ModelSpecPlan(BaseModel):
    # もう一度起動するときのモデルの定義 (RelaunchPlan の model_spec の欄)
    path: Optional[str] = None
    text: str
    note: Optional[str] = None
    fallback: Optional[str] = None
    original: Optional[str] = None


def plan_model_spec(
    project_dir: Path, run_dir: Path, source: RunSource, text: str
) -> ModelSpecPlan:
    """
    もう一度起動するときのモデルの定義を決める関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    run_dir: Path
        実験のディレクトリ
    source: RunSource
        実験の起動のしかた
    text: str
        experiment の config の中身 (上書きを重ねたもの)

    Returns
    ----------
    plan: ModelSpecPlan
        使う写しの場所 (path), 中身 (text), 写しを使うお知らせ (note),
        写しを使わないお知らせ (fallback), 今の定義に戻す値 (original)
    """
    # model_spec の無い実験 (model.spec が無いか, 前の ML-Found) はそのまま
    spec = source.model_spec
    if spec is None:
        return ModelSpecPlan(text=text)

    # experiment の config の今の model.spec. 前に写しから起動し直した
    # 実験の config (写しの場所) は, 今の定義に戻すときに消す
    try:
        written = raw_model_spec(load_mapping(text))
    except Exception as error:
        return ModelSpecPlan(
            text=text,
            fallback=f"モデルの定義の写しを使えません: {describe(error)}"
        )
    stale = run_of_copy(project_dir, written) is not None
    original = (
        written if isinstance(written, str) and not stale else None
    )
    current = original or default_model_spec(project_dir, source.default)
    current_text = (
        str(current) if current is not None else "config の model.spec"
    )

    # 写しが使えれば model.spec をその場所に書き換え
    path, reason = find_model_spec_copy(project_dir, run_dir, spec)
    if path is not None:
        try:
            changed = set_model_spec(text, path)
        except Exception as error:
            reason = describe(error)
        else:
            return ModelSpecPlan(
                path=path, text=changed, original=original,
                note=(
                    f"モデルの定義は, この実験に写した定義 ({path}) を"
                    "使います (config の model.spec を書き換えました. 今の"
                    f"プロジェクトの {current_text} とは違うことがあります)"
                )
            )

    # 使えなければ今の定義. 写しを指す model.spec は default の値に戻す
    changed = text
    if stale:
        try:
            changed = set_model_spec(text, None)
        except Exception:
            changed = text
    same = compare_current(project_dir, current, spec.sha256)
    plan = ModelSpecPlan(
        text=changed,
        fallback=(
            f"モデルの定義は, 今のプロジェクトの {current_text} から組み立て"
            f"ます ({same}): {reason}"
        )
    )

    return plan


def plan_relaunch(
    project: Project, jobs_dir: Path, run_dir: Path
) -> RelaunchPlan:
    """
    実験の起動のしかた (source.yaml) から, もう一度起動する設定をまとめる関数

    Parameters
    ----------
    project: Project
        プロジェクト
    jobs_dir: Path
        ダッシュボードのジョブの置き場
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    plan: RelaunchPlan
        スクリプト, default と experiment の config, 起動できない理由
    """
    # 起動のしかたが分からない実験は, 理由だけを返却
    project_dir = Path(project.path)
    source = read_source(run_dir)
    if source is None:
        return RelaunchPlan(
            reason="起動のしかた (source.yaml) が記録されていない実験です"
        )
    if source.script is None:
        return RelaunchPlan(
            reason="実行したスクリプトが記録されていません (ノートブックや "
            "python -c で流した実験など)"
        )
    if source.script not in list_scripts(project_dir):
        return RelaunchPlan(
            reason=f"学習のスクリプト {source.script} がプロジェクトの学習の"
            "スクリプト (train で始まる Python のファイル) にありません"
        )
    if source.experiment is None or source.default is None:
        return RelaunchPlan(
            script=source.script,
            reason="config の読み込み方が記録されていません (ML-Found の "
            "load_config などを使わずに作った config の実験)"
        )

    # experiment の config の今の中身に, 上書きを重ねた中身
    reference = run_dir / "source.yaml"
    notes = []
    try:
        config_path, path = find_run_experiment(
            project_dir, jobs_dir, source.experiment
        )
        text = path.read_text(encoding="utf-8")
        if source.overrides:
            text = apply_overrides(text, source.overrides)
            notes.append(
                f"上書き ({' '.join(source.overrides)}) を experiment の "
                "config に重ねました (元の YAML のコメントは消えます)"
            )
        # 実験に写したモデルの定義が使えれば, model.spec をその場所に変更
        spec_plan = plan_model_spec(project_dir, run_dir, source, text)
        text = spec_plan.text
        if spec_plan.fallback is not None:
            notes.append(spec_plan.fallback)
        # 中身を渡して起動する場合だけ, 起動と同じく出力先の変更を拒否
        if config_path is None or source.overrides or spec_plan.path:
            check_output_dir(
                OmegaConf.create(text) if text.strip() else {}
            )
    except Exception as error:
        return RelaunchPlan(script=source.script, reason=describe(error))
    if newer_than(path, reference):
        notes.append(
            f"experiment の config ({source.experiment}) はこの実験の後に"
            "書き換えられています. 今の中身を使います"
        )

    # 起動の前の確認は, 実験が元にした default を使用 (無ければスクリプトから)
    default_config = None
    if source.default in list_default_configs(project_dir):
        default_config = source.default
        if newer_than(project_dir / source.default, reference):
            notes.append(
                f"default の config ({source.default}) はこの実験の後に"
                "書き換えられています"
            )
    else:
        notes.append(
            f"実験が元にした default の config ({source.default}) が "
            "configs/default に無いので, 起動の前の確認はスクリプトから選んだ "
            "default で行います"
        )
    plan = RelaunchPlan(
        script=source.script, default_config=default_config,
        config_path=config_path, config_text=text,
        model_spec=spec_plan.path, model_spec_note=spec_plan.note,
        model_spec_original=spec_plan.original, notes=notes
    )

    return plan


@router.get(RUN_PATH + "/relaunch", responses=NOT_FOUND)
def read_relaunch(
    request: Request, project_id: str, name: str, date: str, time: str
) -> RelaunchPlan:
    """
    実験と同じ設定でもう一度起動するための設定を返す関数

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
    plan: RelaunchPlan
        スクリプト, default と experiment の config, 起動できない理由
    """
    data = get_run_data(request, project_id, name, date, time)
    plan = plan_relaunch(
        get_project(request, project_id), get_jobs(request).jobs_dir,
        data.run_dir
    )

    return plan


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
    from ml_found.training import (
        describe_optimizers,
        describe_schedulers,
    )

    registry = Registry.model_validate({
        "optimizers": describe_optimizers(),
        "schedulers": describe_schedulers()
    })

    return registry
