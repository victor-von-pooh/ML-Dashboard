import argparse
import math
from pathlib import Path
import struct
import zlib

from omegaconf import DictConfig
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from ml_found import Experiment, Trainer, load_config, start_experiment

# 決定境界の画像の大きさ (ピクセル) と, 描く範囲
IMAGE_SIZE = 128
EXTENT = 1.3

# クラスごとの色 (RGB), 背景は白と混ぜて薄く表示
CLASS_COLORS = ((37, 99, 235), (234, 88, 12))


def parse_args() -> argparse.Namespace:
    """
    コマンドライン引数を読み込む関数

    Parameters
    ----------
    None

    Returns
    ----------
    args: argparse.Namespace
        コマンドライン引数, experiment の config のパスを持つ
    """
    # ML-Dashboard から起動した場合も同じ引数で config を切り替え
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--experiment", default="configs/experiment/train.yaml",
        help="experiment の config のパス, 相対パスはデモのディレクトリから"
    )
    args = parser.parse_args()

    return args


def make_spiral(
    n: int, noise: float, generator: torch.Generator
) -> tuple[torch.Tensor, torch.Tensor]:
    """
    2 本の渦巻きに沿った 2 クラスの点を作る関数

    Parameters
    ----------
    n: int
        点の数
    noise: float
        点の位置に加えるノイズの, 半径 1 での標準偏差 (半径に比例)
    generator: torch.Generator
        乱数の生成器

    Returns
    ----------
    x: torch.Tensor
        点の座標, 形は (n, 2)
    y: torch.Tensor
        クラスのラベル (0 か 1), 形は (n,)
    """
    # 半径を 0 から 1 まで増やしながら回転し, クラス 1 は半回転ずらした角度の計算
    y = torch.randint(0, 2, (n,), generator=generator)
    radius = torch.rand(n, generator=generator)
    angle = radius * 2 * math.pi + y * math.pi
    x = torch.stack(
        [radius * torch.cos(angle), radius * torch.sin(angle)], dim=1
    )
    x = x + noise * torch.randn(n, 2, generator=generator) * radius[:, None]

    return x, y


def make_loaders(cfg: DictConfig) -> tuple[DataLoader, DataLoader]:
    """
    渦巻きのデータから学習用と検証用の DataLoader を作る関数

    Parameters
    ----------
    cfg: DictConfig
        学習に使う config

    Returns
    ----------
    train_loader: DataLoader
        学習用の DataLoader
    valid_loader: DataLoader
        検証用の DataLoader
    """
    # 乱数のシードを固定して, 実験ごとに同じデータを作成
    generator = torch.Generator().manual_seed(cfg.experiment.seed)
    x_train, y_train = make_spiral(
        cfg.data.train_size, cfg.data.noise, generator
    )
    x_valid, y_valid = make_spiral(
        cfg.data.valid_size, cfg.data.noise, generator
    )
    train_loader = DataLoader(
        TensorDataset(x_train, y_train), batch_size=cfg.data.batch_size,
        shuffle=True
    )
    valid_loader = DataLoader(
        TensorDataset(x_valid, y_valid), batch_size=cfg.data.batch_size,
        shuffle=False
    )

    return train_loader, valid_loader


class SpiralClassifier(nn.Module):
    def __init__(self, hidden_dim: int):
        # 親クラスのコンストラクタを呼び出す
        super(SpiralClassifier, self).__init__()

        # 2 次元の座標から 2 クラスのスコアを出す多層パーセプトロン
        self.model = nn.Sequential(
            nn.Linear(2, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 2)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        順伝播を行う関数

        Parameters
        ----------
        x: torch.Tensor
            点の座標

        Returns
        ----------
        logits: torch.Tensor
            クラスごとのスコア
        """
        # 多層パーセプトロンを適用
        logits = self.model(x)

        return logits


def step(model: nn.Module, batch: tuple, phase: str) -> dict:
    """
    1 バッチ分の損失と正解率を求める関数

    Parameters
    ----------
    model: nn.Module
        学習するモデル
    batch: tuple
        点の座標と正解ラベル
    phase: str
        train または valid

    Returns
    ----------
    outputs: dict
        交差エントロピー損失と正解率
    """
    # 予測して損失と正解率を計算
    x, y = batch
    logits = model(x)
    ce = nn.CrossEntropyLoss()
    loss = ce(logits, y)
    acc = (logits.argmax(dim=1) == y).float().mean()
    outputs = {"loss": loss, "acc": acc}

    return outputs


def write_png(path: Path, rows: list[bytes], width: int) -> None:
    """
    RGB の画素の行を PNG として書き出す関数

    画像のライブラリに依存しないように, PNG の形式を直接書く

    Parameters
    ----------
    path: Path
        書き出す先
    rows: list[bytes]
        1 行ごとの RGB の画素 (width * 3 バイト)
    width: int
        画像の幅

    Returns
    ----------
    None
    """
    def chunk(kind: bytes, data: bytes) -> bytes:
        # 長さ, 種類, 中身, CRC の順に連結
        body = kind + data
        return (
            struct.pack(">I", len(data)) + body
            + struct.pack(">I", zlib.crc32(body))
        )

    # 各行の先頭にフィルタなし (0) を付けて圧縮
    header = struct.pack(">IIBBBBB", width, len(rows), 8, 2, 0, 0, 0)
    pixels = zlib.compress(b"".join(b"\x00" + row for row in rows))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
        + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


class SpiralTrainer(Trainer):
    def __init__(
        self, model: nn.Module, experiment: Experiment,
        valid_x: torch.Tensor, valid_y: torch.Tensor
    ):
        # 親クラスのコンストラクタを呼び出す
        super(SpiralTrainer, self).__init__(model, experiment, step)

        # 決定境界に重ねる検証用の点と, 画像の保存先
        self.valid_x = valid_x
        self.valid_y = valid_y
        self.image_dir = experiment.run_dir / "boundary"

    def on_epoch_end(self, phase: str) -> dict:
        """
        検証の後に, そのエポックの決定境界を画像に保存する関数

        Parameters
        ----------
        phase: str
            学習時は train, 検証時は valid

        Returns
        ----------
        metrics: dict
            追加の指標 (無し)
        """
        # 検証の後だけ, 画像の全ての画素でクラス 1 の確率を予測
        if phase != "valid":
            return {}
        axis = torch.linspace(-EXTENT, EXTENT, IMAGE_SIZE)
        grid_y, grid_x = torch.meshgrid(-axis, axis, indexing="ij")
        grid = torch.stack([grid_x.flatten(), grid_y.flatten()], dim=1)
        grid = grid.to(next(self.model.parameters()).device)
        with torch.no_grad():
            probs = self.model(grid).softmax(dim=1)[:, 1].view(
                IMAGE_SIZE, IMAGE_SIZE
            ).cpu()

        # 背景は確率に応じて 2 クラスの色を混ぜ, 白と半分ずつ混ぜて薄く表示
        pixels = [[(0, 0, 0)] * IMAGE_SIZE for _ in range(IMAGE_SIZE)]
        for row in range(IMAGE_SIZE):
            for col in range(IMAGE_SIZE):
                p = float(probs[row, col])
                pixels[row][col] = tuple(
                    int(255 * 0.5 + 0.5 * ((1 - p) * c0 + p * c1))
                    for c0, c1 in zip(*CLASS_COLORS, strict=True)
                )

        # 検証用の点を, 正解のクラスの色の 2x2 の点で描画
        scale = (IMAGE_SIZE - 1) / (2 * EXTENT)
        points = zip(
            self.valid_x.tolist(), self.valid_y.tolist(), strict=True
        )
        for (x, y), label in points:
            col = round((x + EXTENT) * scale)
            row = round((EXTENT - y) * scale)
            for r in (row, row + 1):
                for c in (col, col + 1):
                    if 0 <= r < IMAGE_SIZE and 0 <= c < IMAGE_SIZE:
                        pixels[r][c] = CLASS_COLORS[label]

        rows = [bytes(v for pixel in line for v in pixel) for line in pixels]
        write_png(
            self.image_dir / f"epoch_{self.epoch:03d}.png", rows, IMAGE_SIZE
        )

        return {}


# config を読み込んで実験を開始
args = parse_args()
project_dir = Path(__file__).resolve().parent
experiment_path = Path(args.experiment)
if not experiment_path.is_absolute():
    experiment_path = project_dir / experiment_path
cfg, diff = load_config(
    str(project_dir / "configs/default/train.yaml"), str(experiment_path)
)
experiment = start_experiment(cfg, diff, str(project_dir))

# データとモデルを用意して学習
train_loader, valid_loader = make_loaders(cfg)
valid_x, valid_y = valid_loader.dataset.tensors
model = SpiralClassifier(cfg.model.hidden_dim)
trainer = SpiralTrainer(model, experiment, valid_x, valid_y)
trainer.fit(train_loader, valid_loader)
print(f"保存先: {experiment.run_dir}")
