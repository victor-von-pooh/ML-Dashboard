import time
from pathlib import Path

from fastapi.testclient import TestClient

from test_api import register

# ML-Found の学習の代わりに, 状態のファイルを書いて STOP を待つスクリプト
FAKE_TRAIN = '''\
import argparse, json, os, time
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--experiment")
args = parser.parse_args()
print("experiment", Path(args.experiment).name, flush=True)

now = datetime.now()
day, clock = now.strftime("%Y-%m-%d"), now.strftime("%H-%M-%S")
run = Path("outputs/demo") / day / clock
run.mkdir(parents=True)
(run / "config.yaml").write_text("experiment:\\n  name: demo\\n")
status = {"status": "running", "pid": os.getpid(), "planned_epochs": 100}
(run / "run.json").write_text(json.dumps(status))
(run / "progress.json").write_text(json.dumps({
    "phase": "train", "epoch": 1, "total_epochs": 100, "batch": 3,
    "total_batches": 10, "elapsed_sec": 0.5, "updated_at": now.isoformat()
}))
for _ in range(200):
    if (run / "STOP").exists():
        status["status"] = "stopped"
        break
    time.sleep(0.05)
else:
    status["status"] = "completed"
(run / "run.json").write_text(json.dumps(status))
(run / "progress.json").unlink()
stop = run / "STOP"
kind = stop.read_text().strip() if stop.exists() else ""
print("done", status["status"], kind or "epoch", flush=True)
'''


def wait_for(client: TestClient, job_id: str, key: str, value: object) -> dict:
    """
    ジョブの項目が指定した値になるまで待つ関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    job_id: str
        ジョブの ID
    key: str
        確かめる項目
    value: object
        待つ値, None 以外になるのを待つ場合は ...

    Returns
    ----------
    job: dict
        条件を満たしたジョブの情報
    """
    # 最大 10 秒まで, 0.05 秒ごとに確認
    for _ in range(200):
        job: dict = client.get(f"/api/jobs/{job_id}").json()
        current = job[key]
        if (value is ... and current is not None) or current == value:
            return job
        time.sleep(0.05)

    raise AssertionError(f"{key} が {value} になりませんでした: {job}")


def test_validate_config(client: TestClient, project_dir: Path) -> None:
    """
    ML-Found で config を確かめられることを確かめる関数

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
    url = f"/api/projects/{project_id}/validate"

    ok = client.post(url, json={"text": "trainer:\n  epochs: 3\n"}).json()
    assert ok["ok"] is True
    assert ok["diff"]["trainer.epochs"]["experiment"] == 3

    typo = client.post(url, json={"text": "trainer:\n  epoch: 3\n"}).json()
    assert typo["ok"] is False
    assert "epoch" in typo["error"]

    config = client.get(
        f"/api/projects/{project_id}/configs/configs/experiment/train.yaml"
    )
    assert config.json()["text"] == "{}\n"
    outside = client.get(
        f"/api/projects/{project_id}/configs/configs/default/train.yaml"
    )
    assert outside.status_code == 404


def test_job_lifecycle(client: TestClient, project_dir: Path) -> None:
    """
    学習の起動, 実験との結び付け, 進み具合, 中断, 出力を確かめる関数

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
    (project_dir / "train.py").write_text(FAKE_TRAIN)
    project_id = register(client, project_dir)

    # 存在しないスクリプトと, 誤りのある config は起動前に拒否
    bad_script = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "other.py"}
    )
    assert bad_script.status_code == 400
    bad_config = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epoch: 1\n"}
    )
    assert bad_config.status_code == 400

    # 書き換えた config で起動
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epochs: 5\n"}
    )
    assert created.status_code == 201
    job_id = created.json()["id"]

    # 実験が作られると結び付き, 進み具合が読める
    job = wait_for(client, job_id, "run_id", ...)
    assert job["run"]["status"] == "running"
    assert job["progress"]["batch"] == 3
    assert job["project_name"] == "demo_task"

    # 中断の要求で止まり, 実験は中断として残る
    stopped = client.post(f"/api/jobs/{job_id}/stop", json={"force": False})
    assert stopped.json()["stop_requested"] is True
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] == 0
    assert job["run"]["status"] == "stopped"

    output = client.get(f"/api/jobs/{job_id}/output").json()["text"]
    assert "experiment experiment.yaml" in output
    assert "done stopped" in output

    jobs = client.get("/api/jobs").json()
    assert [item["id"] for item in jobs] == [job_id]


def test_stop_within_epoch(client: TestClient, project_dir: Path) -> None:
    """
    エポックの途中で止める要求が, STOP に now と書くことを確かめる関数

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
    # 中身が now になるまで止まらない偽の学習 (区切りの要求では止まらない)
    (project_dir / "train.py").write_text(
        FAKE_TRAIN.replace(
            'if (run / "STOP").exists():',
            'if (run / "STOP").exists() and '
            '(run / "STOP").read_text().strip() == "now":'
        )
    )
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]
    run_id = wait_for(client, job_id, "run_id", ...)["run_id"]

    # エポックの区切りで止める要求の後でも, 途中で止める要求に切り替えられる
    client.post(f"/api/jobs/{job_id}/stop", json={"force": False})
    stopped = client.post(
        f"/api/jobs/{job_id}/stop", json={"force": False, "now": True}
    )
    assert stopped.json()["stop_requested"] is True
    stop_file = project_dir / "outputs" / run_id / "STOP"
    assert stop_file.read_text(encoding="utf-8") == "now\n"
    job = wait_for(client, job_id, "status", "finished")
    assert job["run"]["status"] == "stopped"
    output = client.get(f"/api/jobs/{job_id}/output").json()["text"]
    assert "done stopped now" in output


def test_force_stop(client: TestClient, project_dir: Path) -> None:
    """
    強制の中断で割り込みを送れることを確かめる関数

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
    (project_dir / "train.py").write_text(
        "import time\nprint('start', flush=True)\ntime.sleep(30)\n"
    )
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    )
    job_id = created.json()["id"]

    # 実験が無くても, Ctrl-C と同じ割り込みで止まる
    client.post(f"/api/jobs/{job_id}/stop", json={"force": True})
    job = wait_for(client, job_id, "status", "finished")
    assert job["return_code"] != 0
    assert job["run_id"] is None

    missing = client.get("/api/jobs/zzzz")
    assert missing.status_code == 404
    traversal = client.get("/api/jobs/..%2F..")
    assert traversal.status_code == 404


def test_rejected_launch_leaves_nothing(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    受け付けなかった起動がジョブのディレクトリを残さないことを確かめる関数

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
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/jobs"

    # 誤った config, 辞書でない config, パスと中身の両方の指定
    typo = client.post(
        url, json={"script": "train.py", "config_text": "trainer:\n  e: 1\n"}
    )
    assert typo.status_code == 400
    listed = client.post(
        url, json={"script": "train.py", "config_text": "- 1\n"}
    )
    assert listed.status_code == 400
    assert "項目: 値" in listed.json()["detail"]
    assert "/tmp" not in listed.json()["detail"]
    moved = client.post(url, json={
        "script": "train.py",
        "config_text": "experiment:\n  output_dir: elsewhere\n"
    })
    assert moved.status_code == 400
    assert "output_dir" in moved.json()["detail"]
    both = client.post(url, json={
        "script": "train.py", "config_text": "{}\n",
        "config_path": "configs/experiment/train.yaml"
    })
    assert both.status_code == 422

    jobs_dir = tmp_path / "home" / "jobs"
    assert not jobs_dir.exists() or list(jobs_dir.iterdir()) == []


def test_edited_config_text(client: TestClient, project_dir: Path) -> None:
    """
    画面で書き換えた config の中身をジョブの情報で返すことを確かめる関数

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
    (project_dir / "train.py").write_text("print('done')\n")
    project_id = register(client, project_dir)
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": "trainer:\n  epochs: 4\n"}
    ).json()
    assert created["config_text"] == "trainer:\n  epochs: 4\n"
    job = wait_for(client, created["id"], "status", "finished")
    assert job["return_code"] == 0

    # プロジェクトの config で起動した場合は中身を返さない
    plain = client.post(
        f"/api/projects/{project_id}/jobs", json={"script": "train.py"}
    ).json()
    assert plain["config_text"] is None
    wait_for(client, plain["id"], "status", "finished")


def test_registry_and_required_params(
    client: TestClient, project_dir: Path
) -> None:
    """
    登録簿と, 必須の引数の不足を注意として返すことを確かめる関数

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
    registry = client.get("/api/registry").json()
    adam = next(
        item for item in registry["optimizers"] if item["name"] == "Adam"
    )
    assert any(param["name"] == "lr" for param in adam["params"])

    # スクリプトが補う可能性がある必須の引数の不足は注意, 名前の誤りはエラー
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    missing = client.post(
        url, json={"text": "scheduler:\n  name: StepLR\n  params: {}\n"}
    ).json()
    assert missing["ok"] is True
    assert "step_size" in missing["warnings"][0]
    assert missing["config"]["scheduler"]["name"] == "StepLR"
    typo = client.post(
        url, json={"text": "optimizer:\n  params:\n    lerning_rate: 1\n"}
    ).json()
    assert typo["ok"] is False
    assert "lerning_rate" in typo["error"]


def test_validate_custom_optimizer(
    client: TestClient, project_dir: Path
) -> None:
    """
    プロジェクトの中の自作の Optimizer を確かめられることを確かめる関数

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
    (project_dir / "my_optim_for_test.py").write_text(
        "from torch import optim\n\n\nclass Mine(optim.SGD):\n    pass\n"
    )
    project_id = register(client, project_dir)
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": "optimizer:\n  name: my_optim_for_test.Mine\n"}
    ).json()
    assert result["ok"] is True, result["error"]


def test_default_config_per_script(
    client: TestClient, project_dir: Path
) -> None:
    """
    学習のスクリプトごとに default の config を選ぶことを確かめる関数

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
    # train_hf.py は hf.yaml, train_big.py は対応が無いので train.yaml
    (project_dir / "configs" / "default" / "hf.yaml").write_text(
        "experiment:\n  name: demo_hf\n  output_dir: outputs_hf\n"
        "data:\n  n_train: 10\n"
    )
    (project_dir / "train_hf.py").write_text("print('hf')\n")
    (project_dir / "train_big.py").write_text("print('big')\n")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = "data:\n  n_train: 20\n"

    hf = client.post(url, json={"text": text, "script": "train_hf.py"}).json()
    assert hf["ok"] is True
    assert hf["default_config"] == "configs/default/hf.yaml"
    assert hf["diff"]["data.n_train"]["default"] == 10

    # train.yaml には data.n_train が無いのでエラー
    plain = client.post(url, json={"text": text, "script": "train.py"}).json()
    assert plain["ok"] is False
    assert "data" in plain["error"]
    assert plain["default_config"] == "configs/default/train.yaml"
    big = client.post(url, json={"text": "{}\n", "script": "train_big.py"})
    assert big.json()["default_config"] == "configs/default/train.yaml"

    # 一覧に無いスクリプトは受け付けない
    missing = client.post(url, json={"text": "{}\n", "script": "other.py"})
    assert missing.status_code == 400

    # 起動の前の確認も同じ default の config を使用
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train_hf.py", "config_text": text}
    )
    assert created.status_code == 201
    wait_for(client, created.json()["id"], "status", "finished")
    rejected = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": text}
    )
    assert rejected.status_code == 400

    # 別の default の config の出力先の実験も探す対象
    output_dirs = client.get(f"/api/projects/{project_id}").json()
    assert any(
        path.endswith("outputs_hf") for path in output_dirs["output_dirs"]
    )


def test_validate_param_ranges(client: TestClient, project_dir: Path) -> None:
    """
    範囲の外の引数が確認のエラーになり, 登録簿が端を含まない範囲を返すことを
    確かめる関数

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
    url = f"/api/projects/{project_id}/validate"
    text = (
        "scheduler:\n  name: ReduceLROnPlateau\n  params:\n    factor: 1.0\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "factor は 0.0 以上 1.0 未満" in result["error"]
    # フォームで直せるように, 読み込めた config も返却
    assert result["config"]["scheduler"]["params"]["factor"] == 1.0

    # 起動もエラー
    (project_dir / "train.py").write_text("print('train')\n")
    launched = client.post(
        f"/api/projects/{project_id}/jobs",
        json={"script": "train.py", "config_text": text}
    )
    assert launched.status_code == 400
    assert "factor" in launched.json()["detail"]

    # 必須の引数の不足 (注意) があっても, 範囲の外の値はエラー
    text = (
        "scheduler:\n  name: StepLR\n  params:\n    gamma: -1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "gamma は 0.0 以上" in result["error"]

    # 範囲を持たない引数の組み合わせの誤りも, 作ってみて確認のエラー
    text = (
        "optimizer:\n  name: SGD\n  params:\n    lr: 0.1\n"
        "    nesterov: true\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "SGD を作れません: ValueError: Nesterov" in result["error"]
    assert result["error"].count("ValueError") == 1
    assert result["config"]["optimizer"]["params"]["nesterov"] is True

    # 使えないデバイスは, 必須の引数の不足 (注意) があっても値の誤り
    text = (
        "experiment:\n  device: gpu\n"
        "scheduler:\n  name: StepLR\n  params:\n    gamma: 0.5\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "experiment.device の誤り" in result["error"]

    registry = client.get("/api/registry").json()
    plateau = next(
        spec for spec in registry["schedulers"]
        if spec["name"] == "ReduceLROnPlateau"
    )
    factor = next(
        param for param in plateau["params"] if param["name"] == "factor"
    )
    assert factor["exclusive_maximum"] is True
    assert factor["exclusive_minimum"] is False


def test_validate_notes_filled_scheduler(
    client: TestClient, project_dir: Path
) -> None:
    """
    ML-Found が補う Scheduler の引数を, 注意ではなくお知らせで返すことを
    確かめる関数

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
    text = (
        "scheduler:\n  name: OneCycleLR\n  interval: step\n  params:\n"
        "    max_lr: 0.1\n"
    )
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["ok"] is True
    assert result["warnings"] == []
    assert "epochs は, 学習を始めるときに ML-Found が trainer.epochs" in (
        result["notes"][0]
    )
    assert "学習用データのバッチ数" in result["notes"][1]

    # OneCycleLR の epochs が trainer.epochs より少なければ誤り, 多ければ注意
    for epochs, ok in ((1, False), (100_000, True)):
        result = client.post(
            f"/api/projects/{project_id}/validate",
            json={"text": text + f"    epochs: {epochs}\n"}
        ).json()
        assert result["ok"] is ok
        if not ok:
            assert "trainer.epochs" in result["error"]
        else:
            assert "下がりきりません" in result["warnings"][0]

    # 総ステップ数を書いた場合はお知らせなし
    text += "    total_steps: 10\n"
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["notes"] == []

    # auto と書いた引数は, 学習全体のステップ数で補うお知らせ
    text = (
        "scheduler:\n  name: CosineAnnealingLR\n  interval: step\n"
        "  params:\n    T_max: auto\n"
    )
    result = client.post(
        f"/api/projects/{project_id}/validate", json={"text": text}
    ).json()
    assert result["ok"] is True
    assert result["notes"] == [
        "CosineAnnealingLR の T_max は, 学習を始めるときに ML-Found が"
        " trainer.epochs × 学習用データのバッチ数 (学習全体のステップ数) に"
        "します"
    ]

    # auto と書けない引数 (範囲を持たない eta_min) は値の誤り
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": text + "    eta_min: auto\n"}
    ).json()
    assert result["ok"] is False
    assert "eta_min には auto と書けません" in result["error"]
