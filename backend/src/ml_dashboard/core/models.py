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
    # フェーズの中の段階 (batches か epoch_end. 前の版の ML-Found は書かない)
    stage: str = "batches"
    elapsed_sec: float
    updated_at: str
    start_epoch: int = 1


class RunSource(BaseModel):
    # 実験の起動のしかた (ML-Found の source.yaml). 実行したスクリプト,
    # default と experiment の config のパス, 「項目=値」の上書き. 分からない
    # ものは None
    script: Optional[str] = None
    default: Optional[str] = None
    experiment: Optional[str] = None
    overrides: Optional[list[str]] = None


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
    # 起動のしかた (source.yaml), 書いていない古い実験は None
    source: Optional[RunSource] = None


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


class OptimizerInfo(BaseModel):
    # ML-Found の run.json の optimizers の 1 つ (名前付きの場合は名前と
    # 受け持つ部分, 1 つの Optimizer の場合は None)
    name: Optional[str] = None
    optimizer: str
    modules: Optional[list[str]] = None
    scheduler: Optional[str] = None


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
    # Optimizer ごとの名前, クラス, 受け持つ部分, Scheduler (run.json の
    # optimizers), 書いていない古い実験は None
    optimizers: Optional[list[OptimizerInfo]] = None
    # 監視する指標 (ベストモデルを選ばない実験でも最後の値を出すため)
    monitor: Optional[str] = None
    # 読めなかったファイルなど, 表示の値が確かでない理由 (画面に注意として出す)
    notices: list[str] = []


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


class TaskOrigin(BaseModel):
    # 正解の出どころ (ML-Found の task.yaml の target.origin). type は
    # process, annotation, measurement, synthetic, unknown のどれか
    type: str
    name: Optional[str] = None
    settings: Any = None


class RunLink(BaseModel):
    # ダッシュボードの実験の詳細へのつなぎ
    project_id: str
    run_id: str


class RunTask(BaseModel):
    # 何の実験か (ML-Found の task.yaml). 分からない値は None
    format_version: int
    # 知っている版より新しい task.yaml (正解の出どころは unknown に置き換え)
    newer_version: bool = False
    role: Optional[str] = None
    output: Optional[str] = None
    what: Optional[str] = None
    target_kind: Optional[str] = None
    origin: TaskOrigin
    # 指標が何との一致かの説明 (ML-Found の describe_origin)
    origin_note: str
    method: Optional[str] = None
    base_experiment: Optional[str] = None
    base_weights: Optional[str] = None
    # 元にした実験が登録したプロジェクトにある場合のつなぎ
    base_run: Optional[RunLink] = None
    dataset_name: Optional[str] = None
    dataset_path: Optional[str] = None


# 評価の表の値 (nan と無限大は null)
CellValue = Union[bool, int, float, str, None]


class Evaluation(BaseModel):
    # データ全体の評価 (ML-Found の evaluations/<名前>.json)
    name: str
    split: Optional[str] = None
    kind: str
    x: Optional[str] = None
    columns: list[str]
    rows: list[dict[str, CellValue]]
    description: Optional[str] = None
    baseline: Optional[str] = None
    guard: bool = False
    epoch: Optional[int] = None
    created_at: Optional[str] = None
    # 行が多く, 先頭だけを返した場合の全体の行数
    total_rows: int


class Sample(BaseModel):
    # 見本の出力 (ML-Found の samples/index.json の 1 項目. 前からの形の
    # samples/ の直下の番号付きの画像は, 画像の推移で見るので含めない)
    name: str
    # エポック, 学習の後は None
    epoch: Optional[int] = None
    kind: str
    # 実験のディレクトリからの相対パス (samples/<名前>/epoch_0005.png など)
    path: str
    size: int
    split: Optional[str] = None
    caption: Optional[str] = None
    created_at: Optional[str] = None


class RunResults(BaseModel):
    # 実験の任意のファイル (task.yaml, evaluations/, samples/). 無い実験は
    # None と空のリスト
    task: Optional[RunTask] = None
    evaluations: list[Evaluation] = []
    samples: list[Sample] = []
    # 読めなかったファイルなど (画面に注意として出す)
    notices: list[str] = []
