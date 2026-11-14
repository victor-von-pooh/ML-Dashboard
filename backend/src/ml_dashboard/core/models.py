from typing import Any, Literal, Optional, Union

from pydantic import BaseModel

# 実験の状態, unknown は中断したか実行中か分からないもの
RunStatus = Literal["running", "completed", "stopped", "failed", "unknown"]

# 監視する指標の向き
Mode = Literal["min", "max"]

# ファイルの種類
FileKind = Literal["image", "checkpoint", "text", "other"]


class ProjectInfo(BaseModel):
    id: str
    name: str
    path: str
    python: str
    created_at: str
    run_count: int
    latest_run: Optional[str]
    error: Optional[str] = None


class ProjectDetail(ProjectInfo):
    output_dirs: list[str]
    scripts: list[str]
    experiment_configs: list[str]


class ProjectCandidate(BaseModel):
    path: str
    name: str
    registered: bool


class BestValue(BaseModel):
    monitor: str
    mode: Mode
    epoch: int
    value: float


class Progress(BaseModel):
    phase: str
    epoch: int
    total_epochs: int
    batch: int
    total_batches: Optional[int]
    elapsed_sec: float
    updated_at: str
    start_epoch: int = 1


class RunSummary(BaseModel):
    id: str
    name: str
    started_at: str
    status: RunStatus
    epochs: int
    planned_epochs: Optional[int]
    best: Optional[BestValue]
    duration_sec: Optional[float]
    early_stopped_epoch: Optional[int]
    diff: dict[str, Any]
    final_metrics: dict[str, Optional[float]]
    progress: Optional[Progress]
    error: Optional[str]


class LogEntry(BaseModel):
    time: Optional[str]
    level: Optional[str]
    message: str


class EnvSection(BaseModel):
    title: str
    items: dict[str, str]


class RunFile(BaseModel):
    path: str
    size: int
    kind: FileKind


class ModelParam(BaseModel):
    # ML-Found の model_summary.csv の 1 行 (パラメータかバッファ)
    name: str
    kind: str
    module: str
    shape: str
    dtype: str
    numel: int
    requires_grad: bool
    # 重みを共有している場合は, 最初の名前
    same_as: str = ""


class RunDetail(RunSummary):
    config: dict[str, Any]
    seed: Optional[int]
    device: Optional[str]
    parameter_count: Optional[int]
    model_structure: Optional[str]
    optimizer: Optional[str]
    scheduler: Optional[str]
    env: list[EnvSection]
    packages: dict[str, str]
    files: list[RunFile]
    has_git_diff: bool
    # final_model.pt の重み (best, last, エポックの途中で止めて戻せなかった
    # partial), run.json が無い古い実験は None
    final_weights: Optional[Literal["best", "last", "partial"]] = None
    # パラメータとバッファの一覧 (model_summary.csv, 多い場合は先頭だけ) と
    # 全体の行数, ファイルが無い古い実験は None
    model_summary: Optional[list[ModelParam]] = None
    model_summary_rows: Optional[int] = None


class LrPoint(BaseModel):
    # エポックの軸の上の位置 (エポック e の更新を e から e + 1 の間に等間隔)
    x: float
    lr: Optional[float]


class History(BaseModel):
    columns: list[str]
    rows: list[dict[str, Optional[float]]]
    # step ごとに学習率を変えた実験の, 更新ごとの学習率 (lr_steps.csv の lr)
    lr_steps: list[LrPoint] = []
    # 複数の Optimizer の実験の, 列 (lr_<名前>) ごとの更新ごとの学習率
    named_lr_steps: dict[str, list[LrPoint]] = {}


# 分析に使う config の値 (入れ子は . でつないだ項目, 配列は JSON の文字列)
ParamValue = Union[bool, float, str, None]


class RunParams(BaseModel):
    id: str
    name: str
    started_at: str
    status: RunStatus
    best: Optional[BestValue]
    final_metrics: dict[str, Optional[float]]
    params: dict[str, ParamValue]
