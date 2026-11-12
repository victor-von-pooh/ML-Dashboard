import json
import os
import signal
import subprocess
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from ml_dashboard.core.projects import Project, ProjectError, get_output_dirs
from ml_dashboard.core.runs import (
    RunNotFoundError,
    find_run_dirs,
    make_run_id,
    parse_started_at,
    read_json,
    resolve_run_dir,
)

# 中断の要求として実験のディレクトリに置くファイル (ML-Found と同じ名前)
STOP_FILE = "STOP"

# 出力の末尾として返す最大の文字数
OUTPUT_TAIL = 20000


@dataclass
class Job:
    id: str
    project_id: str
    script: str
    config: str
    created_at: str
    pid: Optional[int]
    status: str
    return_code: Optional[int]
    run_id: Optional[str]
    finished_at: Optional[str]
    stop_requested: bool


def now_iso() -> str:
    """
    今の日時を ISO 8601 の文字列で取得する関数

    Parameters
    ----------
    None

    Returns
    ----------
    now: str
        秒までの日時
    """
    now = datetime.now().isoformat(timespec="seconds")

    return now


class JobManager:
    def __init__(self, data_dir: Path):
        # ジョブの記録と出力を置くディレクトリを保存
        self.jobs_dir = data_dir / "jobs"

        # このプロセスで起動したプロセスと, 書き換えの排他のロックを用意
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.lock = threading.Lock()

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
        path = self.job_dir(job.id) / "job.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(asdict(job), ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        temp.replace(path)

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
        # ID はこのクラスで作る 16 進数だけを受け付け, パスの外への移動を拒否
        if not job_id.isalnum():
            return None
        data = read_json(self.job_dir(job_id) / "job.json")
        job = Job(**data) if data else None

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
            16 進数の ID
        """
        job_id = uuid.uuid4().hex[:12]
        self.job_dir(job_id).mkdir(parents=True)

        return job_id

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
        job_dir = self.job_dir(job_id)

        # 標準出力と標準エラーはファイルに残し, tqdm の進捗バーは使わない設定に
        output = (job_dir / "output.log").open("wb")
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "TQDM_DISABLE": "1"}
        process = subprocess.Popen(
            [project.python, script, "--experiment", str(config_path)],
            cwd=project.path, stdout=output, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, env=env, start_new_session=True
        )
        output.close()

        job = Job(
            id=job_id, project_id=project.id, script=script,
            config=str(config_path), created_at=now_iso(), pid=process.pid,
            status="running", return_code=None, run_id=None,
            finished_at=None, stop_requested=False
        )
        with self.lock:
            self.processes[job_id] = process
            self.save(job)

        return job

    def find_run(self, job: Job, project: Project) -> Optional[Path]:
        """
        ジョブの学習が作った実験のディレクトリを探す関数

        Parameters
        ----------
        job: Job
            ジョブ
        project: Project
            ジョブのプロジェクト

        Returns
        ----------
        run_dir: Optional[Path]
            run.json の pid がジョブと同じ実験, 見つからない場合は None
        """
        try:
            output_dirs = get_output_dirs(Path(project.path))
        except ProjectError:
            return None

        # 見つけた実験は ID から辿る
        if job.run_id is not None:
            try:
                run_dir = resolve_run_dir(output_dirs, job.run_id)
            except RunNotFoundError:
                return None
            return run_dir

        # ジョブより後に始まった新しい実験から, 同じプロセスのものを選択
        # run.json の無い古い ML-Found では, ジョブの後に始まった最初の実験
        candidates = [
            (output_dir, run_dir)
            for output_dir, run_dir in find_run_dirs(output_dirs)[:20]
            if parse_started_at(run_dir) >= job.created_at[:19]
        ]
        for output_dir, run_dir in candidates:
            status = read_json(run_dir / "run.json")
            if status.get("pid") == job.pid:
                job.run_id = make_run_id(output_dir, run_dir)
                return run_dir
        legacy = [
            item for item in candidates
            if not (item[1] / "run.json").exists()
        ]
        if legacy:
            output_dir, run_dir = legacy[-1]
            job.run_id = make_run_id(output_dir, run_dir)
            return run_dir

        return None

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

        # 実験のディレクトリを探して記録
        if project is not None:
            self.find_run(job, project)

        # プロセスが終わっていれば終了コードを記録
        return_code = self.poll(job)
        if return_code is not None:
            job.status = "finished"
            job.return_code = return_code
            job.finished_at = now_iso()
            with self.lock:
                self.processes.pop(job.id, None)
        self.save(job)

        return job

    def poll(self, job: Job) -> Optional[int]:
        """
        ジョブのプロセスが終わったかを確かめる関数

        Parameters
        ----------
        job: Job
            ジョブ

        Returns
        ----------
        return_code: Optional[int]
            終了コード, 動いている場合は None
        """
        # このプロセスで起動した場合は終了コードを取得
        process = self.processes.get(job.id)
        if process is not None:
            return_code = process.poll()
            return return_code

        # ダッシュボードを起動し直した場合は, プロセスが残っているかだけ確認
        if job.pid is not None and pid_alive(job.pid):
            return None

        return_code = -1

        return return_code

    def list(self, projects: dict[str, Project]) -> list[Job]:
        """
        全てのジョブを新しい順に取得する関数

        Parameters
        ----------
        projects: dict[str, Project]
            ID ごとの登録したプロジェクト

        Returns
        ----------
        jobs: list[Job]
            状態を更新したジョブ
        """
        jobs = []
        for path in self.jobs_dir.glob("*/job.json"):
            job = self.load(path.parent.name)
            if job is not None:
                jobs.append(self.refresh(job, projects.get(job.project_id)))
        jobs.sort(key=lambda item: item.created_at, reverse=True)

        return jobs

    def stop(self, job: Job, project: Optional[Project], force: bool) -> Job:
        """
        ジョブの学習を止める関数

        Parameters
        ----------
        job: Job
            止めるジョブ
        project: Optional[Project]
            ジョブのプロジェクト
        force: bool
            True の場合はエポックの区切りを待たずにプロセスに割り込む

        Returns
        ----------
        job: Job
            更新したジョブ
        """
        job = self.refresh(job, project)
        if job.status != "running":
            return job

        # まずはエポックの区切りで止める要求を実験のディレクトリに置く
        run_dir = self.find_run(job, project) if project else None
        if run_dir is not None and not force:
            (run_dir / STOP_FILE).touch()

        # 実験がまだ無い場合と強制の場合は, Ctrl-C と同じ割り込みを送る
        if (run_dir is None or force) and job.pid is not None:
            try:
                os.killpg(job.pid, signal.SIGINT)
            except ProcessLookupError:
                pass

        job.stop_requested = True
        self.save(job)

        return job

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

        # 大きな出力でも末尾だけを読む
        size = path.stat().st_size
        with path.open("rb") as file:
            file.seek(max(0, size - OUTPUT_TAIL))
            text = file.read().decode("utf-8", errors="replace")

        return text


def pid_alive(pid: int) -> bool:
    """
    プロセスが動いているかを確かめる関数

    Parameters
    ----------
    pid: int
        プロセスの ID

    Returns
    ----------
    alive: bool
        動いているかどうか
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    alive = True

    return alive
