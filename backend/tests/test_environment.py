import json
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from ml_dashboard.core import environment
from ml_dashboard.core.environment import EnvironmentJobs
from ml_dashboard.core.jobs import JobManager
from ml_dashboard.core.requirements import REPORT_CACHE, REPORT_MARK

# ML-Found と段階のライブラリの pip の指定
FOUND = "ml-found @ git+https://github.com/victor-von-pooh/ML-Found.git"
EDA = "ml-eda[parquet] @ git+https://github.com/victor-von-pooh/ML-EDA.git"

# 学習の準備を持つ default の config
READY_CONFIG = """\
experiment:
  name: demo
  output_dir: outputs
data:
  dataset: outputs/dataset
model:
  spec: models/model.yaml
requires: [eda, ros2, project_only]
"""


@pytest.fixture(autouse=True)
def mock_commands(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """
    pip で入れずに, 中身の無い .venv だけを作るように差し替える関数

    Parameters
    ----------
    monkeypatch: pytest.MonkeyPatch
        差し替えに使う

    Returns
    ----------
    None
    """
    REPORT_CACHE.clear()
    monkeypatch.setattr(environment, "find_uv", no_uv)
    monkeypatch.setattr(environment, "venv_command", bare_venv)
    monkeypatch.setattr(environment, "install_command", echo_install)
    yield
    REPORT_CACHE.clear()


def no_uv() -> Optional[str]:
    """
    uv が無いものとする関数

    Parameters
    ----------
    None

    Returns
    ----------
    uv: Optional[str]
        常に None
    """
    uv = None

    return uv


def bare_venv(project_dir: Path, uv: Optional[str]) -> list[str]:
    """
    pip を入れない .venv を作るコマンドを返す関数 (ネットワークを使わない)

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    uv: Optional[str]
        uv のパス (使わない)

    Returns
    ----------
    command: list[str]
        引数のリスト
    """
    command = [
        sys.executable, "-m", "venv", "--without-pip",
        str(project_dir / ".venv")
    ]

    return command


def echo_install(
    python: str, arguments: list[str], uv: Optional[str]
) -> list[str]:
    """
    入れる代わりに引数を出力するコマンドを返す関数

    Parameters
    ----------
    python: str
        入れる先の Python
    arguments: list[str]
        pip install に渡す引数
    uv: Optional[str]
        uv のパス (使わない)

    Returns
    ----------
    command: list[str]
        引数のリスト
    """
    command = [
        python, "-c", "import sys; print('install', *sys.argv[1:])",
        *arguments
    ]

    return command


def register(
    client: TestClient, project_dir: Path, python: str = sys.executable
) -> str:
    """
    Python を指定してプロジェクトを登録する関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    python: str = sys.executable
        プロジェクトの Python (既定はダッシュボードの Python で, 仮想環境
        が見つからなかったときと同じ)

    Returns
    ----------
    project_id: str
        登録したプロジェクトの ID
    """
    response = client.post(
        "/api/projects", json={"path": str(project_dir), "python": python}
    )
    assert response.status_code == 201
    project_id: str = response.json()["id"]

    return project_id


def wait_job(client: TestClient, project_id: str) -> dict[str, Any]:
    """
    環境のジョブが終わるまで待つ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_id: str
        プロジェクトの ID

    Returns
    ----------
    job: dict[str, Any]
        終わったジョブ
    """
    deadline = time.monotonic() + 60
    job: dict[str, Any] = {}
    while time.monotonic() < deadline:
        job = client.get(f"/api/projects/{project_id}/environment").json()
        if job["status"] != "running":
            return job
        time.sleep(0.2)
    raise AssertionError(f"環境のジョブが終わりません: {job}")


def test_create_environment(client: TestClient, project_dir: Path) -> None:
    """
    .venv の無いプロジェクトで, 確かめたコマンドだけを動かして .venv を
    作り, 学習に使う Python にすることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(READY_CONFIG, encoding="utf-8")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/readiness"

    # データセットとモデルの定義が無く, .venv も無い
    readiness = client.get(url).json()
    assert readiness["dataset"]["value"] == "outputs/dataset"
    assert readiness["dataset"]["exists"] is False
    assert readiness["model_spec"]["path"] == str(
        project_dir / "models" / "model.yaml"
    )
    assert readiness["managed"] is True
    assert readiness["environment_exists"] is False
    assert readiness["target_python"] == str(
        project_dir / ".venv" / "bin" / "python"
    )
    assert readiness["requires"] == ["eda", "ros2", "project_only"]
    assert readiness["unknown"] == ["project_only"]
    assert readiness["missing"] == ["eda", "ros2"]
    assert readiness["installer"] == "venv"
    assert readiness["switch_python"] is True
    assert readiness["ready"] is False
    assert readiness["job"] is None

    # .venv を作り, ML-Found と pip で入る機能だけを入れる (ros2 は除く)
    commands = readiness["commands"]
    assert len(commands) == 2
    assert commands[0][-1] == str(project_dir / ".venv")
    assert commands[1][-2:] == [FOUND, EDA]

    # 画面で確かめたものと違うコマンドは動かさない
    url_job = f"/api/projects/{project_id}/environment"
    changed = client.post(url_job, json={"commands": commands[:1]})
    assert changed.status_code == 409
    assert client.get(url_job).json() is None

    started = client.post(url_job, json={"commands": commands})
    assert started.status_code == 201
    assert started.json()["status"] == "running"
    job = wait_job(client, project_id)
    assert job["status"] == "succeeded"
    assert job["return_code"] == 0
    assert f"install {FOUND} {EDA}" in job["output"]

    # 作った .venv が学習に使う Python になり, ML-Found が無いと分かる
    project = client.get(f"/api/projects/{project_id}").json()
    assert project["python"] == readiness["target_python"]
    after = client.get(url).json()
    assert after["environment_exists"] is True
    assert after["ml_found"] is False
    assert after["check_error"] is None
    assert after["commands"] == [
        echo_install(readiness["target_python"], [FOUND, EDA], None)
    ]
    assert after["job"]["status"] == "succeeded"


def test_ready_project(client: TestClient, project_dir: Path) -> None:
    """
    データセット, モデルの定義, 要る機能がそろうと準備ができたとし,
    入れるコマンドが無いことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(
        READY_CONFIG.replace("[eda, ros2, project_only]", "[]"),
        encoding="utf-8"
    )
    (project_dir / "outputs" / "dataset").mkdir(parents=True)
    (project_dir / "models").mkdir()
    (project_dir / "models" / "model.yaml").write_text("{}\n")

    # ダッシュボードの Python (ML-Found が入っている) を他の環境として登録
    link = project_dir.parent / "env" / "bin" / "python"
    link.parent.mkdir(parents=True)
    link.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    link.chmod(0o755)
    project_id = register(client, project_dir, str(link))
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()

    assert readiness["managed"] is False
    assert readiness["target_python"] == str(link)
    assert readiness["dataset"]["exists"] is True
    assert readiness["model_spec"]["exists"] is True
    assert readiness["ml_found"] is True
    assert readiness["commands"] == []
    assert readiness["switch_python"] is False
    assert readiness["ready"] is True

    # 入れるものが無ければ始めない
    response = client.post(
        f"/api/projects/{project_id}/environment", json={"commands": []}
    )
    assert response.status_code == 400


def test_placeholder_model(client: TestClient, project_dir: Path) -> None:
    """
    config に仮のモデルの目印があれば, モデルの定義のファイルが無くても
    準備ができたとし, 目印が無いか真偽でなければ止めることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    (project_dir / "outputs" / "dataset").mkdir(parents=True)

    # ダッシュボードの Python (ML-Found が入っている) を他の環境として登録
    link = project_dir.parent / "env" / "bin" / "python"
    link.parent.mkdir(parents=True)
    link.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    link.chmod(0o755)
    project_id = register(client, project_dir, str(link))

    # 目印の値ごとの, 目印として読むかと準備ができたか
    base = READY_CONFIG.replace("[eda, ros2, project_only]", "[]")
    cases = [
        ("  placeholder: true\n", True),
        ("  placeholder: 'true'\n", False),
        ("", False),
    ]
    for line, expected in cases:
        config.write_text(
            base.replace("  spec: models/model.yaml\n",
                         "  spec: models/model.yaml\n" + line),
            encoding="utf-8"
        )
        readiness = client.get(
            f"/api/projects/{project_id}/readiness"
        ).json()
        assert readiness["model_spec"]["exists"] is False
        assert readiness["model_placeholder"] is expected
        assert readiness["ready"] is expected

    # model.spec が無ければ目印も読まない
    config.write_text(
        base.replace("  spec: models/model.yaml\n", "  placeholder: true\n"),
        encoding="utf-8"
    )
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()
    assert readiness["model_spec"] is None
    assert readiness["model_placeholder"] is False


def test_other_environment_without_ml_found(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    利用者が選んだ他の環境は作らず, 足りないものだけをその Python に入れ,
    失敗したジョブは Python を付け替えないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    # ML-Found を読み込めない Python の代わり (入れるコマンドは失敗する)
    payload = json.dumps({"error": "ModuleNotFoundError: ml_found"})
    python = tmp_path / "other" / "python3"
    python.parent.mkdir()
    python.write_text(
        f"#!/bin/sh\nif [ \"$1\" = -c ] && [ \"$#\" = 2 ]; then\n"
        f"echo '{REPORT_MARK}{payload}'\nelse\nexit 3\nfi\n",
        encoding="utf-8"
    )
    python.chmod(0o755)
    project_id = register(client, project_dir, str(python))

    readiness = client.get(f"/api/projects/{project_id}/readiness").json()
    assert readiness["managed"] is False
    assert readiness["ml_found"] is False
    assert readiness["commands"] == [echo_install(str(python), [FOUND], None)]

    response = client.post(
        f"/api/projects/{project_id}/environment",
        json={"commands": readiness["commands"]}
    )
    assert response.status_code == 201
    job = wait_job(client, project_id)
    assert job["status"] == "failed"
    assert job["return_code"] == 3
    project = client.get(f"/api/projects/{project_id}").json()
    assert project["python"] == str(python)


def test_found_submodule_and_bad_config(
    client: TestClient, project_dir: Path
) -> None:
    """
    ML-Found を submodule で持つプロジェクトはそれを -e で入れ, 読めない
    パスの項目は理由を返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    (project_dir / "ML-Found").mkdir()
    (project_dir / "ML-Found" / "pyproject.toml").write_text("")
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n  dataset: ${missing.value}\n",
        encoding="utf-8"
    )
    project_id = register(client, project_dir)
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()

    assert readiness["dataset"]["error"]
    assert readiness["dataset"]["exists"] is None
    assert readiness["model_spec"] is None
    assert readiness["commands"][1][-2:] == [
        "-e", str(project_dir / "ML-Found")
    ]


def test_interrupted_job(client: TestClient, project_dir: Path) -> None:
    """
    ダッシュボードを起動し直して見届けられなかったジョブを, 途中で
    止まったものとして返すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    None
    """
    project_id = register(client, project_dir)
    jobs = client.app.state.environments  # type: ignore[attr-defined]
    directory = jobs.job_dir(project_id)
    directory.mkdir(parents=True)
    (directory / "job.json").write_text(json.dumps({
        "project_id": project_id, "status": "running",
        "started_at": "2026-01-01T00:00:00+09:00", "commands": [["true"]]
    }))
    (directory / "output.log").write_text("途中\n")

    job = client.get(f"/api/projects/{project_id}/environment").json()
    assert job["status"] == "interrupted"
    assert job["output"] == "途中\n"
    assert client.get("/api/projects/missing/environment").status_code == 404


def test_outdated_ml_found(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    環境の ML-Found の登録簿に無い機能を, 古い版として足りないものに
    数えることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "requires: [eda]\n",
        encoding="utf-8"
    )
    entry = {
        "name": "rl", "description": "強化学習",
        "checks": [{"kind": "module", "name": "gymnasium", "ok": True}],
        "match": "all", "available": True,
        "install": {"kind": "pip", "packages": ["gymnasium"]}
    }
    payload = json.dumps({"requirements": [entry]})
    python = tmp_path / "old" / "python3"
    python.parent.mkdir()
    python.write_text(
        f"#!/bin/sh\necho '{REPORT_MARK}{payload}'\n", encoding="utf-8"
    )
    python.chmod(0o755)
    project_id = register(client, project_dir, str(python))

    readiness = client.get(f"/api/projects/{project_id}/readiness").json()
    assert readiness["ml_found"] is True
    assert readiness["missing"] == []
    assert readiness["outdated"] == ["eda"]
    assert readiness["check_error"] is None
    assert readiness["commands"] == [echo_install(
        str(python), ["--force-reinstall", "--no-deps", FOUND], None
    )]
    assert readiness["ready"] is False


def wait_for_file(
    python: str, arguments: list[str], uv: Optional[str]
) -> list[str]:
    """
    印のファイルができるまで終わらないコマンドを返す関数

    Parameters
    ----------
    python: str
        入れる先の Python
    arguments: list[str]
        pip install に渡す引数 (使わない)
    uv: Optional[str]
        uv のパス (使わない)

    Returns
    ----------
    command: list[str]
        引数のリスト (印のファイルは入れる先の Python と同じ場所の done)
    """
    done = Path(python).parent / "done"
    command = [
        sys.executable, "-c",
        "import pathlib, sys, time\n"
        "while not pathlib.Path(sys.argv[1]).exists(): time.sleep(0.05)",
        str(done)
    ]

    return command


def test_busy_environment(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    環境のジョブが動いている間は, もう 1 つのジョブと学習の起動を断る
    ことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替えに使う

    Returns
    ----------
    None
    """
    monkeypatch.setattr(environment, "install_command", wait_for_file)
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "requires: [eda]\n",
        encoding="utf-8"
    )
    python = tmp_path / "env" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    python.chmod(0o755)
    project_id = register(client, project_dir, str(python))
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()
    assert readiness["missing"] == ["eda"]
    assert len(readiness["commands"]) == 1

    url = f"/api/projects/{project_id}/environment"
    started = client.post(url, json={"commands": readiness["commands"]})
    assert started.status_code == 201
    try:
        busy = client.post(url, json={"commands": readiness["commands"]})
        assert busy.status_code == 409
        training = client.post(
            f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
        )
        assert training.status_code == 409
    finally:
        (python.parent / "done").write_text("")
    assert wait_job(client, project_id)["status"] == "succeeded"
    assert client.get(f"/api/projects/{project_id}").json()["python"] == (
        str(python)
    )


def test_missing_other_environment_and_absolute_dataset(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    利用者が選んだ他の環境が無い場合は何も動かさず, 絶対パスの
    データセットをそのまま確かめることを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    dataset = tmp_path / "shared" / "dataset"
    dataset.mkdir(parents=True)
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        f"data:\n  root: {dataset.parent}\n"
        "  dataset: ${data.root}/dataset\n",
        encoding="utf-8"
    )
    python = tmp_path / "gone" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    python.chmod(0o755)
    project_id = register(client, project_dir, str(python))
    python.unlink()

    readiness = client.get(f"/api/projects/{project_id}/readiness").json()
    assert readiness["dataset"]["path"] == str(dataset)
    assert readiness["dataset"]["exists"] is True
    assert readiness["managed"] is False
    assert readiness["environment_exists"] is False
    assert readiness["commands"] == []
    assert readiness["ready"] is False


def test_environment_while_training(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    学習のジョブが動いている間は, 環境のジョブを始めないことを確かめる
    関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替えに使う

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(READY_CONFIG, encoding="utf-8")
    project_id = register(client, project_dir)
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()

    # このプロジェクトの学習が動いている形の一覧に差し替え
    running = SimpleNamespace(project_id=project_id, status="running")
    monkeypatch.setattr(JobManager, "list_jobs", JobsStub([running]).list_jobs)
    url = f"/api/projects/{project_id}/environment"
    response = client.post(url, json={"commands": readiness["commands"]})
    assert response.status_code == 409
    assert "学習が動いている" in response.json()["detail"]
    assert client.get(url).json() is None


class JobsStub:
    def __init__(self, jobs: list[SimpleNamespace]):
        # 返すジョブの一覧
        self.jobs = jobs

    def list_jobs(self, *args: Any) -> list[SimpleNamespace]:
        """
        保存したジョブの一覧を返す関数

        Parameters
        ----------
        *args: Any
            使わない引数 (自身と登録したプロジェクト)

        Returns
        ----------
        jobs: list[SimpleNamespace]
            保存したジョブ
        """
        jobs = self.jobs

        return jobs


class RunningStub:
    def __init__(self) -> None:
        # 呼ばれた回数 (1 回目だけ動いていないと答える)
        self.calls = 0

    def running(self, *args: Any) -> bool:
        """
        最初の確かめの後に環境のジョブが始まった形で答える関数

        Parameters
        ----------
        *args: Any
            使わない引数 (自身とプロジェクトの ID)

        Returns
        ----------
        alive: bool
            2 回目からは True
        """
        self.calls += 1
        alive = self.calls > 1

        return alive


def test_training_recheck(
    client: TestClient, project_dir: Path, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    config の確かめの後に環境のジョブが始まった場合は, 学習を起動せず
    409 を返し, 作ったジョブのディレクトリを消すことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替えに使う

    Returns
    ----------
    None
    """
    # 最初の確かめは通り, 起動の前の確かめ直しで動いていると答える
    project_id = register(client, project_dir)
    stub = RunningStub()
    monkeypatch.setattr(EnvironmentJobs, "running", stub.running)
    response = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "{}\n"}
    )
    assert response.status_code == 409, response.text
    assert "環境に入れている" in response.json()["detail"]
    assert stub.calls == 2

    # ジョブのディレクトリ (中身を書いた config ごと) は残さない
    jobs_dir = tmp_path / "home" / "jobs"
    assert not jobs_dir.exists() or not list(jobs_dir.iterdir())
    assert client.get("/api/jobs").json() == []


def test_launch_lock_shared(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    学習の起動と環境のジョブの開始が同じロックを使い, 学習の確かめを
    そのロックの中で行うことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        差し替えに使う

    Returns
    ----------
    None
    """
    config = project_dir / "configs" / "default" / "train.yaml"
    config.write_text(READY_CONFIG, encoding="utf-8")
    project_id = register(client, project_dir)
    readiness = client.get(f"/api/projects/{project_id}/readiness").json()

    # 学習の一覧を読む間, 共有のロックを持っていること
    environments = client.app.state.environments  # type: ignore[attr-defined]
    held: list[bool] = []
    stub = LockProbe(environments.launch_lock, project_id, held)
    monkeypatch.setattr(JobManager, "list_jobs", stub.list_jobs)
    url = f"/api/projects/{project_id}/environment"
    response = client.post(url, json={"commands": readiness["commands"]})
    assert response.status_code == 409
    assert held == [True]


class LockProbe:
    def __init__(self, lock: Any, project_id: str, held: list[bool]):
        # 確かめるロック, 学習が動いている形にするプロジェクトと, 呼ばれた
        # ときにロックを持っていたかの記録
        self.lock = lock
        self.project_id = project_id
        self.held = held

    def list_jobs(self, *args: Any) -> list[SimpleNamespace]:
        """
        ロックを持っているかを記録し, 動いている学習を返す関数

        Parameters
        ----------
        *args: Any
            使わない引数 (自身と登録したプロジェクト)

        Returns
        ----------
        jobs: list[SimpleNamespace]
            プロジェクトの動いている学習のジョブ 1 つ
        """
        self.held.append(self.lock.locked())
        jobs = [
            SimpleNamespace(project_id=self.project_id, status="running")
        ]

        return jobs
