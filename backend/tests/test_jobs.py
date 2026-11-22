import hashlib
import json
import os
import time
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from omegaconf import OmegaConf

from ml_dashboard.api.jobs import describe_missing_path
from ml_dashboard.core.model_spec import find_model_spec_copy, run_of_copy
from ml_dashboard.core.models import RunModelSpec

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
    # 段階を書かない前の版の progress.json は, バッチを回している間と読む
    assert job["progress"]["stage"] == "batches"
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

    # 同じ設定でもう一度: 書き換えた config は中身を, プロジェクトの config は
    # 同じファイルを使う
    again = client.post(f"/api/jobs/{created['id']}/rerun")
    assert again.status_code == 201
    assert again.json()["config_text"] == "trainer:\n  epochs: 4\n"
    assert again.json()["id"] != created["id"]
    wait_for(client, again.json()["id"], "status", "finished")
    plain_again = client.post(f"/api/jobs/{plain['id']}/rerun").json()
    assert plain_again["config_text"] is None
    assert plain_again["config"] == plain["config"]
    wait_for(client, plain_again["id"], "status", "finished")
    assert client.post("/api/jobs/missing/rerun").status_code == 404


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


def test_validate_precision_and_accumulation(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    計算の精度, 勾配の蓄積, 始める前に読む重みを ML-Found で確かめることを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        bf16 を使えないデバイスの代わりに確かめの関数を差し替えるのに使用

    Returns
    ----------
    None
    """
    import ml_found.experiment
    import torch

    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 既定は fp32 で毎バッチ更新, cpu では bf16 も使える
    result = client.post(url, json={"text": "{}\n"}).json()
    assert result["ok"] is True, result["error"]
    assert result["config"]["trainer"]["precision"] == "fp32"
    assert result["config"]["trainer"]["accumulate_grad_batches"] == 1
    text = (
        "experiment:\n  device: cpu\n"
        "trainer:\n  precision: bf16\n  accumulate_grad_batches: 4\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    assert result["diff"]["trainer.precision"]["experiment"] == "bf16"
    assert result["diff"]["trainer.accumulate_grad_batches"]["experiment"] == 4

    # 値の誤りと組み合わせの誤りは check_trainer_config のエラー
    for text, expected in [
        ("trainer:\n  precision: fp16\n", "trainer.precision"),
        ("trainer:\n  accumulate_grad_batches: 0\n",
         "trainer.accumulate_grad_batches"),
        ("optimizer:\n  name: LBFGS\n  params:\n    lr: 0.1\n"
         "trainer:\n  accumulate_grad_batches: 2\n",
         "trainer.accumulate_grad_batches"),
    ]:
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is False
        assert expected in result["error"]

    # デバイスで bf16 を使えない場合は, config も返す値の誤り (フォームで直す)
    devices: list[torch.device] = []

    def unsupported(cfg: object, device: torch.device) -> None:
        devices.append(device)
        raise ValueError(f"trainer.precision: bf16 は {device} で使えません")

    monkeypatch.setattr(ml_found.experiment, "check_precision", unsupported)
    text = "experiment:\n  device: cpu\ntrainer:\n  precision: bf16\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert result["error"] == "trainer.precision: bf16 は cpu で使えません"
    assert result["config"]["trainer"]["precision"] == "bf16"
    assert devices == [torch.device("cpu")]

    # cuda と mps では GPU の文脈を持たないように不使用 (学習のプロセスで確認)
    for name in ["cuda", "mps"]:
        monkeypatch.setattr(
            "ml_found.utils.get_device",
            lambda value, name=name: torch.device(name)
        )
        text = (
            f"experiment:\n  device: {name}\ntrainer:\n  precision: bf16\n"
        )
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is True, result["error"]
        assert result["config"]["trainer"]["precision"] == "bf16"
    assert devices == [torch.device("cpu")]
    monkeypatch.undo()

    # 始める前に読む重みは, 無いファイルと重みの辞書でないファイルがエラー
    text = "trainer:\n  init_weights:\n    path: weights/missing.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "weights/missing.pt" in result["error"]
    (project_dir / "weights").mkdir()
    torch.save([1, 2], project_dir / "weights" / "list.pt")
    text = "trainer:\n  init_weights:\n    path: weights/list.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    torch.save(
        torch.nn.Linear(2, 1).state_dict(), project_dir / "weights" / "ok.pt"
    )
    text = "trainer:\n  init_weights:\n    path: weights/ok.pt\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    assert result["warnings"] == []


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

    # warmup の割合を書いた場合は, auto は残りで, 回数に直すこともお知らせ
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": text + "  warmup_ratio: 0.1\n"}
    ).json()
    assert result["ok"] is True
    assert "warmup の後の残り" in result["notes"][0]
    assert "0.1 倍" in result["notes"][1]

    # auto と書けない引数 (範囲を持たない eta_min) は値の誤り
    result = client.post(
        f"/api/projects/{project_id}/validate",
        json={"text": text + "    eta_min: auto\n"}
    ).json()
    assert result["ok"] is False
    assert "eta_min には auto と書けません" in result["error"]


def test_validate_named_optimizers(
    client: TestClient, project_dir: Path
) -> None:
    """
    名前付きの複数の Optimizer (optimizers) の config で, 引数の範囲の誤りと
    補う Scheduler の引数のお知らせを, 名前を付けて返すことを確かめる関数

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
    # default を名前付きの 2 つの Optimizer に変更
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "optimizers:\n"
        "  discriminator:\n    name: Adam\n    modules: [discriminator]\n"
        "  generator:\n    name: Adam\n    modules: [generator]\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 範囲の外の値は, どの Optimizer かを付けた誤り
    text = "optimizers:\n  generator:\n    params:\n      lr: -1\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "optimizers.generator" in result["error"]
    assert "lr は 0.0 以上" in result["error"]

    # Scheduler の auto は, 名前を付けたお知らせ
    text = (
        "optimizers:\n  generator:\n    scheduler:\n"
        "      name: CosineAnnealingLR\n      params:\n        T_max: auto\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True
    assert result["notes"][0].startswith("optimizers.generator: ")
    assert "T_max" in result["notes"][0]

    # 1 つ目の必須の引数の不足 (注意) があっても, 2 つ目の名前の誤りはエラー
    text = (
        "optimizers:\n  discriminator:\n    scheduler:\n      name: StepLR\n"
        "  generator:\n    params:\n      lrr: 0.1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "optimizers.generator" in result["error"]
    assert "lrr" in result["error"]

    # trainer の値の参照 (${...}) も, 名前ごとの確認で解決
    text = (
        "trainer:\n  epochs: ${experiment.seed}\n"
        "optimizers:\n  generator:\n    scheduler:\n"
        "      name: OneCycleLR\n      params:\n        max_lr: 0.1\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert "InterpolationKeyError" not in (result.get("error") or "")

    # 一番上の optimizer は書けない
    result = client.post(
        url, json={"text": "optimizer:\n  name: SGD\n"}
    ).json()
    assert result["ok"] is False
    assert "optimizers.<名前>" in result["error"]


def test_validate_missing_paths(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    パスの項目のファイルが無い場合に, 起動を止めずに注意することを
    確かめる関数

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
    url = f"/api/projects/{project_id}/validate"
    (project_dir / "data").mkdir()
    (project_dir / "data" / "train.csv").write_text("x\n")
    outside = tmp_path / "absent.csv"

    # default の項目も対象 (experiment で書き換えた値で確認)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n"
        "  train_path: data/train.csv\n"
        "  valid_path: data/train.csv\n"
        "  cache_dir: cache\n"
        "  Vocab_FILE: ''\n"
        "  test_file: null\n"
        "  remote_path: https://example.com/train.csv\n"
        "  ref_path: ${data.valid_path}\n"
        "  sizes_path: 3\n"
        "  splits: [missing.csv]\n"
        "  data_dir: data\n"
        "  profile: simple\n"
        "  model_name_or_path: org/model\n"
        "  home_dir: '~'\n"
        "  user_dir: ~no_such_user_for_test/data\n"
    )
    text = (
        "data:\n"
        "  valid_path: data/valid.csv\n"
        f"  test_file: {outside}\n"
    )
    result = client.post(url, json={"text": text}).json()

    # 無いものだけを注意, 相対パスにはプロジェクトのディレクトリからと明記
    assert result["ok"] is True, result["error"]
    assert result["warnings"] == [
        "data.cache_dir のディレクトリが見つかりません: cache "
        "(プロジェクトのディレクトリから)",
        f"data.test_file のファイルが見つかりません: {outside}",
        "data.user_dir のディレクトリが見つかりません: "
        "~no_such_user_for_test/data (プロジェクトのディレクトリから)",
        "data.valid_path のファイルが見つかりません: data/valid.csv "
        "(プロジェクトのディレクトリから)"
    ]

    # ML-Found が作る出力先と, ML-Found が確かめる再開元は対象外
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: not_yet\n"
    )
    result = client.post(url, json={"text": "{}\n"}).json()
    assert result["ok"] is True
    assert result["warnings"] == []
    resume = client.post(
        url, json={"text": "trainer:\n  resume_from: missing/last.pt\n"}
    ).json()
    assert resume["ok"] is False
    assert "resume_from" in resume["error"]

    # 再開元はファイルが無くても, パスの確認では注意にしない
    assert describe_missing_path(
        "trainer.resume_from", "missing/last.pt", project_dir
    ) is None


def test_relaunch_plan(
    client: TestClient, project_dir: Path, tmp_path: Path
) -> None:
    """
    実験の起動のしかたから, もう一度起動する設定をまとめることを確かめる関数

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
    run_dir = project_dir / "outputs" / "demo" / "2026-11-08" / "10-00-00"
    url = (
        f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/relaunch"
    )
    source = run_dir / "source.yaml"

    def plan(text: str) -> dict:
        source.write_text(text)
        # 後から書き換えたファイルと区別できるように, 古い時刻に設定
        os.utime(source, (0, 0))
        result: dict = client.get(url).json()
        return result

    # source.yaml の無い実験は, 理由だけ
    old = client.get(url).json()
    assert old["script"] is None
    assert "source.yaml" in old["reason"]
    # 理由は今の条件だけで, 版の経緯を書かない
    assert "古い" not in old["reason"]
    missing = client.get(
        f"/api/projects/{project_id}/runs/demo/2026-11-08/12-00-00/relaunch"
    )
    assert missing.status_code == 404

    # プロジェクトの config と上書き: config を選び, 上書きを重ねた中身
    examples = project_dir / "configs" / "experiment" / "examples"
    (examples / "a.yaml").write_text(
        "# 例\noptimizer:\n  name: Adam\n  params:\n    lr: 0.1\n"
    )
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/examples/a.yaml\n"
        "overrides:\n- trainer.epochs=3\n- optimizer.name=SGD\n"
    )
    assert result["reason"] is None
    assert result["script"] == "train.py"
    assert result["default_config"] == "configs/default/train.yaml"
    assert result["config_path"] == "configs/experiment/examples/a.yaml"
    # クラスを変える上書きは, ML-Found と同じく experiment の引数を捨てる
    assert OmegaConf.to_container(OmegaConf.create(result["config_text"])) == {
        "optimizer": {"name": "SGD", "params": {}},
        "trainer": {"epochs": 3}
    }
    assert any("trainer.epochs=3" in note for note in result["notes"])
    assert any("書き換えられています" in note for note in result["notes"])

    # 上書きが無ければ, ファイルの中身そのまま
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\noverrides: []\n"
    )
    assert result["config_text"] == "{}\n"
    assert result["config_path"] == "configs/experiment/train.yaml"

    # 画面から起動した学習の config (ジョブの置き場) は中身だけ
    job_config = tmp_path / "home" / "jobs" / "0123456789ab" / "a.yaml"
    job_config.parent.mkdir(parents=True)
    job_config.write_text("trainer:\n  epochs: 2\n")
    result = plan(
        f"script: train.py\ndefault: configs/default/train.yaml\n"
        f"experiment: {job_config.resolve()}\noverrides: []\n"
    )
    assert result["reason"] is None
    assert result["config_path"] is None
    assert result["config_text"] == "trainer:\n  epochs: 2\n"

    # プロジェクトとジョブの置き場の外, 無いファイル, 出力先の変更は理由
    outside = tmp_path / "outside.yaml"
    outside.write_text("{}\n")
    for experiment, message in (
        (str(outside), "だけを読みます"),
        ("../outside.yaml", "だけを読みます"),
        ("train.py", "だけを読みます"),
        ("configs/experiment/gone.yaml", "見つかりません")
    ):
        result = plan(
            f"script: train.py\ndefault: configs/default/train.yaml\n"
            f"experiment: {experiment}\n"
        )
        assert message in result["reason"]
        assert result["config_text"] is None
    result = plan(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
        "overrides:\n- experiment.output_dir=elsewhere\n"
    )
    assert "output_dir" in result["reason"]

    # 無いスクリプト, 記録の無いスクリプトと config も理由
    result = plan("script: train_gone.py\n")
    assert "train_gone.py" in result["reason"]
    result = plan("script: null\ndefault: configs/default/train.yaml\n")
    assert "スクリプト" in result["reason"]
    result = plan("script: train.py\ndefault: null\nexperiment: null\n")
    assert result["script"] == "train.py"
    assert "load_config" in result["reason"]

    # configs/default に無い default は使わず, お知らせ
    result = plan(
        "script: train.py\ndefault: /elsewhere/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
    )
    assert result["reason"] is None
    assert result["default_config"] is None
    assert any("/elsewhere/train.yaml" in note for note in result["notes"])


def test_relaunch_model_spec(
    client: TestClient, project_dir: Path
) -> None:
    """
    実験に写したモデルの定義が記録と合えば, その写しで起動し直し, 使えない
    場合は今の定義に戻すことを確かめる関数

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
    relative = "outputs/demo/2026-11-08/10-00-00"
    run_dir = project_dir / relative
    url = f"/api/projects/{project_id}/runs/demo/2026-11-08/10-00-00/relaunch"
    copy = run_dir / "model_spec.yaml"
    content = b"layers:\n- type: Linear\n"
    copy.write_bytes(content)
    sha = hashlib.sha256(content).hexdigest()
    experiment = project_dir / "configs" / "experiment" / "train.yaml"
    experiment.write_text(
        "# 例\nmodel:\n  spec: models/model.yaml\n  hidden_dim: 8\n"
    )

    def plan(status: str = "copied", digest: str = sha) -> dict:
        (run_dir / "source.yaml").write_text(
            "script: train.py\ndefault: configs/default/train.yaml\n"
            "experiment: configs/experiment/train.yaml\n"
            "model_spec:\n  path: models/model.yaml\n"
            f"  status: {status}\n  sha256: '{digest}'\n"
        )
        result: dict = client.get(url).json()
        assert result["reason"] is None
        return result

    # 記録と合う写しは, model.spec をその場所に書き換えて使う. 戻す値は
    # experiment の config の今の値
    result = plan()
    assert result["model_spec"] == f"{relative}/model_spec.yaml"
    assert result["model_spec_original"] == "models/model.yaml"
    assert result["config_path"] == "configs/experiment/train.yaml"
    assert OmegaConf.to_container(OmegaConf.create(result["config_text"])) == {
        "model": {
            "spec": f"{relative}/model_spec.yaml", "hidden_dim": 8
        }
    }
    assert "この実験に写した定義" in result["model_spec_note"]
    assert "models/model.yaml" in result["model_spec_note"]
    assert not any("モデルの定義" in note for note in result["notes"])

    # 中身が記録と違う写し, 写していない実験, 知らない status は今の定義
    for status, digest, message in (
        ("copied", "0" * 64, "中身が"),
        ("missing", sha, "定義のファイルが無い"),
        ("renamed", sha, "(renamed)"),
    ):
        result = plan(status, digest)
        assert result["model_spec"] is None
        assert result["model_spec_note"] is None
        assert "spec: models/model.yaml" in result["config_text"]
        assert any(
            "今のプロジェクトの models/model.yaml" in note
            and message in note for note in result["notes"]
        ), status

    # 外部の重みのファイルを読む定義と, 16 MiB を超える写しは今の定義
    for text, message in (
        (b"nodes:\n  a:\n    weights: {path: w.pt}\n", "weights.path"),
        (b"x" * (16 * 1024 * 1024 + 1), "16 MiB"),
        # 自分を指す別名, 重ねた別名, 深い入れ子でも止まらない
        (b"nodes: &n {a: *n}\n", "別名"),
        (
            b"a: &a [x, x, x, x, x, x, x, x, x]\n" + b"".join(
                f"{chr(98 + index)}: &{chr(98 + index)} "
                f"[*{chr(97 + index)}, *{chr(97 + index)}, "
                f"*{chr(97 + index)}]\n".encode()
                for index in range(20)
            ), "別名"
        ),
        (b"[" * 5000 + b"]" * 5000 + b"\n", "100 段"),
        # 辞書の 1 段と並びの 100 段で, 上限の 100 段を超える
        (b"a: " + b"[" * 100 + b"]" * 100 + b"\n", "100 段"),
        (
            b"nodes:\n  a: {weights: {path: first.pt}}\n"
            b"  b: {weights: {path: second.pt}}\n", "first.pt"
        ),
    ):
        copy.write_bytes(text)
        result = plan(digest=hashlib.sha256(text).hexdigest())
        assert result["model_spec"] is None
        assert any(message in note for note in result["notes"])
    copy.write_bytes(content)

    # model が辞書でない experiment の config も今の定義
    experiment.write_text("model: 3\n")
    result = plan()
    assert result["model_spec"] is None
    assert any("辞書ではありません" in note for note in result["notes"])

    # 写しから起動し直した実験の config (model.spec が写しを指す) で写しが
    # 使えなければ, model.spec を消して default の値に戻す
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "model:\n  spec: models/base.yaml\n"
    )
    experiment.write_text(
        f"model:\n  spec: {relative}/model_spec.yaml\n"
    )
    result = plan(digest="0" * 64)
    assert result["model_spec"] is None
    assert "spec" not in result["config_text"]
    assert any(
        "今のプロジェクトの models/base.yaml" in note
        for note in result["notes"]
    )
    # 使える場合は戻す値を消すこと (None) にする
    result = plan()
    assert result["model_spec"] == f"{relative}/model_spec.yaml"
    assert result["model_spec_original"] is None
    assert "models/base.yaml" in result["model_spec_note"]

    # 消えた実験の写しを指す config も, 出力先の下の model_spec.yaml なので
    # default の値に戻す
    experiment.write_text(
        "model:\n  spec: outputs/demo/2026-11-08/09-00-00/model_spec.yaml\n"
    )
    result = plan(digest="0" * 64)
    assert "spec" not in result["config_text"]

    # 今の定義が記録と同じ中身か違う中身かを言い切る
    (project_dir / "models").mkdir()
    (project_dir / "models" / "base.yaml").write_bytes(content)
    result = plan(status="missing")
    assert any(
        "記録と同じ中身です. 外部の重みのファイルは比べていません" in note
        for note in result["notes"]
    )
    (project_dir / "models" / "base.yaml").write_bytes(b"layers: []\n")
    result = plan(status="missing")
    assert any("違うモデルになります" in note for note in result["notes"])

    # model_spec の無い実験は何も足さない
    experiment.write_text("{}\n")
    (run_dir / "source.yaml").write_text(
        "script: train.py\ndefault: configs/default/train.yaml\n"
        "experiment: configs/experiment/train.yaml\n"
    )
    result = client.get(url).json()
    assert result["model_spec"] is None
    assert result["model_spec_note"] is None
    assert not any("モデルの定義" in note for note in result["notes"])


def test_model_spec_copy_place(project_dir: Path, tmp_path: Path) -> None:
    """
    写しを使えない場所 (プロジェクトの外, 途中のリンク, 写しのリンク,
    ${ と ~) を見分けることを確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    content = b"layers: []\n"
    record = RunModelSpec(
        path="models/model.yaml", status="copied",
        sha256=hashlib.sha256(content).hexdigest()
    )

    def place(run_dir: Path) -> Optional[str]:
        run_dir.mkdir(parents=True, exist_ok=True)
        if not (run_dir / "model_spec.yaml").exists():
            (run_dir / "model_spec.yaml").write_bytes(content)
        path, reason = find_model_spec_copy(project_dir, run_dir, record)
        assert (path is None) != (reason is None)
        return reason

    # プロジェクトの中の普通の場所は使える
    assert place(project_dir / "outputs" / "ok") is None

    # 外と, 途中のリンクは理由を分ける
    outside = place(tmp_path / "outside_run")
    assert outside is not None and "外にあります" in outside
    (project_dir / "linked").symlink_to(
        tmp_path / "outside_run", target_is_directory=True
    )
    linked = place(project_dir / "linked")
    assert linked is not None and "途中にシンボリックリンク" in linked

    # 写し自体のリンクと, 無い写し
    run_dir = project_dir / "outputs" / "copy_link"
    run_dir.mkdir(parents=True)
    (run_dir / "model_spec.yaml").symlink_to(
        tmp_path / "outside_run" / "model_spec.yaml"
    )
    reason = place(run_dir)
    assert reason is not None and "写した定義 (model_spec.yaml) が" in reason
    assert "シンボリックリンクです" in reason
    (run_dir / "model_spec.yaml").unlink()
    path, reason = find_model_spec_copy(project_dir, run_dir, record)
    assert reason is not None and "ありません" in reason

    # config の参照とホームの展開に読まれる場所
    for name in ("${oops}", "~home"):
        reason = place(project_dir / name / "run")
        assert reason is not None and "書けません" in reason, name


def test_own_model_spec_name(client: TestClient, tmp_path: Path) -> None:
    """
    出力先が . のプロジェクトで, 自分の定義の models/model_spec.yaml を
    消えた実験の写しとみなさないことを確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    tmp_path: Path
        pytest が用意する一時ディレクトリ

    Returns
    ----------
    None
    """
    project_dir = tmp_path / "dot_project"
    (project_dir / "configs" / "default").mkdir(parents=True)
    (project_dir / "configs" / "experiment").mkdir(parents=True)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: .\n"
        "model:\n  spec: models/model_spec.yaml\n"
    )
    (project_dir / "configs" / "experiment" / "train.yaml").write_text(
        "{}\n"
    )
    (project_dir / "models").mkdir()
    (project_dir / "models" / "model_spec.yaml").write_text("layers: []\n")
    (project_dir / "train.py").write_text("print('train')\n")
    assert run_of_copy(project_dir, "models/model_spec.yaml") is None
    # 実験の形 (<名前>/<日付>/<時刻>/) の深さなら, 消えた実験の写し
    assert run_of_copy(
        project_dir, "demo/2026-11-08/10-00-00/model_spec.yaml"
    ) == project_dir / "demo/2026-11-08/10-00-00"

    project_id = register(client, project_dir)
    response = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py",
            "config_text": "model:\n  spec: models/model_spec.yaml\n"
        }
    )
    assert response.status_code == 201, response.json()


def test_launch_rechecks_model_spec(
    client: TestClient, project_dir: Path
) -> None:
    """
    model.spec が実験に写した定義を指す起動では, 写しを確かめ直し, 記録と
    違えば起動しないことを確かめる関数

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
    relative = "outputs/demo/2026-11-08/10-00-00"
    run_dir = project_dir / relative
    content = b"layers: []\n"
    (run_dir / "model_spec.yaml").write_bytes(content)
    (run_dir / "source.yaml").write_text(
        "script: train.py\nmodel_spec:\n  path: models/model.yaml\n"
        f"  status: copied\n  sha256: '{hashlib.sha256(content).hexdigest()}'"
        "\n"
    )
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "model:\n  spec: models/model.yaml\n"
    )
    body = {
        "script": "train.py",
        "config_text": f"model:\n  spec: {relative}/model_spec.yaml\n"
    }

    # 起動の画面を開いた後に写しが書き換わった場合は起動しない
    (run_dir / "model_spec.yaml").write_bytes(b"layers: [changed]\n")
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 400
    assert "起動しません" in response.json()["detail"]
    assert "中身が" in response.json()["detail"]

    assert response.json()["code"] == "model_spec_copy_refused"

    # 消えた実験の写しを指す config も起動しない
    gone = {
        "script": "train.py",
        "config_text": (
            "model:\n  spec: outputs/demo/2026-11-08/09-00-00/"
            "model_spec.yaml\n"
        )
    }
    response = client.post(f"/api/projects/{project_id}/jobs", json=gone)
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "その実験がありません" in detail
    assert detail.count("09-00-00") == 1

    # 別名を使う写しは, 500 にならず起動しない
    (run_dir / "model_spec.yaml").write_bytes(b"nodes: &n {a: *n}\n")
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 400

    # 記録と合えば起動する
    (run_dir / "model_spec.yaml").write_bytes(content)
    response = client.post(f"/api/projects/{project_id}/jobs", json=body)
    assert response.status_code == 201, response.json()


def test_launch_with_default_config(
    client: TestClient, project_dir: Path
) -> None:
    """
    起動の前の確認に, 指定した default の config を使うことを確かめる関数

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
    # train.py の名前からは train.yaml を選ぶが, hf.yaml を指定して確認
    (project_dir / "configs" / "default" / "hf.yaml").write_text(
        "experiment:\n  name: demo_hf\n  output_dir: outputs_hf\n"
        "data:\n  n_train: 10\n"
    )
    (project_dir / "train.py").write_text("print('done')\n")
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    text = "data:\n  n_train: 20\n"
    body = {"text": text, "script": "train.py"}
    assert client.post(url, json=body).json()["ok"] is False
    hf = client.post(
        url, json=body | {"default_config": "configs/default/hf.yaml"}
    ).json()
    assert hf["ok"] is True
    assert hf["default_config"] == "configs/default/hf.yaml"

    # configs/default の外と, 無いファイルは受け付けない
    for bad in (
        "configs/experiment/train.yaml", "../outside.yaml",
        "configs/default/gone.yaml"
    ):
        rejected = client.post(url, json=body | {"default_config": bad})
        assert rejected.status_code == 400
    rejected = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py", "config_text": text,
            "default_config": "../train.yaml"
        }
    )
    assert rejected.status_code == 400

    # 起動したジョブに記録し, もう一度起動しても同じ default で確認
    created = client.post(
        f"/api/projects/{project_id}/jobs",
        json={
            "script": "train.py", "config_text": text,
            "default_config": "configs/default/hf.yaml"
        }
    )
    assert created.status_code == 201
    assert created.json()["default_config"] == "configs/default/hf.yaml"
    wait_for(client, created.json()["id"], "status", "finished")
    again = client.post(f"/api/jobs/{created.json()['id']}/rerun")
    assert again.status_code == 201
    assert again.json()["default_config"] == "configs/default/hf.yaml"
    wait_for(client, again.json()["id"], "status", "finished")


def test_validate_hides_env_values(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    環境変数を参照する config の確かめの応答に, その値が含まれないことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数を置き換える pytest の仕組み

    Returns
    ----------
    None
    """
    secret, other = "s3cr3t-token-value", "an0ther-hidden-value"
    monkeypatch.setenv("ML_DASHBOARD_TEST_SECRET", secret)
    monkeypatch.setenv("ML_DASHBOARD_TEST_OTHER", other)
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n"
        "  token: plain\n  url: plain\n  alias: plain\n  nested: plain\n"
        "  tokens: []\n  name: plain\n"
        "  key: ${oc.env:ML_DASHBOARD_TEST_OTHER}\n"
        "  env_name: ML_DASHBOARD_TEST_SECRET\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # そのまま, 文字の中, 他の項目を介した参照, 入れ子, リストの中
    text = (
        "data:\n"
        "  token: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n"
        "  url: https://user:${oc.env:ML_DASHBOARD_TEST_SECRET}@example.com\n"
        "  alias: ${data.token}\n"
        "  nested: ${oc.env:ML_DASHBOARD_TEST_NONE,"
        "${oc.env:ML_DASHBOARD_TEST_SECRET}}\n"
        "  tokens: ['${oc.env:ML_DASHBOARD_TEST_SECRET}']\n"
        "  name: ${experiment.name}\n"
        "  key: changed\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is True, result["error"]
    body = json.dumps(result)
    assert secret not in body
    assert other not in body

    # 書いたままの値を返し, 環境変数を引かない参照は解決
    data = result["config"]["data"]
    assert data["token"] == "${oc.env:ML_DASHBOARD_TEST_SECRET}"
    assert data["alias"] == "${data.token}"
    assert data["tokens"] == ["${oc.env:ML_DASHBOARD_TEST_SECRET}"]
    assert data["name"] == "demo"
    assert result["diff"]["data.url"] == {
        "default": "plain",
        "experiment": "https://user:${oc.env:ML_DASHBOARD_TEST_SECRET}"
        "@example.com"
    }
    assert result["diff"]["data.key"] == {
        "default": "${oc.env:ML_DASHBOARD_TEST_OTHER}",
        "experiment": "changed"
    }

    # 値の誤り, 読み込めない誤り, 起動の誤りの文にも値を出さない
    for text in (
        "optimizer:\n  name: SGD\n  params:\n"
        "    lr: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        "experiment:\n  name: bad/${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        "trainer:\n  epochs: ${oc.env:ML_DASHBOARD_TEST_SECRET}\n",
        # 名前を参照で決める場合も, 解決した名前の値を出さない
        "optimizer:\n  name: SGD\n  params:\n"
        "    lr: ${oc.env:${data.env_name}}\n"
    ):
        result = client.post(url, json={"text": text}).json()
        assert result["ok"] is False
        assert "${oc.env:ML_DASHBOARD_TEST_SECRET}" in result["error"]
        assert secret not in json.dumps(result)

        launched = client.post(
            f"/api/projects/{project_id}/jobs",
            json={"script": "train.py", "config_text": text}
        )
        assert launched.status_code == 400
        assert secret not in launched.text


def test_validate_uses_env_values(
    client: TestClient, project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    値を使う確かめは, 環境変数を解決した値で今までどおり働くことを
    確かめる関数

    Parameters
    ----------
    client: TestClient
        API を呼ぶクライアント
    project_dir: Path
        プロジェクトのディレクトリ
    monkeypatch: pytest.MonkeyPatch
        環境変数を置き換える pytest の仕組み

    Returns
    ----------
    None
    """
    monkeypatch.setenv("ML_DASHBOARD_TEST_EPOCHS", "7")
    monkeypatch.setenv("ML_DASHBOARD_TEST_DEVICE", "gpu")
    (project_dir / "configs" / "default" / "train.yaml").write_text(
        "experiment:\n  name: demo\n  output_dir: outputs\n"
        "data:\n  train_path: missing.csv\n"
    )
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"

    # 解決した値で範囲を確かめ, 食い違いの誤りの文は参照の書き方で出す
    text = (
        "trainer:\n  epochs: ${oc.env:ML_DASHBOARD_TEST_EPOCHS}\n"
        "scheduler:\n  name: OneCycleLR\n"
        "  params:\n    max_lr: 0.1\n    epochs: 3\n"
    )
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "trainer.epochs (${oc.env:ML_DASHBOARD_TEST_EPOCHS})" in (
        result["error"]
    )
    assert result["config"]["trainer"]["epochs"] == (
        "${oc.env:ML_DASHBOARD_TEST_EPOCHS}"
    )

    # 解決した値のデバイスを確かめ, 他の項目の場所の確かめも今までどおり
    text = "experiment:\n  device: ${oc.env:ML_DASHBOARD_TEST_DEVICE}\n"
    result = client.post(url, json={"text": text}).json()
    assert result["ok"] is False
    assert "experiment.device の誤り" in result["error"]
    assert "gpu" not in json.dumps(result)
    assert result["warnings"] == [
        "data.train_path のファイルが見つかりません: missing.csv "
        "(プロジェクトのディレクトリから)"
    ]


def test_validate_monitor_in_default(
    client: TestClient, project_dir: Path
) -> None:
    """
    default の config が監視する指標を書いているかを, 確かめの結果に返す
    ことを確かめる関数

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
    # 書いていない default (読めない experiment の config でも返す)
    project_id = register(client, project_dir)
    url = f"/api/projects/{project_id}/validate"
    ok = client.post(url, json={"text": "{}\n"}).json()
    assert ok["ok"] is True
    assert ok["monitor_in_default"] is False
    assert ok["mode_in_default"] is False
    assert ok["config"]["trainer"]["monitor"] is None
    typo = client.post(url, json={"text": "trainer:\n  epoch: 3\n"}).json()
    assert typo["ok"] is False
    assert typo["monitor_in_default"] is False

    # experiment の config に書いても default の値ではない
    written = client.post(
        url, json={"text": "trainer:\n  monitor: valid/acc\n  mode: max\n"}
    ).json()
    assert written["ok"] is True, written
    assert written["monitor_in_default"] is False
    assert written["config"]["trainer"]["monitor"] == "valid/acc"

    # default に書くと True. null は書いていないものとみなす
    default = project_dir / "configs" / "default" / "train.yaml"
    base = default.read_text()
    default.write_text(base + "trainer:\n  monitor: valid/loss\n")
    assert client.post(url, json={"text": "{}\n"}).json()[
        "monitor_in_default"
    ] is True
    default.write_text(base + "trainer:\n  monitor: null\n  mode: max\n")
    written = client.post(url, json={"text": "{}\n"}).json()
    assert written["monitor_in_default"] is False
    assert written["mode_in_default"] is True
