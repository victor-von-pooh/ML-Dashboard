import os
import re
import socket
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from ml_dashboard.core.jobs import now_iso
from ml_dashboard.core.models import (
    Batch,
    BatchCandidate,
    BatchOwner,
    CandidateState,
)
from ml_dashboard.core.runs import pid_alive

# まとまりの ID の形 (ジョブの ID と同じく, 置き場の外を指さないため)
BATCH_ID = re.compile(r"[0-9a-f]{12}")

# 次の候補を起動できるか, 候補のジョブが終わったかを確かめる間隔 (秒)
POLL_SEC = 2.0

# 待つ候補と学習中の候補の状態
ACTIVE_STATES = ("waiting", "running")


def is_batch_id(batch_id: str) -> bool:
    """
    まとまりの ID の形かを判定する関数

    Parameters
    ----------
    batch_id: str
        まとまりの ID

    Returns
    ----------
    valid: bool
        12 桁の 16 進数かどうか
    """
    valid = BATCH_ID.fullmatch(batch_id) is not None

    return valid


def is_active(batch: Batch) -> bool:
    """
    まとまりが終わっていないかを判定する関数

    Parameters
    ----------
    batch: Batch
        まとまり

    Returns
    ----------
    active: bool
        待つ候補か学習中の候補があるかどうか
    """
    active = any(
        candidate.state in ACTIVE_STATES for candidate in batch.candidates
    )

    return active


@dataclass
class BatchHooks:
    # まとまりの進め方がジョブと起動の確かめに使う関数. busy は学習中の
    # ジョブの ID (環境のジョブの間は "environment"), check は起動の前の
    # 確かめ (通らなければ理由), launch は起動してジョブの ID を返す (学習中
    # のジョブがあれば None), finished はジョブが終わったか, run_sha256 は
    # ジョブの実験の写しの sha256, stop はジョブの中断
    busy: Callable[[], list[str]]
    check: Callable[[BatchCandidate, str], Optional[str]]
    launch: Callable[[BatchCandidate, str], Optional[str]]
    finished: Callable[[str], bool]
    run_sha256: Callable[[str], Optional[str]]
    stop: Callable[[str], None]
    current_sha256: Callable[[BatchCandidate], Optional[str]]


class BatchManager:
    def __init__(self, data_dir: Path):
        # まとまりの記録の置き場と, このプロセスの持ち主の情報を保存
        self.batches_dir = data_dir / "batches"
        self.owner = BatchOwner(
            hostname=socket.gethostname(), pid=os.getpid(),
            started_at=now_iso()
        )

        # まとまりごとのロックと, ロックの表を作るロックを用意
        self.locks: dict[str, threading.RLock] = {}
        self.table_lock = threading.Lock()

        # 前のプロセスが持ち主のまとまりの待つ候補を取りやめに設定
        self.cancel_orphans()

    def lock(self, batch_id: str) -> threading.RLock:
        """
        まとまりごとのロックを取得する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID

        Returns
        ----------
        lock: threading.RLock
            そのまとまりのロック
        """
        with self.table_lock:
            lock = self.locks.setdefault(batch_id, threading.RLock())

        return lock

    def batch_dir(self, batch_id: str) -> Path:
        """
        まとまりのディレクトリを取得する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID

        Returns
        ----------
        path: Path
            記録 (batch.json) と候補の config (candidates/) の置き場
        """
        path = self.batches_dir / batch_id

        return path

    def candidate_config(self, batch_id: str, index: int) -> Path:
        """
        候補の書き換えた config の場所を取得する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        index: int
            候補の番号 (0 から)

        Returns
        ----------
        path: Path
            candidates/<番号>.yaml
        """
        path = self.batch_dir(batch_id) / "candidates" / f"{index}.yaml"

        return path

    def save(self, batch: Batch) -> None:
        """
        まとまりの記録を書き込む関数

        Parameters
        ----------
        batch: Batch
            まとまり

        Returns
        ----------
        None
        """
        # 一時ファイルに書いてから置き換え, 書きかけを読まれないように設定
        path = self.batch_dir(batch.id) / "batch.json"
        with tempfile.NamedTemporaryFile(
            "w", dir=path.parent, suffix=".tmp", delete=False,
            encoding="utf-8"
        ) as file:
            file.write(batch.model_dump_json(indent=2))
        os.replace(file.name, path)

    def load(self, batch_id: str) -> Optional[Batch]:
        """
        まとまりの記録を読み込む関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID

        Returns
        ----------
        batch: Optional[Batch]
            まとまり, 無いか読めない場合は None
        """
        if not is_batch_id(batch_id):
            return None
        path = self.batch_dir(batch_id) / "batch.json"
        try:
            batch = Batch.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError):
            return None

        return batch

    def list_batches(self) -> list[Batch]:
        """
        全てのまとまりを新しい順に取得する関数

        Parameters
        ----------
        None

        Returns
        ----------
        batches: list[Batch]
            読めたまとまり (作った時刻の新しい順)
        """
        batches: list[Batch] = []
        if not self.batches_dir.is_dir():
            return batches
        for path in self.batches_dir.iterdir():
            batch = self.load(path.name)
            if batch is not None:
                batches.append(batch)
        batches.sort(key=lambda item: item.created_at, reverse=True)

        return batches

    def owned(self, batch: Batch) -> bool:
        """
        まとまりの持ち主がこのプロセスかを判定する関数

        Parameters
        ----------
        batch: Batch
            まとまり

        Returns
        ----------
        owned: bool
            hostname, pid, 起動の時刻が同じかどうか
        """
        owned = batch.owner == self.owner

        return owned

    def orphaned(self, batch: Batch) -> bool:
        """
        まとまりの持ち主のプロセスが居ないかを判定する関数

        Parameters
        ----------
        batch: Batch
            まとまり

        Returns
        ----------
        orphaned: bool
            同じ hostname で, pid が動いていないか, pid が今のプロセスと
            同じで起動の時刻が違う (使い回された pid) かどうか. 別の
            hostname は確かめられないので False
        """
        owner = batch.owner
        if owner.hostname != self.owner.hostname or self.owned(batch):
            return False
        orphaned = not pid_alive(owner.pid) or owner.pid == self.owner.pid

        return orphaned

    def cancel_orphans(self) -> None:
        """
        持ち主の居ないまとまりの待つ候補を取りやめにする関数

        Parameters
        ----------
        None

        Returns
        ----------
        None
        """
        # 学習中の候補はジョブとして残るので, 待つ候補だけを取りやめ
        for batch in self.list_batches():
            if not self.orphaned(batch):
                continue
            with self.lock(batch.id):
                for candidate in batch.candidates:
                    if candidate.state == "waiting":
                        candidate.state = "cancelled"
                        candidate.reason = "ダッシュボードを止めたため"
                self.save(batch)

    def active_for(self, project_id: str) -> Optional[Batch]:
        """
        プロジェクトの進めている途中のまとまりを探す関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID

        Returns
        ----------
        batch: Optional[Batch]
            終わっていないまとまり, 無ければ None
        """
        for batch in self.list_batches():
            if batch.project_id == project_id and is_active(batch):
                return batch

        return None

    def create(
        self, project_id: str, script: str, default_config: Optional[str],
        candidates: list[tuple[BatchCandidate, str]]
    ) -> Batch:
        """
        まとまりの記録と候補の config を作る関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID
        script: str
            学習のスクリプト
        default_config: Optional[str]
            起動の前の確認に使う default の config
        candidates: list[tuple[BatchCandidate, str]]
            候補と, model.spec を書き換えた experiment の config の中身

        Returns
        ----------
        batch: Batch
            作ったまとまり
        """
        batch = Batch(
            id=uuid.uuid4().hex[:12], project_id=project_id, script=script,
            default_config=default_config, created_at=now_iso(),
            owner=self.owner,
            candidates=[candidate for candidate, _ in candidates]
        )

        # 候補の config を書いてから記録を保存
        for index, (_, text) in enumerate(candidates):
            path = self.candidate_config(batch.id, index)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        self.save(batch)

        return batch

    def stop(
        self, batch_id: str, stop_job: Callable[[str], None]
    ) -> Optional[Batch]:
        """
        まとまりの待つ候補を取りやめ, 学習中の候補を中断する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        stop_job: Callable[[str], None]
            ジョブを普通に中断する関数

        Returns
        ----------
        batch: Optional[Batch]
            更新したまとまり, 無い場合は None
        """
        # 進め方が次の候補を起動する間と重ならないように, 同じロックの中
        with self.lock(batch_id):
            batch = self.load(batch_id)
            if batch is None:
                return None
            for candidate in batch.candidates:
                if candidate.state == "waiting":
                    candidate.state = "cancelled"
                    candidate.reason = "取りやめたため"
                elif candidate.state == "running" and candidate.job_id:
                    stop_job(candidate.job_id)
            self.save(batch)

        return batch

    def start(self, batch: Batch, hooks: BatchHooks) -> threading.Thread:
        """
        まとまりを進めるスレッドを始める関数

        Parameters
        ----------
        batch: Batch
            まとまり
        hooks: BatchHooks
            起動と確かめに使う関数

        Returns
        ----------
        thread: threading.Thread
            始めたスレッド
        """
        thread = threading.Thread(
            target=self.run, args=(batch.id, hooks), daemon=True,
            name=f"batch-{batch.id}"
        )
        thread.start()

        return thread

    def run(self, batch_id: str, hooks: BatchHooks) -> None:
        """
        まとまりの候補を, 選んだ順に 1 つずつ起動して終わりを待つ関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        hooks: BatchHooks
            起動と確かめに使う関数

        Returns
        ----------
        None
        """
        batch = self.load(batch_id)
        if batch is None:
            return
        for index in range(len(batch.candidates)):
            job_id = self.launch_next(batch_id, index, hooks)
            if job_id is not None:
                self.wait_job(batch_id, index, job_id, hooks)

    def set_waiting(self, batch_id: str, waiting_for: list[str]) -> bool:
        """
        次の候補が待っているジョブを記録し, 候補が残っているかを返す関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        waiting_for: list[str]
            待っているジョブの ID

        Returns
        ----------
        active: bool
            まとまりが取りやめられていないかどうか
        """
        with self.lock(batch_id):
            batch = self.load(batch_id)
            if batch is None:
                return False
            if batch.waiting_for != waiting_for:
                batch.waiting_for = waiting_for
                self.save(batch)
            active = is_active(batch)

        return active

    def finish_candidate(
        self, batch_id: str, index: int, state: CandidateState,
        reason: Optional[str]
    ) -> None:
        """
        候補の状態と理由を保存する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        index: int
            候補の番号
        state: CandidateState
            新しい状態 (finished か failed)
        reason: Optional[str]
            理由

        Returns
        ----------
        None
        """
        with self.lock(batch_id):
            batch = self.load(batch_id)
            if batch is None:
                return
            candidate = batch.candidates[index]
            if candidate.state in ACTIVE_STATES:
                candidate.state = state
                candidate.reason = reason
            self.save(batch)

    def launch_next(
        self, batch_id: str, index: int, hooks: BatchHooks
    ) -> Optional[str]:
        """
        候補を, 学習中のジョブが無くなるのを待ってから起動する関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        index: int
            候補の番号
        hooks: BatchHooks
            起動と確かめに使う関数

        Returns
        ----------
        job_id: Optional[str]
            起動したジョブの ID, 起動しなかった場合は None
        """
        config = self.candidate_config(batch_id, index)
        while True:
            # 取りやめた候補と, 消えたまとまりは起動しない
            batch = self.load(batch_id)
            if batch is None or batch.candidates[index].state != "waiting":
                return None
            candidate = batch.candidates[index]

            # 学習中のジョブと環境のジョブを待つ
            busy = hooks.busy()
            if not self.set_waiting(batch_id, busy):
                return None
            if busy:
                time.sleep(POLL_SEC)
                continue

            # 選んだ後に書き換えた定義と, 確かめに通らない config は起動しない
            if hooks.current_sha256(candidate) != candidate.sha256:
                self.finish_candidate(
                    batch_id, index, "failed",
                    "まとまりを作った後に定義の中身が変わったため"
                )
                return None
            try:
                text = config.read_text(encoding="utf-8")
            except OSError as error:
                self.finish_candidate(
                    batch_id, index, "failed",
                    f"候補の config を読めないため: {error}"
                )
                return None
            problem = hooks.check(candidate, text)
            if problem is not None:
                self.finish_candidate(batch_id, index, "failed", problem)
                return None

            # 取りやめの確かめ, 起動, 保存を同じロックの中で実行
            with self.lock(batch_id):
                batch = self.load(batch_id)
                if batch is None or batch.candidates[index].state != "waiting":
                    return None
                try:
                    job_id = hooks.launch(candidate, text)
                except Exception as error:
                    batch.candidates[index].state = "failed"
                    batch.candidates[index].reason = (
                        f"起動できなかったため: {error}"
                    )
                    self.save(batch)
                    return None
                if job_id is not None:
                    batch.candidates[index].state = "running"
                    batch.candidates[index].job_id = job_id
                    batch.waiting_for = []
                    self.save(batch)
            if job_id is not None:
                return job_id

            # 確かめた後に学習が始まった場合は, もう一度待つ
            time.sleep(POLL_SEC)

    def wait_job(
        self, batch_id: str, index: int, job_id: str, hooks: BatchHooks
    ) -> None:
        """
        候補のジョブが終わるのを待ち, 写しの sha256 を比べる関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        index: int
            候補の番号
        job_id: str
            候補のジョブの ID
        hooks: BatchHooks
            起動と確かめに使う関数

        Returns
        ----------
        None
        """
        checked = False
        while True:
            finished = hooks.finished(job_id)

            # 学習を始めた実験の写しを, まとまりを作ったときの中身と比較
            if not checked:
                sha256 = hooks.run_sha256(job_id)
                if sha256 is not None:
                    checked = True
                    self.mark_mismatch(batch_id, index, sha256)
            if finished:
                break
            time.sleep(POLL_SEC)
        self.finish_candidate(batch_id, index, "finished", None)

    def mark_mismatch(self, batch_id: str, index: int, sha256: str) -> None:
        """
        学習を始めた実験の写しが候補の定義と違えば印を付ける関数

        Parameters
        ----------
        batch_id: str
            まとまりの ID
        index: int
            候補の番号
        sha256: str
            実験の source.yaml の model_spec の sha256

        Returns
        ----------
        None
        """
        with self.lock(batch_id):
            batch = self.load(batch_id)
            if batch is None:
                return
            candidate = batch.candidates[index]
            if candidate.sha256 != sha256 and not candidate.mismatch:
                candidate.mismatch = True
                self.save(batch)
