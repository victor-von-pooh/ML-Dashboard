from typing import Any, Literal, Optional, Union

from pydantic import BaseModel

# 実験の状態, unknown は中断したか実行中か分からないもの
RunStatus = Literal["running", "completed", "stopped", "failed", "unknown"]

# 監視する指標の向き
Mode = Literal["min", "max"]

# ファイルの種類
FileKind = Literal["image", "checkpoint", "text", "other"]

# 評価の指標の向き (小さいほど良いか, 大きいほど良いか)
Better = Literal["lower", "higher"]

# 守る指標の判定 (落ちた, 保った, 判断できない)
GuardState = Literal["dropped", "kept", "unknown"]


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


class RecordedProject(BaseModel):
    # ML-Pathfinder の問題の設定に記録された, 登録していないプロジェクト
    path: str
    name: str
    # 記録した問題の設定の名前と problem.yaml の場所
    problem: str
    problem_path: str
    # problem.yaml の更新時刻 (読めなければ None)
    updated_at: Optional[str] = None


class RecordedProjects(BaseModel):
    # 置き場の problems, プロジェクト (更新の新しい順), 読まなかった問題の
    # 設定の理由 (新しい版など), 置き場を読めない場合の理由
    root: str
    projects: list[RecordedProject]
    skipped: list[str]
    error: Optional[str] = None


class ProblemTraining(BaseModel):
    # ML-Pathfinder の問題の設定 1 件の, 学習で監視する指標と向き
    # (ML-Quest の受け渡しの training. ML-Found の trainer.monitor と
    # trainer.mode と同じ値)
    problem: str
    problem_path: str
    # 書き出したプロジェクトの記録 (リンクを辿った場所. 無ければ None)
    project_path: Optional[str] = None
    monitor: Optional[str] = None
    mode: Optional[Mode] = None
    # 値を渡せない理由 (既製のモデル, 読めない設定など. 渡せれば None)
    reason: Optional[str] = None
    # problem.yaml の更新時刻 (読めなければ None)
    updated_at: Optional[str] = None


class ProblemTrainings(BaseModel):
    # 置き場の problems, 問題の設定 (更新の新しい順), 置き場を読めない
    # 場合の理由
    root: str
    problems: list[ProblemTraining]
    error: Optional[str] = None


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


class RunModelSpec(BaseModel):
    # モデルの定義の写しの記録 (ML-Found の source.yaml の model_spec).
    # path は config の model.spec の場所, status は copied (model_spec.yaml
    # に写した) か写さなかった理由 (知らない値もそのまま), sha256 は写した
    # 中身の SHA-256. 分からないものは None
    path: Optional[str] = None
    status: Optional[str] = None
    sha256: Optional[str] = None


class RunModel(BaseModel):
    # 実験が使ったモデルの定義の名前 (DESIGN.md の「実験のモデルの定義」).
    # path は元の定義の場所 (写しから起動し直した実験は辿った場所),
    # origin_known は元の場所が分かったか
    name: str
    path: str
    sha256: Optional[str] = None
    origin_known: bool = True


class ModelSpecInfo(BaseModel):
    # プロジェクトの models/ のモデルの定義 (候補). reason は選べない理由
    path: str
    name: str
    sha256: Optional[str] = None
    size: Optional[int] = None
    reason: Optional[str] = None


class ModelSpecList(BaseModel):
    # models/ の定義の一覧と, 一覧を作れない理由 (models/ が無いかリンク)
    specs: list[ModelSpecInfo] = []
    notice: Optional[str] = None
    # 起動の前の確認に使う default の config の model.spec (無ければ None.
    # 学習の起動の画面は, 無ければ候補の欄を出さない)
    default_spec: Optional[str] = None


# 候補のまとまりの候補の状態 (待つ, 学習中, 終わった, 取りやめた,
# 起動できなかった)
CandidateState = Literal[
    "waiting", "running", "finished", "cancelled", "failed"
]


class BatchCandidate(BaseModel):
    # 候補のまとまりの 1 つの候補. sha256 はまとまりを作ったときの定義の
    # 中身, mismatch は学習を始めた実験の写しがそれと違うか
    path: str
    name: str
    sha256: str
    state: CandidateState = "waiting"
    job_id: Optional[str] = None
    reason: Optional[str] = None
    mismatch: bool = False


class BatchOwner(BaseModel):
    # まとまりを進めるダッシュボードのプロセス
    hostname: str
    pid: int
    started_at: str


class Batch(BaseModel):
    # 候補のまとまり (置き場の batches/<ID>/batch.json)
    id: str
    project_id: str
    script: str
    default_config: Optional[str] = None
    created_at: str
    owner: BatchOwner
    candidates: list[BatchCandidate]
    # 次の候補が待っているジョブ (学習中の他のジョブ) の ID
    waiting_for: list[str] = []


class BatchInfo(Batch):
    # 画面に返すまとまり. 終わったか (待つ候補と学習中の候補が無い),
    # 持ち主がこのプロセスか
    project_name: Optional[str] = None
    finished: bool
    owned: bool


class RunSource(BaseModel):
    # 実験の起動のしかた (ML-Found の source.yaml). 実行したスクリプト,
    # default と experiment の config のパス, 「項目=値」の上書き, モデルの
    # 定義の写し. 分からないものは None
    script: Optional[str] = None
    default: Optional[str] = None
    experiment: Optional[str] = None
    overrides: Optional[list[str]] = None
    model_spec: Optional[RunModelSpec] = None


class EvaluationValue(BaseModel):
    # 一覧と比較に出すテスト用 (と全ての行) の評価の 1 つの値 (1 行の表の
    # 数の列)
    evaluation: str
    column: str
    value: Optional[float]
    # 守る指標の表の値か
    guard: bool = False
    # 比べる相手との差の列 (<指標>_diff) か
    diff: bool = False
    # 指標の向き (分からなければ None)
    better: Optional[Better] = None
    # 比べる相手の名前 (評価の baseline)
    baseline: Optional[str] = None


class GuardCheck(BaseModel):
    # テスト用 (と全ての行) の守る指標の表の判定. dropped は落ちた指標と
    # 一番悪い差, unknown は判断できなかった理由
    state: GuardState
    dropped: list[str] = []
    unknown: list[str] = []


class RunEvaluations(BaseModel):
    # 一覧と比較に出すテスト用 (と全ての行) の評価の値と守る指標の判定
    # (守る指標の表が無ければ guard は None). 読めない場合の理由
    values: list[EvaluationValue] = []
    guard: Optional[GuardCheck] = None
    notice: Optional[str] = None


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
    # 起動のしかた (source.yaml), 書いていない実験は None
    source: Optional[RunSource] = None
    # テスト用の評価の値と守る指標の判定, evaluations/ の無い実験は None
    evaluations: Optional[RunEvaluations] = None
    # 使ったモデルの定義の名前, 定義の場所の記録が無い実験は None
    model: Optional[RunModel] = None


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
    # ファイルを返す API で返すか (方策の一式の重みは返さない)
    downloadable: bool = True


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
    # Scheduler の主な引数 (ML-Found の docs/FORMAT.md の「Scheduler の
    # 引数」. 値は数, 文字, 真偽値, null とそれらの並びと辞書). 使わない
    # 場合と, 書かない版の ML-Found の実験と辞書でない場合は None
    scheduler_params: Optional[dict[str, Any]] = None


class RunDetail(RunSummary):
    # 実験のディレクトリの場所 (次の段階で使うときにコピーする)
    path: Optional[str] = None
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
    # partial), run.json が無い実験は None
    final_weights: Optional[Literal["best", "last", "partial"]] = None
    # パラメータとバッファの一覧 (model_summary.csv, 多い場合は先頭だけ) と
    # 全体の行数, ファイルが無い実験は None
    model_summary: Optional[list[ModelParam]] = None
    model_summary_rows: Optional[int] = None
    # Optimizer ごとの名前, クラス, 受け持つ部分, Scheduler (run.json の
    # optimizers), 書いていない実験は None
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
    # 学習曲線の横軸に使える列 (epoch と, 名前に / が無く学習率でない,
    # エポックごとに増え続ける列. 環境のステップ数や見たサンプルの数など)
    x_columns: list[str] = []


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
    # 列ごとの指標の向き (評価の better を同じ指標の列に広げたもの.
    # 書いていない列は無い)
    better: dict[str, Better] = {}
    epoch: Optional[int] = None
    created_at: Optional[str] = None
    # 行が多く, 先頭だけを返した場合の全体の行数
    total_rows: int


class SampleClass(BaseModel):
    # 領域の見本の番号の表の 1 行 (ML-Found の samples/index.json の
    # classes). color は PNG での色 (#rrggbb)
    id: int
    name: Optional[str] = None
    color: str


class Sample(BaseModel):
    # 見本の出力 (ML-Found の samples/index.json の 1 項目.
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
    # 領域の見本の凡例 (mask だけ. 無ければ None)
    classes: Optional[list[SampleClass]] = None
    # 知っている版より新しい見本の一覧の項目か (値の決まりを読まない)
    newer_version: bool = False


class SampleCloud(BaseModel):
    # 点群の見本の点 (間引いた点. 元の座標とファイルのままの座標は同じ順)
    vertices: int
    # ファイルのままの座標 (正規化した学習では正規化した座標)
    points: list[list[float]]
    # ML-Found の original_coordinates で戻した元の座標. 値の決まりに
    # scale も shift も無い場合と, 戻せない場合は None
    original: Optional[list[list[float]]] = None
    # 座標の単位 (値の決まりの units. 無ければ None)
    units: Optional[str] = None
    # 元の座標に戻せない理由 (戻せた場合と, 戻す必要が無い場合は None)
    reason: Optional[str] = None


# 要素ごとの範囲 (null は制限なし)
Bounds = list[Optional[float]]


class PolicySpace(BaseModel):
    # 観測か行動の空間 (ML-Found の policy.json の空間). type は discrete か
    # box
    type: str
    n: Optional[int] = None
    start: Optional[int] = None
    shape: Optional[list[int]] = None
    low: Optional[Bounds] = None
    high: Optional[Bounds] = None


class PolicyFallback(BaseModel):
    # 外れたときの動き. kind は stop, handover, action のどれか. action は
    # discrete では番号, box では数のリスト
    kind: str
    action: Union[int, list[float], None] = None


class PolicyGuards(BaseModel):
    # 守り (ML-Found の policy.json の guards). null は制限なし
    action_low: Optional[Bounds] = None
    action_high: Optional[Bounds] = None
    allowed_actions: Optional[list[int]] = None
    observation_low: Optional[Bounds] = None
    observation_high: Optional[Bounds] = None
    fallback: PolicyFallback


# 重みの sha256 の確かめ (match は一致, mismatch は違う, missing は重みが
# 無いかシンボリックリンク)
WeightsStatus = Literal["match", "mismatch", "missing"]


class RunPolicy(BaseModel):
    # 方策の一式 (ML-Found の policy/policy.json). 読めない場合は error
    # だけを持ち, 守りを読み違えないように中身を出さない
    path: str
    error: Optional[str] = None
    format_version: Optional[int] = None
    head: Optional[str] = None
    observation_space: Optional[PolicySpace] = None
    action_space: Optional[PolicySpace] = None
    guards: Optional[PolicyGuards] = None
    weights: Optional[str] = None
    weights_sha256: Optional[str] = None
    weights_status: Optional[WeightsStatus] = None
    weights_size: Optional[int] = None
    model_class: Optional[str] = None
    created_at: Optional[str] = None
    metadata: dict[str, Any] = {}


# 守り付きの評価のエピソードの終え方 (ML-Found の evaluate_policy の end.
# other は知らない値と値の無い行)
PolicyEnd = Literal[
    "terminated", "truncated", "max_steps", "stop", "handover", "other"
]


class PolicyEndShare(BaseModel):
    # 終え方ごとのエピソードの数と割合 (エピソードが無ければ ratio は None)
    end: PolicyEnd
    count: int
    ratio: Optional[float] = None


class PolicyOutcome(BaseModel):
    # 守り付きの評価 (ML-Found の evaluate_policy の行を save_evaluation で
    # 残した表) の全ての行から数えた, 終え方ごとの割合と, 守りが止めたか
    # 元の制御に戻した (end が stop か handover の) エピソードの割合
    name: str
    split: Optional[str] = None
    description: Optional[str] = None
    epoch: Optional[int] = None
    episodes: int
    ends: list[PolicyEndShare]
    guarded: int
    guarded_ratio: Optional[float] = None


class TrajectoryInfo(BaseModel):
    # 評価の軌跡の表 (ML-Found の trajectories/<名前>.csv) と説明の主な
    # 項目. reason は方策の見積もりに使えない理由 (使えれば None)
    name: str
    file: str
    has_info: bool
    format_version: Optional[int] = None
    source: Optional[str] = None
    env: Optional[str] = None
    epoch: Optional[int] = None
    description: Optional[str] = None
    episodes: Optional[int] = None
    rows: Optional[int] = None
    complete: Optional[bool] = None
    with_action_prob: Optional[bool] = None
    action_space: Optional[dict[str, Any]] = None
    reason: Optional[str] = None
    # 知っている版より新しい説明の知らせ
    notice: Optional[str] = None


# 見積もる方策の形 (一様, 記録で最も多い行動の ε-greedy)
TargetPolicy = Literal["uniform", "epsilon_greedy"]


class PolicyEstimate(BaseModel):
    # 記録した軌跡からの方策の見積もり (ML-Found の estimate_policy_value
    # の結果と, 見積もった方策)
    name: str
    policy: TargetPolicy
    epsilon: float
    gamma: float
    # 行動の空間 [action_start, action_start + action_count) と, ε-greedy
    # の最も確率の高い行動 (記録で最も多い行動. 一様では None)
    action_start: int
    action_count: int
    best_action: Optional[int] = None
    value: Optional[float] = None
    ordinary: Optional[float] = None
    per_decision: Optional[float] = None
    behavior_value: Optional[float] = None
    episodes: int
    steps: int
    effective_sample_size: float
    max_weight_share: Optional[float] = None
    zero_weight_episodes: int
    underflow_episodes: int
    # 有効なサンプルの数がエピソードの数に比べて少なく, 見積もりが当て
    # にならないか (ML-Found の low_ess)
    low_ess: bool
    notes: list[str] = []


class RunResults(BaseModel):
    # 実験の任意のファイル (task.yaml, evaluations/, samples/,
    # policy/policy.json, trajectories/). 無い実験は None と空のリスト
    task: Optional[RunTask] = None
    evaluations: list[Evaluation] = []
    samples: list[Sample] = []
    policy: Optional[RunPolicy] = None
    # 守り付きの評価の割合 (評価の並びと同じ順. 無ければ空)
    policy_outcomes: list[PolicyOutcome] = []
    # 評価の軌跡の表 (trajectories/. 名前の順. 無ければ空)
    trajectories: list[TrajectoryInfo] = []
    # 読めなかったファイルなど (画面に注意として出す)
    notices: list[str] = []


class RequirementCheck(BaseModel):
    # 確かめ方ごとの結果 (ML-Found の describe_requirements の checks). kind
    # は module, command, function のどれか. 確かめていない場合 ok は None
    kind: str
    name: str
    ok: Optional[bool] = None
    error: Optional[str] = None
    # 入っている版と版の下限 (module の確かめ方. 書かない版の ML-Found と
    # 無いか読めない場合は None). ok が False で両方ある場合は版が古い
    version: Optional[str] = None
    min_version: Optional[str] = None


class RequirementInstall(BaseModel):
    # 入れ方. kind は pip か guide. url は http か https のものだけ
    kind: str
    extra: Optional[str] = None
    packages: list[str] = []
    url: Optional[str] = None
    command: Optional[str] = None
    extra_command: Optional[str] = None


class Requirement(BaseModel):
    # 1 つの機能の要るもの, 入っているか, 入れ方. 確かめられない場合
    # available は None
    name: str
    description: str
    checks: list[RequirementCheck]
    match: str
    available: Optional[bool] = None
    install: RequirementInstall
    note: Optional[str] = None


class RequirementReport(BaseModel):
    # プロジェクトの Python で確かめた, 登録簿の全ての機能
    python: str
    checked_at: str
    requirements: list[Requirement] = []
    # 確かめられなかった理由 (Python が動かない, ML-Found に
    # describe_requirements が無いなど)
    error: Optional[str] = None
    # ML-Found の describe_requirements を読み込めたか (Python が動かない
    # 場合などは None)
    ml_found: Optional[bool] = None


class RequiresStatus(BaseModel):
    # config の requires に書いた機能と, 足りないもの
    requires: list[str] = []
    missing: list[Requirement] = []
    # 登録簿に無い名前 (確かめられないので起動は止めない)
    unknown: list[str] = []
    # 登録簿にあるが, 入っているかを確かめられなかった名前
    unchecked: list[str] = []
    # requires の書き方の誤り (起動を止める)
    error: Optional[str] = None
    # 確かめられなかった理由 (起動は止めない)
    check_error: Optional[str] = None
    # 確かめた Python
    python: Optional[str] = None


class ConfigPath(BaseModel):
    # config に書いたパスと, プロジェクトから辿った先があるか. 書いて
    # いない場合 value と path と exists は None
    key: str
    value: Optional[str] = None
    path: Optional[str] = None
    exists: Optional[bool] = None
    # 値の参照 (${...}) を解決できないなどの読めない理由
    error: Optional[str] = None


EnvironmentJobStatus = Literal[
    "running", "succeeded", "failed", "interrupted"
]


class EnvironmentJob(BaseModel):
    # 環境を作るか足りないものを入れるジョブ. interrupted はダッシュボード
    # を起動し直して, 終わりを見届けられなかったもの
    project_id: str
    status: EnvironmentJobStatus
    started_at: str
    finished_at: Optional[str] = None
    return_code: Optional[int] = None
    # 順に動かすコマンド (引数のリスト)
    commands: list[list[str]] = []
    # 出力の末尾
    output: str = ""


class ProjectReadiness(BaseModel):
    # 学習の準備. データセット, モデルの定義, 学習に使う Python の環境
    dataset: ConfigPath
    # config に model.spec が無い場合は None
    model_spec: Optional[ConfigPath] = None
    # config の model.placeholder が true か (定義のファイルが無くても仮の
    # モデルで学習できるプロジェクト. model.spec が無い場合は False)
    model_placeholder: bool = False
    # 学習に使う Python (登録したもの) と, 確かめと入れる先の Python
    python: str
    target_python: str
    # 入れる先がプロジェクトの .venv か (False は利用者が選んだ他の環境)
    managed: bool
    # 入れる先の Python があるか
    environment_exists: bool
    # 入れる先の Python で ML-Found を読み込めるか (確かめられない場合は
    # None)
    ml_found: Optional[bool] = None
    # default の config の requires と, 足りない機能 (版が古いものも)
    requires: list[str] = []
    missing: list[str] = []
    # 足りない機能のうち版が古いものの, 入っている版と下限の説明
    # (例: {"rl": "gymnasium 0.29.1, 1.0 以上が要る"})
    old_versions: dict[str, str] = {}
    # pip で入らないので, 利用者が公式の手順で入れる機能
    manual: list[Requirement] = []
    # 登録簿に無い名前 (入れられないので確かめない)
    unknown: list[str] = []
    # 環境の ML-Found が古い版で, 登録簿に無いので確かめられない名前
    outdated: list[str] = []
    # requires の書き方の誤り
    requires_error: Optional[str] = None
    # 入っているかを確かめられなかった理由
    check_error: Optional[str] = None
    # ボタンで動かすコマンド (空なら入れるものが無い)
    installer: Literal["uv", "venv"]
    commands: list[list[str]] = []
    # 入れ終えたら (入れるものが無ければすぐに), 学習に使う Python を
    # プロジェクトの .venv に付け替えるか
    switch_python: bool = False
    # 全てがそろっているか
    ready: bool
    # 最後の環境のジョブ
    job: Optional[EnvironmentJob] = None
