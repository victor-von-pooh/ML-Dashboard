import json
import re
import sys
import threading
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from omegaconf import OmegaConf

# ML-Found のプロジェクトの目印になる default の config
DEFAULT_CONFIG = Path("configs") / "default" / "train.yaml"

# experiment の config を置くディレクトリ
EXPERIMENT_DIR = Path("configs") / "experiment"

# プロジェクトを探すときに入らないディレクトリ
SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", "outputs",
    "data", "ML-Found"
}


@dataclass
class Project:
    id: str
    name: str
    path: str
    python: str
    created_at: str


def is_project_dir(path: Path) -> bool:
    """
    ML-Found のプロジェクトのディレクトリかどうかを判定する関数

    Parameters
    ----------
    path: Path
        判定するディレクトリ

    Returns
    ----------
    is_project: bool
        default の config を持つかどうか
    """
    is_project = (path / DEFAULT_CONFIG).is_file()

    return is_project


def find_projects(root: Path, max_depth: int = 3) -> list[Path]:
    """
    ディレクトリの下から ML-Found のプロジェクトを探す関数

    Parameters
    ----------
    root: Path
        探し始めるディレクトリ
    max_depth: int = 3
        何階層下まで探すか

    Returns
    ----------
    found: list[Path]
        見つけたプロジェクトのディレクトリ
    """
    # 幅優先で探し, プロジェクトの中には入らない
    found = []
    queue = [(root, 0)]
    while queue:
        path, depth = queue.pop(0)
        if is_project_dir(path):
            found.append(path)
            continue
        if depth >= max_depth:
            continue
        children = sorted(
            child for child in path.iterdir()
            if child.is_dir() and child.name not in SKIP_DIRS
            and not child.name.startswith(".")
        )
        queue.extend((child, depth + 1) for child in children)

    return found


def find_python(project_dir: Path) -> str:
    """
    プロジェクトの学習に使う Python を探す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    python: str
        プロジェクトか親のディレクトリの仮想環境の Python, 無ければ今の Python
    """
    # プロジェクトから上に向かって仮想環境を探す
    for directory in [project_dir, *project_dir.parents]:
        for venv in (".venv", "venv"):
            candidate = directory / venv / "bin" / "python"
            if candidate.is_file():
                python = str(candidate)
                return python

    # 見つからなければダッシュボードの Python
    python = sys.executable

    return python


def make_project_id(name: str, used: set[str]) -> str:
    """
    URL で使えるプロジェクトの ID を作る関数

    Parameters
    ----------
    name: str
        プロジェクトの名前
    used: set[str]
        使用済みの ID

    Returns
    ----------
    project_id: str
        英数字とハイフンからなる重複しない ID
    """
    # 英数字以外をハイフンにして小文字に統一
    base = re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-").lower()
    if base == "":
        base = "project"

    # 重複する場合は番号を付ける
    project_id = base
    count = 2
    while project_id in used:
        project_id = f"{base}-{count}"
        count += 1

    return project_id


class ProjectStore:
    def __init__(self, data_dir: Path):
        # 登録したプロジェクトを保存するファイルを保存
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "projects.json"

        # 複数のリクエストから同時に書き換えないためのロック
        self.lock = threading.Lock()

    def load(self) -> list[Project]:
        """
        登録したプロジェクトを読み込む関数

        Parameters
        ----------
        None

        Returns
        ----------
        projects: list[Project]
            登録したプロジェクト
        """
        if not self.path.is_file():
            return []

        data = json.loads(self.path.read_text(encoding="utf-8"))
        projects = [Project(**item) for item in data]

        return projects

    def save(self, projects: list[Project]) -> None:
        """
        プロジェクトの一覧を書き込む関数

        Parameters
        ----------
        projects: list[Project]
            保存するプロジェクト

        Returns
        ----------
        None
        """
        # 途中で止まっても壊れないように, 一時ファイルに書いてから置き換え
        temp = self.path.with_suffix(".tmp")
        text = json.dumps(
            [asdict(project) for project in projects], ensure_ascii=False,
            indent=2
        )
        temp.write_text(text, encoding="utf-8")
        temp.replace(self.path)

    def get(self, project_id: str) -> Optional[Project]:
        """
        ID からプロジェクトを取得する関数

        Parameters
        ----------
        project_id: str
            プロジェクトの ID

        Returns
        ----------
        project: Optional[Project]
            見つかったプロジェクト, 無い場合は None
        """
        project = next(
            (item for item in self.load() if item.id == project_id), None
        )

        return project

    def add(
        self, path: str, name: Optional[str] = None,
        python: Optional[str] = None
    ) -> Project:
        """
        プロジェクトを登録する関数

        Parameters
        ----------
        path: str
            プロジェクトのディレクトリ
        name: Optional[str] = None
            表示する名前, None の場合はディレクトリ名
        python: Optional[str] = None
            学習に使う Python, None の場合は自動で探す

        Returns
        ----------
        project: Project
            登録したプロジェクト
        """
        # ML-Found のプロジェクトであることの確認
        project_dir = Path(path).expanduser().resolve()
        if not is_project_dir(project_dir):
            raise ValueError(
                f"{DEFAULT_CONFIG} が無いので ML-Found のプロジェクトでは"
                f"ありません: {project_dir}"
            )

        # Python の確認
        if python is None:
            python = find_python(project_dir)
        elif not Path(python).is_file():
            raise ValueError(f"Python が見つかりません: {python}")

        with self.lock:
            projects = self.load()

            # 同じディレクトリは 2 回登録しない
            for project in projects:
                if project.path == str(project_dir):
                    raise ValueError(
                        f"登録済みのプロジェクトです: {project.name}"
                    )

            # ID を決めて追加
            display_name = name or project_dir.name
            project = Project(
                id=make_project_id(
                    display_name, {item.id for item in projects}
                ),
                name=display_name,
                path=str(project_dir),
                python=python,
                created_at=datetime.now().isoformat(timespec="seconds")
            )
            projects.append(project)
            self.save(projects)

        return project

    def remove(self, project_id: str) -> bool:
        """
        プロジェクトの登録を外す関数

        Parameters
        ----------
        project_id: str
            外すプロジェクトの ID

        Returns
        ----------
        removed: bool
            外したかどうか
        """
        with self.lock:
            projects = self.load()
            kept = [item for item in projects if item.id != project_id]
            removed = len(kept) != len(projects)
            if removed:
                self.save(kept)

        return removed


def read_output_dir(project_dir: Path) -> Path:
    """
    プロジェクトの実験の出力先を取得する関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    output_dir: Path
        default の config の experiment.output_dir
    """
    # 補間を解決せずに値だけ読み, 無ければ ML-Found の既定値
    cfg = OmegaConf.load(project_dir / DEFAULT_CONFIG)
    value = OmegaConf.select(
        cfg, "experiment.output_dir", default="outputs",
        throw_on_resolution_failure=False
    )
    output_dir = project_dir / str(value or "outputs")

    return output_dir


def list_scripts(project_dir: Path) -> list[str]:
    """
    プロジェクトの学習のスクリプトを列挙する関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    scripts: list[str]
        train で始まる Python のファイル名
    """
    scripts = sorted(path.name for path in project_dir.glob("train*.py"))

    return scripts


def list_experiment_configs(project_dir: Path) -> list[str]:
    """
    プロジェクトの experiment の config を列挙する関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    configs: list[str]
        プロジェクトのディレクトリからの相対パス
    """
    root = project_dir / EXPERIMENT_DIR
    if not root.is_dir():
        return []

    configs = sorted(
        str(path.relative_to(project_dir))
        for path in root.rglob("*.yaml")
    )

    return configs
