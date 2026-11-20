import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

from omegaconf import OmegaConf

from ml_dashboard.core.jobs import child_env, now_iso, output_tail
from ml_dashboard.core.loader import import_ml_found
from ml_dashboard.core.models import (
    ConfigPath,
    EnvironmentJob,
    ProjectReadiness,
    Requirement,
)
from ml_dashboard.core.projects import DEFAULT_CONFIG, Project, ProjectStore
from ml_dashboard.core.requirements import (
    REPORT_CACHE,
    check_requirements,
    read_requires,
)
from ml_dashboard.core.runs import read_json

# プロジェクトの中に作る仮想環境
VENV_DIR = ".venv"

# config で, データセットとモデルの定義のパスを書く項目
DATASET_KEY = "data.dataset"
MODEL_SPEC_KEY = "model.spec"

# プロジェクトに ML-Found を submodule で置く場合のディレクトリ
FOUND_SUBMODULE = "ML-Found"


def venv_python(project_dir: Path) -> Path:
    """
    プロジェクトの .venv の Python のパスを返す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    python: Path
        .venv/bin/python (無くてもパスを返す)
    """
    python = project_dir / VENV_DIR / "bin" / "python"

    return python


def target_python(project: Project) -> tuple[str, bool]:
    """
    確かめて入れる先の Python を決める関数

    登録した Python がプロジェクトの .venv の中か, ダッシュボード自身の
    Python (仮想環境が見つからなかった場合) ならプロジェクトの .venv を
    使う. 利用者が選んだ他の環境 (上の階層の仮想環境など) はそのまま使う

    Parameters
    ----------
    project: Project
        登録したプロジェクト

    Returns
    ----------
    python: str
        入れる先の Python
    managed: bool
        プロジェクトの .venv の場合は True
    """
    venv_dir = Path(project.path) / VENV_DIR
    registered = project.python
    inside = registered.startswith(str(venv_dir) + os.sep)
    if inside or registered == sys.executable:
        # .venv/bin/python3 などを登録した場合はそのまま使う
        python = registered if inside else str(
            venv_python(Path(project.path))
        )
        managed = True
        return python, managed
    python = registered
    managed = False

    return python, managed


def read_config_path(cfg: Any, key: str, project_dir: Path) -> ConfigPath:
    """
    config に書いたパスを読み, プロジェクトから辿った先があるかを確かめる
    関数

    Parameters
    ----------
    cfg: Any
        default の config (DictConfig)
    key: str
        項目の名前 (data.dataset など)
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    status: ConfigPath
        書いた値, 辿った先, あるか. 書いていない場合は値が None
    """
    # 値の参照も学習と同じく解決. 必須の印 (???) は書いていない扱い
    try:
        value = OmegaConf.select(
            cfg, key, throw_on_resolution_failure=True
        )
    except Exception as error:
        status = ConfigPath(key=key, error=f"{key} を読めません: {error}")
        return status
    if value is None:
        status = ConfigPath(key=key)
        return status
    if not isinstance(value, str) or not value.strip():
        status = ConfigPath(
            key=key, value=str(value),
            error=f"{key} はパスの文字で書いてください: {value!r}"
        )
        return status

    # 相対パスはプロジェクトのディレクトリから辿り, ~ はホームに展開
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = project_dir / path
    status = ConfigPath(
        key=key, value=value, path=str(path), exists=path.exists()
    )

    return status


def known_requirements() -> dict[str, str]:
    """
    ダッシュボードの ML-Found の登録簿の機能と入れ方の種類を返す関数

    Parameters
    ----------
    None

    Returns
    ----------
    kinds: dict[str, str]
        機能の名前ごとの入れ方の種類 (pip か guide)
    """
    import_ml_found()
    from ml_found import describe_requirements

    kinds = {
        entry["name"]: entry["install"]["kind"]
        for entry in describe_requirements(check=False)
    }

    return kinds


def found_package(project_dir: Path) -> list[str]:
    """
    ML-Found 自身を入れる pip の引数を返す関数

    プロジェクトが ML-Found を submodule で持つ場合は, 固定した版を
    そのまま使うようにそのディレクトリを -e で入れる (ML-Found の README
    の導入と同じ). 無ければ git の main

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    arguments: list[str]
        pip install に渡す引数
    """
    submodule = project_dir / FOUND_SUBMODULE
    if (submodule / "pyproject.toml").is_file():
        arguments = ["-e", str(submodule)]
        return arguments
    import_ml_found()
    from ml_found import environment_packages

    arguments = [str(item) for item in environment_packages([])]

    return arguments


def venv_command(project_dir: Path, uv: Optional[str]) -> list[str]:
    """
    プロジェクトの .venv を作るコマンドを返す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    uv: Optional[str]
        uv のパス, 無ければ None

    Returns
    ----------
    command: list[str]
        引数のリスト
    """
    # 端末から pip も使えるように, uv でも pip を入れる (--seed)
    venv_dir = str(project_dir / VENV_DIR)
    if uv is not None:
        command = [
            uv, "venv", "--seed", "--python", sys.executable, venv_dir
        ]
        return command
    command = [sys.executable, "-m", "venv", venv_dir]

    return command


def install_command(
    python: str, arguments: list[str], uv: Optional[str]
) -> list[str]:
    """
    入れる先の Python に pip で入れるコマンドを返す関数

    Parameters
    ----------
    python: str
        入れる先の Python
    arguments: list[str]
        pip install に渡す引数
    uv: Optional[str]
        uv のパス, 無ければ None

    Returns
    ----------
    command: list[str]
        引数のリスト
    """
    if uv is not None:
        command = [uv, "pip", "install", "--python", python, *arguments]
        return command
    command = [python, "-m", "pip", "install", *arguments]

    return command


def reinstall_arguments(project_dir: Path, uv: Optional[str]) -> list[str]:
    """
    古い版の ML-Found を入れ直す pip の引数を返す関数

    git の main は版の番号が変わらないので, 入っていても入れ直す. 他の
    パッケージは入れ直さない

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    uv: Optional[str]
        uv のパス, 無ければ None

    Returns
    ----------
    arguments: list[str]
        pip install に渡す引数
    """
    if uv is not None:
        arguments = ["--reinstall-package", "ml-found"]
    else:
        arguments = ["--force-reinstall", "--no-deps"]
    arguments += found_package(project_dir)

    return arguments


def find_uv() -> Optional[str]:
    """
    uv のコマンドを探す関数

    Parameters
    ----------
    None

    Returns
    ----------
    uv: Optional[str]
        uv のパス, 無ければ None
    """
    uv = shutil.which("uv")

    return uv


def check_readiness(
    project: Project, refresh: bool = False
) -> ProjectReadiness:
    """
    プロジェクトの学習の準備 (データセット, モデルの定義, 環境) を
    確かめる関数

    Parameters
    ----------
    project: Project
        登録したプロジェクト
    refresh: bool = False
        覚えた確かめの結果を使わずに確かめ直す場合は True

    Returns
    ----------
    readiness: ProjectReadiness
        確かめた結果と, 環境を作るか足りないものを入れるコマンド
    """
    project_dir = Path(project.path)

    # default の config のデータセット, モデルの定義, requires
    requires: list[str] = []
    requires_error = None
    model_spec = None
    try:
        cfg = OmegaConf.load(project_dir / DEFAULT_CONFIG)
    except Exception as error:
        dataset = ConfigPath(
            key=DATASET_KEY, error=f"default の config を読めません: {error}"
        )
    else:
        dataset = read_config_path(cfg, DATASET_KEY, project_dir)
        spec = read_config_path(cfg, MODEL_SPEC_KEY, project_dir)
        model_spec = spec if spec.value is not None or spec.error else None
        requires, requires_error = read_requires(cfg)

    # 入れる先の Python があれば, その Python で登録簿を確かめる
    python, managed = target_python(project)
    exists = Path(python).is_file()
    ml_found: Optional[bool] = None
    check_error = None
    available: dict[str, Optional[bool]] = {}
    manual: list[Requirement] = []
    if exists:
        report = check_requirements(python, project_dir, refresh=refresh)
        ml_found = report.ml_found
        check_error = None if ml_found is False else report.error
        available = {item.name: item.available for item in report.requirements}
        manual = [
            item for item in report.requirements
            if item.name in requires and item.available is False
            and item.install.kind != "pip"
        ]

    # 入れるもの. ML-Found が無い (か確かめられない) 環境には全てを入れる
    kinds = known_requirements()
    unknown = [name for name in requires if name not in kinds]
    pip_names = [name for name in requires if kinds.get(name) == "pip"]
    outdated: list[str] = []
    if exists and ml_found is True:
        missing = [
            name for name in requires
            if name in kinds and available.get(name) is False
        ]
        to_install = [name for name in missing if name in pip_names]

        # 入れた ML-Found の登録簿に無い名前は, 古い版なので確かめられない
        outdated = [
            name for name in requires
            if name in kinds and name not in available
        ]
    else:
        missing = [name for name in requires if name in kinds]
        to_install = pip_names
    arguments: list[str] = []
    if not exists or ml_found is not True:
        arguments += found_package(project_dir)
    if to_install:
        import_ml_found()
        from ml_found import environment_packages

        arguments += [
            str(item)
            for item in environment_packages(to_install, include_found=False)
        ]

    # 作れるのはプロジェクトの .venv だけ. 他の環境が無い場合は入れない
    uv = find_uv()
    commands = []
    if not exists and managed:
        commands.append(venv_command(project_dir, uv))
    if arguments and (exists or managed):
        commands.append(install_command(python, arguments, uv))
    if outdated:
        commands.append(install_command(
            python, reinstall_arguments(project_dir, uv), uv
        ))

    # config にデータセットを書いていないプロジェクトは, 場所を確かめない
    ready = (
        dataset.exists is not False and dataset.error is None
        and (model_spec is None or model_spec.exists is True)
        and exists and ml_found is True and not missing and not outdated
        and requires_error is None
        and project.python == python
    )
    readiness = ProjectReadiness(
        dataset=dataset, model_spec=model_spec, python=project.python,
        target_python=python, managed=managed, environment_exists=exists,
        ml_found=ml_found, requires=requires, missing=missing,
        manual=manual, unknown=unknown, outdated=outdated,
        requires_error=requires_error,
        check_error=check_error, installer="uv" if uv else "venv",
        commands=commands, ready=ready,
        switch_python=managed and project.python != python
    )

    return readiness


class EnvironmentJobs:
    def __init__(self, data_dir: Path, store: ProjectStore):
        # ジョブの記録と出力を置くディレクトリと, 登録したプロジェクト
        self.root = data_dir / "environments"
        self.store = store

        # このプロセスで動かしているジョブのスレッドと, 排他のロック
        self.threads: dict[str, threading.Thread] = {}
        self.starting: set[str] = set()
        self.lock = threading.Lock()

        # 学習の起動と環境のジョブの開始で共有するロック. 相手が動いて
        # いないことの確かめと, 始める印か起動を 1 つにまとめ, 入れ違いで
        # 両方が始まらないようにするため
        self.launch_lock = threading.Lock()

    def job_dir(self, project_id: str) -> Path:
        """
        プロジェクトの環境のジョブのディレクトリを返す関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID (登録簿が作る URL に使える文字)

        Returns
        ----------
        path: Path
            job.json と output.log を置くディレクトリ
        """
        path = self.root / project_id

        return path

    def save(self, job: EnvironmentJob) -> None:
        """
        ジョブの記録を書き込む関数 (出力の末尾は書かない)

        Parameters
        ----------
        job: EnvironmentJob
            ジョブ

        Returns
        ----------
        None
        """
        directory = self.job_dir(job.project_id)
        directory.mkdir(parents=True, exist_ok=True)
        data = job.model_dump(exclude={"output"})
        with tempfile.NamedTemporaryFile(
            "w", dir=directory, suffix=".tmp", delete=False,
            encoding="utf-8"
        ) as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
        os.replace(file.name, directory / "job.json")

    def get(self, project_id: str) -> Optional[EnvironmentJob]:
        """
        プロジェクトの最後の環境のジョブを読む関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID

        Returns
        ----------
        job: Optional[EnvironmentJob]
            出力の末尾を付けたジョブ, 無い場合は None
        """
        # 終わりの書き込みと入れ違わないように, ロックの中で読む
        directory = self.job_dir(project_id)
        job = None
        with self.lock:
            data = read_json(directory / "job.json")
            if not data:
                return job
            try:
                job = EnvironmentJob.model_validate(data)
            except ValueError:
                return job

            # 動かしたスレッドが居ない実行中のジョブは, 見届けられないもの
            if job.status == "running" and not self.running(project_id):
                job.status = "interrupted"
                self.save(job)
        job.output = output_tail(directory / "output.log")

        return job

    def running(self, project_id: str) -> bool:
        """
        プロジェクトの環境のジョブがこのプロセスで動いているかを返す関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID

        Returns
        ----------
        alive: bool
            動いている (か始めている) 場合は True
        """
        thread = self.threads.get(project_id)
        alive = project_id in self.starting or (
            thread is not None and thread.is_alive()
        )

        return alive

    def start(
        self, project: Project, commands: list[list[str]],
        training: Optional[Callable[[str], bool]] = None
    ) -> EnvironmentJob:
        """
        確かめた結果のコマンドを, 別のスレッドで順に動かす関数

        Parameters
        ----------
        project: Project
            登録したプロジェクト
        commands: list[list[str]]
            利用者が確かめたコマンド (今の確かめの結果と同じものだけ)
        training: Optional[Callable[[str], bool]] = None
            プロジェクトの ID から, 学習のジョブが動いているかを返す関数

        Returns
        ----------
        job: EnvironmentJob
            始めたジョブ

        Raises
        ----------
        RuntimeError
            環境のジョブか学習のジョブが動いている場合
        """
        # 確かめは時間がかかるので, 学習が動いていないことの確かめと始める
        # 印だけを, 学習の起動と共有するロックの中で行う
        with self.launch_lock:
            if training is not None and training(project.id):
                raise RuntimeError(
                    "学習が動いている間は環境に入れられません. 学習が"
                    "終わるか止めてから入れてください"
                )
            with self.lock:
                if self.running(project.id):
                    raise RuntimeError("環境のジョブが動いています")
                self.starting.add(project.id)
        try:
            # 利用者が確かめた後に結果が変わった場合は動かさない
            readiness = check_readiness(project, refresh=True)
            if not readiness.commands and not readiness.switch_python:
                raise ValueError("入れるものがありません")
            if readiness.commands != commands:
                raise LookupError(
                    "確かめた後に入れるものが変わりました. 確かめ直して"
                    "ください"
                )
            job = EnvironmentJob(
                project_id=project.id, status="running",
                started_at=now_iso(), commands=commands
            )
            with self.lock:
                self.save(job)
                (self.job_dir(project.id) / "output.log").write_bytes(b"")
                thread = threading.Thread(
                    target=self.run,
                    args=(job, project, readiness.managed,
                          readiness.target_python),
                    daemon=True
                )
                self.threads[project.id] = thread
                thread.start()
        finally:
            with self.lock:
                self.starting.discard(project.id)

        return job

    def run(
        self, job: EnvironmentJob, project: Project, managed: bool,
        python: str
    ) -> None:
        """
        コマンドを順に動かし, 出力をファイルに残す関数 (スレッドで動く)

        Parameters
        ----------
        job: EnvironmentJob
            ジョブ
        project: Project
            登録したプロジェクト
        managed: bool
            入れる先がプロジェクトの .venv か
        python: str
            入れる先の Python

        Returns
        ----------
        None
        """
        path = self.job_dir(project.id) / "output.log"
        return_code: Optional[int] = None
        succeeded = False
        try:
            return_code = self.run_commands(job, project, path)
            succeeded = return_code == 0

            # 作った .venv を学習に使う Python にする
            if succeeded and managed and project.python != python:
                moved = self.store.set_python(project.id, python)
                if moved is None:
                    raise ValueError("プロジェクトの登録が外されました")
        except Exception as error:
            succeeded = False
            with path.open("ab") as output:
                output.write(f"{type(error).__name__}: {error}\n".encode())
        finally:
            # 途中の確かめの結果を捨て, 終わりを記録
            REPORT_CACHE.forget(python)
            job.status = "succeeded" if succeeded else "failed"
            job.return_code = return_code
            job.finished_at = now_iso()
            with self.lock:
                self.save(job)

    def run_commands(
        self, job: EnvironmentJob, project: Project, path: Path
    ) -> int:
        """
        コマンドを順に動かし, 失敗したところで止める関数

        Parameters
        ----------
        job: EnvironmentJob
            ジョブ
        project: Project
            登録したプロジェクト
        path: Path
            出力を書くファイル

        Returns
        ----------
        return_code: int
            最後に動かしたコマンドの終了コード (無ければ 0)
        """
        return_code = 0
        with path.open("ab") as output:
            for command in job.commands:
                output.write(f"$ {' '.join(command)}\n".encode())
                output.flush()
                return_code = subprocess.call(
                    command, cwd=project.path, stdout=output,
                    stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    env=child_env()
                )
                if return_code != 0:
                    break

        return return_code
