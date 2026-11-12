import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from ml_dashboard.core.projects import (
    Project,
    ProjectError,
    get_output_dirs,
    read_output_dir,
)
from ml_dashboard.core.runs import (
    RunNotFoundError,
    find_run_dirs,
    make_run_id,
    parse_started_at,
    pid_alive,
    read_json,
    resolve_run_dir,
)

# 中断の要求として実験のディレクトリに置くファイル (ML-Found と同じ名前)
STOP_FILE = "STOP"

# 出力の末尾として返す最大の文字数
OUTPUT_TAIL = 20000

# ジョブの ID の形 (このクラスで作る 12 桁の 16 進数)
JOB_ID = re.compile(r"^[0-9a-f]{12}$")

# 学習のプロセスに引き継がない環境変数 (ダッシュボードの Python の設定)
DROPPED_ENV = ("VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME")

# 強制の中断を繰り返した回数ごとに送るシグナル
FORCE_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGKILL)

JobStatus = Literal["running", "finished"]


@dataclass
class Job:
    id: str
    project_id: str
    script: str
    config: str
    created_at: str
    pid: Optional[int]
    status: JobStatus
    return_code: Optional[int]
    run_id: Optional[str]
    finished_at: Optional[str]
    stop_requested: bool
    force_count: int = 0
    hostname: str = field(default_factory=socket.gethostname)


def now_iso() -> str:
    """
    今の日時をタイムゾーン付きの ISO 8601 の文字列で取得する関数

    Parameters
    ----------
    None

    Returns
    ----------
    now: str
        秒までの日時
    """
    now = datetime.now().astimezone().isoformat(timespec="seconds")

    return now


def is_job_id(job_id: str) -> bool:
    """
    ジョブの ID の形かを判定する関数

    Parameters
    ----------
    job_id: str
        判定する文字列

    Returns
    ----------
    valid: bool
        12 桁の 16 進数かどうか (パスの外への移動の防止)
    """
    valid = JOB_ID.match(job_id) is not None

    return valid


class JobManager:
    def __init__(self, data_dir: Path):
        # ジョブの記録と出力を置くディレクトリを保存
        self.jobs_dir = data_dir / "jobs"

        # このプロセスで起動したプロセスと, 読み書きの排他のロックを用意
        # 一覧の読み直しと中断が同時でも, 読み込みから保存までを 1 つずつ実行
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.lock = threading.RLock()

    def job_dir(self, job_id: str) -> Path:
        """
        ジョブのディレクトリを取得する関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        path: Path
            ジョブの記録, config, 出力を置くディレクトリ
        """
        path = self.jobs_dir / job_id

        return path

    def save(self, job: Job) -> None:
        """
        ジョブの記録を書き込む関数

        Parameters
        ----------
        job: Job
            保存するジョブ

        Returns
        ----------
        None
        """
        # 一時ファイルに書いてから置き換え, 書きかけを読まれないように設定
        path = self.job_dir(job.id) / "job.json"
        with tempfile.NamedTemporaryFile(
            "w", dir=path.parent, suffix=".tmp", delete=False,
            encoding="utf-8"
        ) as file:
            json.dump(asdict(job), file, ensure_ascii=False, indent=2)
        os.replace(file.name, path)

    def load(self, job_id: str) -> Optional[Job]:
        """
        ジョブの記録を読み込む関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        job: Optional[Job]
            ジョブ, 無い場合は None
        """
        if not is_job_id(job_id):
            return None

        data = read_json(self.job_dir(job_id) / "job.json")
        try:
            job = Job(**data) if data else None
        except TypeError:
            return None

        return job

    def create(self) -> str:
        """
        新しいジョブの ID とディレクトリを作る関数

        Parameters
        ----------
        None

        Returns
        ----------
        job_id: str
            12 桁の 16 進数の ID
        """
        job_id = uuid.uuid4().hex[:12]
        self.job_dir(job_id).mkdir(parents=True)

        return job_id

    def discard(self, job_id: str) -> None:
        """
        起動できなかったジョブのディレクトリを消す関数

        Parameters
        ----------
        job_id: str
            ジョブの ID

        Returns
        ----------
        None
        """
        if is_job_id(job_id):
            shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def start(
        self, job_id: str, project: Project, script: str, config_path: Path
    ) -> Job:
        """
        学習のスクリプトを別のプロセスで起動する関数

        Parameters
        ----------
        job_id: str
            create で作ったジョブの ID
        project: Project
            学習するプロジェクト
        script: str
            プロジェクトのディレクトリにある学習のスクリプトの名前
        config_path: Path
            experiment の config のパス

        Returns
        ----------
        job: Job
            起動したジョブ
        """
        # 実験との結び付けに使う開始時刻は, プロセスを作る前に記録
        created_at = now_iso()

        # ダッシュボードの Python の設定は引き継がず, 出力はバッファしない設定
        env = {
            key: value for key, value in os.environ.items()
            if key not in DROPPED_ENV
        }
        env["PYTHONUNBUFFERED"] = "1"

        # 出力はファイルに残し, Ctrl-C を送れるように別のグループで起動
        with (self.job_dir(job_id) / "output.log").open("wb") as output:
            process = subprocess.Popen(
                [project.python, script, "--experiment", str(config_path)],
                cwd=project.path, stdout=output, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=env, start_new_session=True
            )

        job = Job(
            id=job_id, project_id=project.id, script=script,
            config=str(config_path), created_at=created_at, pid=process.pid,
            status="running", return_code=None, run_id=None,
            finished_at=None, stop_requested=False
        )
        with self.lock:
            self.processes[job_id] = process
            self.save(job)

        return job

    def output_dirs(self, job: Job, project: Project) -> list[Path]:
        """
        ジョブの実験の出力先の候補を取得する関数

        Parameters
        ----------
        job: Job
            ジョブ
        project: Project
            ジョブのプロジェクト

        Returns
        ----------
        output_dirs: list[Path]
            プロジェクトの出力先と, ジョブの config で変えた出力先
        """
        output_dirs = get_output_dirs(Path(project.path))
        value = read_output_dir(Path(job.config))
        if value:
            extra = (Path(project.path) / value).resolve()
            if extra not in output_dirs:
                output_dirs.append(extra)

        return output_dirs

    def find_run(self, job: Job, project: Project) -> Optional[Path]:
        """
        ジョブの学習が作った実験のディレクトリを探す関数

        Parameters
        ----------
        job: Job
            ジョブ, 見つけた場合は run_id を記録
        project: Project
            ジョブのプロジェクト

        Returns
        ----------
        run_dir: Optional[Path]
            run.json の pid がジョブと同じ実験, 見つからない場合は None
        """
        try:
            output_dirs = self.output_dirs(job, project)
        except ProjectError:
            return None

        # 一度見つけた実験は ID からの取得
        if job.run_id is not None:
            try:
                run_dir = resolve_run_dir(output_dirs, job.run_id)
            except RunNotFoundError:
                return None
            return run_dir

        # ジョブより後に始まった実験から, 同じプロセスのものを選択
        started = job.created_at[:19]
        candidates = [
            (output_dir, run_dir)
            for output_dir, run_dir in find_run_dirs(output_dirs)[:20]
            if parse_started_at(run_dir) >= started
        ]
        for output_dir, run_dir in candidates:
            status = read_json(run_dir / "run.json")
            if status.get("pid") == job.pid:
                job.run_id = make_run_id(output_dir, run_dir)
                return run_dir

        # run.json を書かない古い ML-Found の場合は, 終わった後に限り
        # ジョブの後に始まった最初の実験と結び付け (学習中は他のジョブの可能性)
        legacy = [
            item for item in candidates
            if not (item[1] / "run.json").exists()
        ]
        if job.status == "finished" and legacy:
            output_dir, run_dir = legacy[-1]
            job.run_id = make_run_id(output_dir, run_dir)
            return run_dir

        return None

    def poll(self, job: Job) -> tuple[bool, Optional[int]]:
        """
        ジョブのプロセスが終わったかを確かめる関数

        Parameters
        ----------
        job: Job
            ジョブ

        Returns
        ----------
        finished: bool
            終わったかどうか
        return_code: Optional[int]
            終了コード, 分からない場合は None
        """
        # このプロセスで起動した場合は終了コードの取得
        process = self.processes.get(job.id)
        if process is not None:
            return_code = process.poll()
            return return_code is not None, return_code

        # ダッシュボードを起動し直した場合は, 別の端末のジョブは終了扱い
        # 同じ端末では, プロセスが残っている場合だけ実行中とみなす
        if job.hostname != socket.gethostname() or job.pid is None:
            return True, None
        if not pid_alive(job.pid):
            return True, None

        return False, None

    def refresh(self, job: Job, project: Optional[Project]) -> Job:
        """
        プロセスと実験の状態からジョブの状態を更新する関数

        Parameters
        ----------
        job: Job
            ジョブ
        project: Optional[Project]
            ジョブのプロジェクト, 登録を外した場合は None

        Returns
        ----------
        job: Job
            更新したジョブ
        """
        if job.status != "running":
            return job

        before = asdict(job)

        # プロセスが終わっていれば終了コードを記録
        finished, return_code = self.poll(job)
        if finished:
            job.status = "finished"
            job.return_code = return_code
            job.finished_at = now_iso()
            self.processes.pop(job.id, None)

        # 実験のディレクトリを探して記録
        if project is not None:
            self.find_run(job, project)

        # 変わった場合だけ保存
        if asdict(job) != before:
            self.save(job)

        return job

    def get(
        self, job_id: str, project_of: dict[str, Project]
    ) -> Optional[Job]:
        """
        ジョブを読み込んで状態を更新する関数

        Parameters
        ----------
        job_id: str
            ジョブの ID
        project_of: dict[str, Project]
            ID ごとの登録したプロジェクト

        Returns
        ----------
        job: Optional[Job]
            更新したジョブ, 無い場合は None
        """
        with self.lock:
            job = self.load(job_id)
            if job is None:
                return None
            job = self.refresh(job, project_of.get(job.project_id))

        return job

    def list_jobs(self, project_of: dict[str, Project]) -> list[Job]:
        """
        全てのジョブを新しい順に取得する関数

        Parameters
        ----------
        project_of: dict[str, Project]
            ID ごとの登録したプロジェクト

        Returns
        ----------
        jobs: list[Job]
            状態を更新したジョブ
        """
        jobs = []
        for path in self.jobs_dir.glob("*/job.json"):
            job = self.get(path.parent.name, project_of)
            if job is not None:
                jobs.append(job)
        jobs.sort(key=lambda item: item.created_at, reverse=True)

        return jobs

    def stop(
        self, job_id: str, project_of: dict[str, Project], force: bool
    ) -> Optional[Job]:
        """
        ジョブの学習を止める関数

        Parameters
        ----------
        job_id: str
            止めるジョブの ID
        project_of: dict[str, Project]
            ID ごとの登録したプロジェクト
        force: bool
            True の場合はエポックの区切りを待たずにプロセスに割り込み,
            繰り返すと SIGTERM, SIGKILL の順に強くする

        Returns
        ----------
        job: Optional[Job]
            更新したジョブ, 無い場合は None
        """
        with self.lock:
            job = self.get(job_id, project_of)
            if job is None or job.status != "running":
                return job
            project = project_of.get(job.project_id)

            # まずはエポックの区切りで止める要求を実験のディレクトリに配置
            run_dir = self.find_run(job, project) if project else None
            if run_dir is not None and not force:
                (run_dir / STOP_FILE).touch()

            # 実験が無い場合と強制の場合は, このサーバーが起動したものに限り
            # シグナルを送信 (起動し直した後の pid は別のプロセスの可能性)
            if (run_dir is None or force) and self.owns(job, run_dir):
                number = min(job.force_count, len(FORCE_SIGNALS) - 1)
                try:
                    os.killpg(job.pid or 0, FORCE_SIGNALS[number])
                except ProcessLookupError:
                    pass
                if force:
                    job.force_count += 1

            # 中断を要求した印を保存
            job.stop_requested = True
            self.save(job)

        return job

    def owns(self, job: Job, run_dir: Optional[Path]) -> bool:
        """
        ジョブのプロセスにシグナルを送ってよいかを確かめる関数

        Parameters
        ----------
        job: Job
            ジョブ
        run_dir: Optional[Path]
            ジョブの実験のディレクトリ

        Returns
        ----------
        owned: bool
            このサーバーが起動したプロセスか, 起動し直した後でも実験の
            run.json の pid とホスト名がジョブと同じで, 実行中かどうか
        """
        if job.id in self.processes:
            return True
        if run_dir is None or job.pid is None:
            return False

        status = read_json(run_dir / "run.json")
        owned = (
            status.get("status") == "running"
            and status.get("pid") == job.pid
            and status.get("hostname") == socket.gethostname()
            and pid_alive(job.pid)
        )

        return owned

    def output_tail(self, job: Job) -> str:
        """
        ジョブの標準出力の末尾を取得する関数

        Parameters
        ----------
        job: Job
            ジョブ

        Returns
        ----------
        text: str
            出力の末尾
        """
        path = self.job_dir(job.id) / "output.log"
        if not path.is_file():
            return ""

        # 大きな出力でも末尾だけの読み込み
        size = path.stat().st_size
        with path.open("rb") as file:
            file.seek(max(0, size - OUTPUT_TAIL))
            raw = file.read().decode("utf-8", errors="replace")

        # 進捗バーが \r で同じ行を書き直した分と, 端末の制御文字の除去
        raw = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw)
        lines = [
            line.rstrip("\r").rsplit("\r", 1)[-1] for line in raw.split("\n")
        ]
        text = "\n".join(lines)

        return text
