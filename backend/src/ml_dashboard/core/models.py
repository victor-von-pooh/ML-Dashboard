from typing import Any, Literal, Optional

from pydantic import BaseModel

# 実験の状態, unknown は中断したか実行中か分からないもの
RunStatus = Literal["running", "completed", "stopped", "failed", "unknown"]


class ProjectInfo(BaseModel):
    id: str
    name: str
    path: str
    python: str
    created_at: str
    run_count: int
    latest_run: Optional[str]


class ProjectDetail(ProjectInfo):
    output_dir: str
    scripts: list[str]
    experiment_configs: list[str]


class ProjectCandidate(BaseModel):
    path: str
    name: str
    registered: bool


class BestValue(BaseModel):
    monitor: str
    mode: str
    epoch: int
    value: float


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
    kind: Literal["image", "checkpoint", "text", "other"]


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


class History(BaseModel):
    columns: list[str]
    rows: list[dict[str, Optional[float]]]
