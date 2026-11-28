import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
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
from ml_dashboard.core.run_files import open_plain, replace_with_plain
from ml_dashboard.core.runs import (
    RunNotFoundError,
    find_run_dirs,
    make_run_id,
    parse_started_at,
    pid_alive,
    process_started,
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

# ジョブの開始の時刻から, そのジョブのプロセスが始まるまでに許す秒数
# (開始の時刻はプロセスを作る直前に取るので本物は直後に始まり, 時計の
# 合わせ直しで ps の時刻がずれても本物を外さない幅)
JOB_START_SLACK_SEC = 60.0

# pid を使い回したと読んだ学習中のジョブを, 実験の記録が変わらないまま
# 終わったものにするまでの秒数 (ML-Found はバッチごとに進み具合を書き直す
# ので, 本物は 1 バッチなどの 1 つの処理がこれを超えない限り書く)
JOB_STALL_SEC = 3600.0

# 学習の記録が止まったかを数える間に, 読み直しの間が空いたら数え直す秒数
# (プロセスや VM の一時停止の後, 再開して最初に読んだ 1 回で決めないため)
JOB_STALL_GAP_SEC = 300.0

# 学習中に ML-Found が書き直す実験の記録 (どれかが変われば学習は生きている)
LIVE_FILES = ("progress.json", "run.json", "train.log")

# 学習の後の処理の間に ML-Found が書き直す心拍のファイル
HEARTBEAT_FILE = "heartbeat.json"

# 心拍の連番が変わらないまま後の処理が止まったとみなす, 書き直す間隔の
# 倍数 (ML-Found の約束の目安. GIL を離さない処理などで遅れる分の余裕)
HEARTBEAT_STALL_FACTOR = 6

# 心拍の書き直す間隔として使う最小の秒数 (心拍のファイルに短い間隔が
# 書かれても, 目安を GIL やディスクの遅れより短くしないため)
HEARTBEAT_MIN_INTERVAL = 1.0

# 心拍で後の処理を終えたかを決める run.json の状態 (ML-Found が fit を
# この状態で終えたときに心拍を書き始める)
POST_STATES = ("completed", "stopped")

# 実験の記録のファイルごとの (i-node, 大きさ, 更新の時刻), 無ければ None
RunStamp = tuple[Optional[tuple[int, int, int]], ...]

JobStatus = Literal["running", "finished"]


def child_env() -> dict[str, str]:
    """
    プロジェクトの Python で動かすプロセスの環境変数を作る関数

    ダッシュボードの Python の設定 (仮想環境, PYTHONPATH) を引き継がない.
    学習と追加の依存の確かめで同じ環境にするため

    Parameters
    ----------
    None

    Returns
    ----------
    env: dict[str, str]
        環境変数 (出力はバッファしない設定)
    """
    env = {
        key: value for key, value in os.environ.items()
        if key not in DROPPED_ENV
    }
    env["PYTHONUNBUFFERED"] = "1"

    return env


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
    # 起動の前の確認に使った default の config (プロジェクトからの相対パス).
    # None はスクリプトから選んだもの
    default_config: Optional[str] = None
    # 起動の時刻から pid の使い回しと一度でも読んだか (読んだ後は, 起動の
    # 時刻を読めないときにシグナルを送らない. 起動し直しても残すので記録に
    # 置き, 消さない)
    pid_reused: bool = False


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


class JobSignalError(Exception):
    # ジョブのプロセスにシグナルを送れなかった誤り
    pass


def same_process(job: Job) -> Optional[bool]:
    """
    ジョブの pid のプロセスが, ジョブが起動したプロセスかを確かめる関数

    ダッシュボードを起動し直した後は, 記録の pid を別のプロセスが使い回して
    いる場合があるので, プロセスが始まった時刻とジョブの開始の時刻を比べる

    Parameters
    ----------
    job: Job
        ジョブ

    Returns
    ----------
    same: Optional[bool]
        プロセスがジョブの開始の時刻から JOB_START_SLACK_SEC より後に
        始まっていれば, 終わった後に pid を使い回した別のプロセスとして
        False, それ以外は True (本物の pid は本物が終わった後にしか
        使い回されないので, 前に始まったと読める場合 (夏時間の重なり, 時計の
        戻り) も本物を終わったものにしない).
        確かめられない場合 (別の端末のジョブ, 起動の時刻を読めない環境,
        居ないプロセス, 開始の時刻を読めない記録) は None
    """
    if job.pid is None or job.hostname != socket.gethostname():
        return None
    started = process_started(job.pid)
    try:
        created = datetime.fromisoformat(job.created_at)
    except ValueError:
        return None
    if started is None or created.tzinfo is None:
        return None

    # ジョブの開始の時刻から幅を超えて後に始まったものだけを別のものに判定
    gap = (started - created).total_seconds()
    same = gap <= JOB_START_SLACK_SEC

    return same


def post_end(run_dir: Path) -> Optional[datetime]:
    """
    実験の学習の後の処理が終わった時刻を取得する関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    ended: Optional[datetime]
        心拍の ended_at か, 無ければ run.json の finished_at を, 実験の
        ディレクトリの名前と同じ形 (学習のプロセスの時刻帯の壁時計のまま,
        時刻帯の無い秒までの時刻) にしたもの. どちらも読めない場合は None.
        ML-Found は名前を学習のプロセスの時刻帯の今の時刻で付け, 時刻も
        その時刻帯で書くので, 時刻帯を除くだけで名前と比べられる
        (ダッシュボードと時刻帯が違っても)
    """
    for name, key in (
        (HEARTBEAT_FILE, "ended_at"), ("run.json", "finished_at")
    ):
        value = read_json(run_dir / name).get(key)
        if not isinstance(value, str):
            continue
        try:
            moment = datetime.fromisoformat(value)
        except ValueError:
            continue
        return moment.replace(tzinfo=None, microsecond=0)

    return None


def run_stamp(run_dir: Path) -> RunStamp:
    """
    学習中に ML-Found が書き直す実験の記録の状態を取得する関数

    ML-Found は progress.json と run.json を一時ファイルからの置き換えで
    書く (書くたびに i-node が変わる). train.log は書き足す (大きさと
    更新の時刻が変わる). 時刻の値は比べずに変わったかだけを見るのに使う

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    stamp: RunStamp
        LIVE_FILES の順の (i-node, 大きさ, 更新の時刻), 無いか読めない
        ファイルは None (リンクは辿らない)
    """
    stamps: list[Optional[tuple[int, int, int]]] = []
    for name in LIVE_FILES:
        try:
            info = os.lstat(run_dir / name)
        except OSError:
            stamps.append(None)
            continue
        stamps.append((info.st_ino, info.st_size, info.st_mtime_ns))
    stamp = tuple(stamps)

    return stamp


class JobManager:
    def __init__(self, data_dir: Path):
        # ジョブの記録と出力を置くディレクトリを保存
        self.jobs_dir = data_dir / "jobs"

        # このプロセスで起動したプロセスと, 読み書きの排他のロックを用意
        # 一覧の読み直しと中断が同時でも, 読み込みから保存までを 1 つずつ実行
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.lock = threading.RLock()

        # pid を使い回したと読んだ学習中のジョブごとの, 最後に変わったと
        # 見た実験の記録, そのときと前に読んだときの単調な時計 (休止と時計の
        # 合わせ直しで進まない. 起動し直すと比べられないのでメモリだけに保持)
        self.stalls: dict[str, tuple[RunStamp, float, float]] = {}
        self.clock = time.monotonic

        # 起動の時刻を読めない学習の後の処理中のジョブごとの, 最後に変わった
        # と見た心拍の連番, そのときと前に読んだときの単調な時計
        # (stalls と同じくメモリだけに保持)
        self.beats: dict[str, tuple[int, float, float]] = {}

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
        self, job_id: str, project: Project, script: str, config_path: Path,
        default_config: Optional[str] = None
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
        default_config: Optional[str] = None
            起動の前の確認に使った default の config, None はスクリプトから
            選んだもの

        Returns
        ----------
        job: Job
            起動したジョブ
        """
        # 実験との結び付けに使う開始時刻は, プロセスを作る前に記録
        created_at = now_iso()

        # ダッシュボードの Python の設定は引き継がず, 出力はバッファしない設定
        env = child_env()

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
            finished_at=None, stop_requested=False,
            default_config=default_config
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

        # run.json を書かない版の ML-Found の場合は, 終わった後に限り
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

    def poll(
        self, job: Job, run_dir: Optional[Path] = None,
        project: Optional[Project] = None
    ) -> tuple[bool, Optional[int]]:
        """
        ジョブのプロセスが終わったかを確かめる関数

        Parameters
        ----------
        job: Job
            ジョブ
        run_dir: Optional[Path] = None
            ジョブの実験のディレクトリ, 見つからない場合は None
        project: Optional[Project] = None
            ジョブのプロジェクト (心拍で終えたと読んだジョブが, 同じ
            プロセスで次の学習を続けていないかを出力先で確かめる),
            分からない場合は None

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

        # pid を別のプロセスが使い回していれば終了扱い. ただし実験の run.json
        # が実行中なら, 学習の記録が止まったと分かるまで実行中のまま (時計の
        # 合わせ直しで ps の時刻がずれた本物を終わったものにすると戻せない
        # ため). 確かめられない場合は, 学習の後の処理の心拍が終えたか止まった
        # と分かり, 同じプロセスが次の学習を続けていないときだけ終了扱い
        # (心拍が無ければ実行中のまま)
        same = self.check_process(job)
        status = read_json(run_dir / "run.json") if run_dir else {}
        if same is not False:
            self.stalls.pop(job.id, None)
            if (
                same is None and run_dir is not None and project is not None
                and status.get("status") in POST_STATES
                and self.post_ended(job, run_dir)
                and not self.continued(job, run_dir, project)
            ):
                return True, None
            if same is True or status.get("status") not in POST_STATES:
                self.beats.pop(job.id, None)
            return False, None
        if status.get("status") != "running":
            return True, None
        if run_dir is not None and self.stalled(job, run_dir):
            return True, None

        return False, None

    def check_process(self, job: Job) -> Optional[bool]:
        """
        ジョブの pid のプロセスが, ジョブが起動したプロセスかを確かめ,
        使い回しと読んだらジョブに印を付ける関数

        印は消さない. pid は本物が終わった後にしか使い回されないので,
        使い回しと読んだ後に本物へ戻ることは無いため (同じプロセスと読めた
        ときは印に関わらず送れるので, 消さなくても本物を止められる)

        印を書き換えるのはロックの中の読み直し (poll. refresh が保存し,
        中断も中で読み直す) だけ. owns は印を書き換えず判定だけをする

        Parameters
        ----------
        job: Job
            ジョブ (使い回しと読んだら pid_reused を True にする. 保存は
            呼ぶ側が行う)

        Returns
        ----------
        same: Optional[bool]
            same_process の結果
        """
        same = same_process(job)
        if same is False:
            job.pid_reused = True

        return same

    def stalled(self, job: Job, run_dir: Path) -> bool:
        """
        pid を使い回したと読んだ学習中のジョブの, 実験の記録が止まったかを
        確かめる関数

        記録の時刻の値は時計に頼るので比べず, ダッシュボードの単調な時計で
        記録が変わらない間の長さを測る. 読み直しの間が JOB_STALL_GAP_SEC
        以上空いた場合は, 一時停止から再開した直後の 1 回で決めないように
        数え直す

        Parameters
        ----------
        job: Job
            ジョブ
        run_dir: Path
            ジョブの実験のディレクトリ

        Returns
        ----------
        stalled: bool
            学習中に ML-Found が書き直す記録が, どれも変わらないまま
            JOB_STALL_SEC 以上たったかどうか. 初めて見た場合, 前に見た
            ときから変わった場合, 前に読んでから JOB_STALL_GAP_SEC 以上
            空いた場合は, そこから数え直して False
        """
        stamp = run_stamp(run_dir)
        now = self.clock()
        seen = self.stalls.get(job.id)
        if (
            seen is None or seen[0] != stamp
            or now - seen[2] >= JOB_STALL_GAP_SEC
        ):
            self.stalls[job.id] = (stamp, now, now)
            return False
        self.stalls[job.id] = (stamp, seen[1], now)
        stalled = now - seen[1] >= JOB_STALL_SEC

        return stalled

    def post_ended(self, job: Job, run_dir: Path) -> bool:
        """
        起動の時刻を読めない学習の後の処理中のジョブの, 後の処理を終えたか
        止まったかを心拍のファイルから確かめる関数

        stalled と同じく, 心拍の時刻の値は比べず, ダッシュボードの単調な
        時計で連番が変わらない間の長さを測る. 読み直しの間が
        JOB_STALL_GAP_SEC 以上空いた場合は数え直す

        Parameters
        ----------
        job: Job
            ジョブ
        run_dir: Path
            ジョブの実験のディレクトリ

        Returns
        ----------
        ended: bool
            心拍の pid とホスト名がジョブと同じで, 状態が ended か,
            running のまま連番が変わらずに interval_sec の
            HEARTBEAT_STALL_FACTOR 倍以上たったかどうか. 心拍のファイルが
            無い, 読めない, 形が違う場合は False. 間隔は
            HEARTBEAT_MIN_INTERVAL より短く数えない
        """
        heartbeat = read_json(run_dir / HEARTBEAT_FILE)
        state = heartbeat.get("state")
        beat = heartbeat.get("beat")
        interval = heartbeat.get("interval_sec")
        if not (
            heartbeat.get("pid") == job.pid
            and heartbeat.get("hostname") == job.hostname
            and state in ("running", "ended")
        ):
            self.beats.pop(job.id, None)
            return False

        # 終えた心拍は, 後の処理を終えた後にしか書かれない (成否は表さない)
        if state == "ended":
            return True

        # 連番と間隔の形を確かめてから, 連番が変わらない間の長さの計測
        if (
            not isinstance(beat, int) or isinstance(beat, bool)
            or not isinstance(interval, (int, float))
            or isinstance(interval, bool)
            or not math.isfinite(interval) or interval <= 0
        ):
            self.beats.pop(job.id, None)
            return False
        now = self.clock()
        seen = self.beats.get(job.id)
        if (
            seen is None or seen[0] != beat
            or now - seen[2] >= JOB_STALL_GAP_SEC
        ):
            self.beats[job.id] = (beat, now, now)
            return False
        self.beats[job.id] = (beat, seen[1], now)
        limit = max(interval, HEARTBEAT_MIN_INTERVAL) * HEARTBEAT_STALL_FACTOR
        ended = now - seen[1] >= limit

        return ended

    def continued(self, job: Job, run_dir: Path, project: Project) -> bool:
        """
        ジョブのプロセスが, ジョブの実験の後に同じプロセスで次の学習か
        後の処理を続けているかを確かめる関数

        ML-Found は同じプロセスで次の start_experiment か fit を始めると,
        前の実験の心拍を ended にする. そのため心拍で終えたと読んだ後も,
        出力先の新しい実験を見て, 同じプロセスのものが動いていれば続けて
        いるとする. ML-Found は start_experiment で実験のディレクトリと
        config.yaml を作り, run.json は fit の中で書くので, その間 (データの
        読み込み, モデルの作成など) の実験は run.json も心拍も持たない

        Parameters
        ----------
        job: Job
            ジョブ
        run_dir: Path
            ジョブの実験のディレクトリ
        project: Project
            ジョブのプロジェクト

        Returns
        ----------
        active: bool
            ジョブの実験より新しい実験 (新しい順の先頭 20 件まで) のうち,
            run.json の pid とホスト名がジョブと同じで状態が実行中か,
            心拍の pid とホスト名がジョブと同じで running のものか,
            run.json も心拍も無く (同じプロセスの準備中かもしれない), 名前の
            時刻がジョブの実験の終わり (post_end の時刻) 以降のものがあるか.
            出力先を読めない場合は True (終わったものにしない)
        """
        ended = post_end(run_dir)
        try:
            output_dirs = self.output_dirs(job, project)
        except ProjectError:
            return True

        # 新しい順に, ジョブの実験に着くまでの実験を確認
        current = run_dir.resolve()
        for _, other in find_run_dirs(output_dirs)[:20]:
            if other.resolve() == current:
                break
            for name, key, value in (
                ("run.json", "status", "running"),
                (HEARTBEAT_FILE, "state", "running")
            ):
                data = read_json(other / name)
                if (
                    data.get("pid") == job.pid
                    and data.get("hostname") == job.hostname
                    and data.get(key) == value
                ):
                    return True

            # run.json も心拍も無い実験は, ジョブの実験が終わった後に
            # 作られたものだけを準備中とみなす (前からの残りを拾わないため)
            if any(
                os.path.lexists(other / name)
                for name in ("run.json", HEARTBEAT_FILE)
            ):
                continue
            try:
                started = datetime.fromisoformat(parse_started_at(other))
            except ValueError:
                continue
            if ended is None or started >= ended:
                return True

        return False

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

        # 実験のディレクトリを探して記録 (プロセスの確かめに run.json を使用)
        run_dir = self.find_run(job, project) if project else None

        # プロセスが終わっていれば終了コードを記録
        finished, return_code = self.poll(job, run_dir, project)
        if finished:
            job.status = "finished"
            job.return_code = return_code
            job.finished_at = now_iso()
            self.processes.pop(job.id, None)
            self.stalls.pop(job.id, None)
            self.beats.pop(job.id, None)

            # run.json を書かない版の実験は終わった後に結び付け
            if project is not None and run_dir is None:
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
        self, job_id: str, project_of: dict[str, Project], force: bool,
        now: bool = False
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
        now: bool = False
            True の場合は STOP に now と書き, ML-Found にエポックの途中でも
            止めてもらう (途中のエポックは捨て, 最後に終えたエポックに戻る)

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

            # まずは止める要求を実験のディレクトリに配置
            # (中身が無ければエポックの区切りで, now ならエポックの途中でも)
            run_dir = self.find_run(job, project) if project else None
            if run_dir is not None and not force:
                # 先にあるリンクや FIFO は開かずに消し, 新しい普通の
                # ファイルとして作る (実験の外を書き換えないため)
                replace_with_plain(
                    run_dir / STOP_FILE, b"now\n" if now else b""
                )

            # 実験が無い場合と強制の場合は, このサーバーが起動したものに限り
            # シグナルを送信 (起動し直した後の pid は別のプロセスの可能性)
            if (run_dir is None or force) and self.owns(job, run_dir):
                number = min(job.force_count, len(FORCE_SIGNALS) - 1)
                try:
                    os.killpg(job.pid or 0, FORCE_SIGNALS[number])
                except ProcessLookupError:
                    pass
                except PermissionError as error:
                    # 別のユーザーのプロセスには送れないので, 理由を返却
                    raise JobSignalError(
                        "プロセスに割り込む権限がありません (別のユーザーの"
                        "プロセス). 端末で止めてください"
                    ) from error
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
            run.json の pid とホスト名がジョブと同じで, プロセスが動いていて,
            次のどちらかかどうか. 同じプロセスと確かめられた. run.json が
            実行中で, 確かめられず, 前に使い回しと読んでいない
        """
        if job.id in self.processes:
            return True
        if run_dir is None or job.pid is None:
            return False

        status = read_json(run_dir / "run.json")
        state = status.get("status")
        if not (
            state in ("running", "completed")
            and status.get("pid") == job.pid
            and status.get("hostname") == socket.gethostname()
            and pid_alive(job.pid)
        ):
            return False

        # 別のプロセスと分かれば送らない. 確かめられない場合は, 実行中は
        # 学習のプロセスが居る見込みが高いので送り, 後の処理中は run.json
        # だけでは使い回しと見分けられないので送らない決まり. ただし前に
        # 使い回しと読んだジョブは, 一度の読み損ないで送らないため送らない.
        # 印は書き換えない (ロックの外の画面の情報からも呼ぶため. 印を付ける
        # のはロックの中の poll)
        same = same_process(job)
        owned = same is True or (
            state == "running" and same is None and not job.pid_reused
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
        text = output_tail(self.job_dir(job.id) / "output.log")

        return text


def output_tail(path: Path) -> str:
    """
    プロセスの出力のファイルの末尾を読む関数

    Parameters
    ----------
    path: Path
        出力のファイル

    Returns
    ----------
    text: str
        出力の末尾, ファイルが無い場合は空
    """
    # 大きな出力でも末尾だけの読み込み (リンクと普通でないファイルは空)
    text = ""
    try:
        with open_plain(path, None) as file:
            size = os.fstat(file.fileno()).st_size
            file.seek(max(0, size - OUTPUT_TAIL))
            raw = file.read(OUTPUT_TAIL).decode("utf-8", errors="replace")
    except OSError:
        return text

    # 進捗バーが \r で同じ行を書き直した分と, 端末の制御文字の除去
    raw = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw)
    lines = [
        line.rstrip("\r").rsplit("\r", 1)[-1] for line in raw.split("\n")
    ]
    text = "\n".join(lines)

    return text
