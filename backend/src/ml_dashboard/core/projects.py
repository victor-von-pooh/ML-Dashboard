import json
import os
import re
import sys
import tempfile
import threading
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from omegaconf import OmegaConf

# ML-Found のプロジェクトの目印になる default の config
DEFAULT_CONFIG = Path("configs") / "default" / "train.yaml"

# default の config を置くディレクトリ
DEFAULT_DIR = Path("configs") / "default"

# experiment の config を置くディレクトリ
EXPERIMENT_DIR = Path("configs") / "experiment"

# プロジェクトを探すときに入らないディレクトリ
SKIP_DIRS = {"node_modules", "__pycache__", "outputs", "data", "venv"}


class ProjectError(Exception):
    pass


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
    # 読めないディレクトリはプロジェクトではないものとして扱い
    try:
        is_project = (path / DEFAULT_CONFIG).is_file()
    except OSError:
        return False

    return is_project


def read_submodules(path: Path) -> set[Path]:
    """
    git のリポジトリの .gitmodules から submodule のディレクトリを読む関数

    Parameters
    ----------
    path: Path
        リポジトリのディレクトリ

    Returns
    ----------
    submodules: set[Path]
        submodule のディレクトリ, .gitmodules が無ければ空
    """
    # 「path = <相対パス>」の行だけを読み, 読めない場合は無いものとして扱い
    try:
        text = (path / ".gitmodules").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return set()
    pattern = r"^[ \t]*path[ \t]*=[ \t]*(.+?)[ \t\r]*$"
    submodules = {
        path / match.group(1).strip('"')
        for match in re.finditer(pattern, text, re.MULTILINE)
    }

    return submodules


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
    # 幅優先で探し, プロジェクトの中と読めないディレクトリは対象外
    # submodule (取り込んだ別のリポジトリ) の中の例などは, 探す対象外
    # vendor/lib のように深い場所の submodule も除けるように, 見つけた
    # submodule を下の階層へ引き継ぎ
    found = []
    submodules: set[Path] = set()
    queue = deque([(root, 0)])
    while queue:
        path, depth = queue.popleft()
        if is_project_dir(path):
            found.append(path)
            continue
        if depth >= max_depth:
            continue
        submodules |= read_submodules(path)
        try:
            children = sorted(
                child for child in path.iterdir()
                if child.is_dir() and not child.is_symlink()
                and child.name not in SKIP_DIRS
                and not child.name.startswith(".")
                and child not in submodules
            )
        except OSError:
            continue
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
        プロジェクトから git のルートかホームまでの仮想環境の Python,
        無ければダッシュボードの Python
    """
    # プロジェクトから上に向かって仮想環境を探し, 関係の無い場所の手前で終了
    home = Path.home()
    for directory in [project_dir, *project_dir.parents]:
        if directory == home or directory == directory.parent:
            break
        for venv in (".venv", "venv"):
            candidate = directory / venv / "bin" / "python"
            if candidate.is_file():
                python = str(candidate)
                return python
        if (directory / ".git").exists():
            break

    python = sys.executable

    return python


def check_python(python: str) -> None:
    """
    学習に使う Python が実行できるファイルかを確かめる関数

    Parameters
    ----------
    python: str
        Python のパス

    Returns
    ----------
    None
    """
    path = Path(python)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"実行できる Python が見つかりません: {python}")
    if not path.name.startswith("python"):
        raise ValueError(f"Python の実行ファイルを指定してください: {python}")


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

    # 重複する場合は番号を追加
    project_id = base
    count = 2
    while project_id in used:
        project_id = f"{base}-{count}"
        count += 1

    return project_id


class ProjectStore:
    def __init__(self, data_dir: Path):
        # 登録したプロジェクトを保存するファイルを保存
        self.data_dir = data_dir
        self.path = data_dir / "projects.json"

        # 複数のリクエストから同時に書き換えないためのロックを用意
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

        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            projects = [Project(**item) for item in data]
        except (ValueError, TypeError) as error:
            raise ProjectError(
                f"{self.path} が壊れています. 直すか消してください: {error}"
            ) from error

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
        self.data_dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps(
            [asdict(project) for project in projects], ensure_ascii=False,
            indent=2
        )
        with tempfile.NamedTemporaryFile(
            "w", dir=self.data_dir, suffix=".tmp", delete=False,
            encoding="utf-8"
        ) as file:
            file.write(text)
        os.replace(file.name, self.path)

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
        if not project_dir.is_dir():
            raise ValueError(f"ディレクトリが見つかりません: {project_dir}")
        if not is_project_dir(project_dir):
            raise ValueError(
                f"{DEFAULT_CONFIG} が無いので ML-Found のプロジェクトでは"
                f"ありません: {project_dir}"
            )

        # Python の確認
        if python is None:
            python = find_python(project_dir)
        check_python(python)

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


def read_output_dir(path: Path) -> Optional[str]:
    """
    config のファイルから experiment.output_dir を読む関数

    Parameters
    ----------
    path: Path
        config のファイル

    Returns
    ----------
    output_dir: Optional[str]
        値, 無いか補間を解決できない場合は None
    """
    try:
        cfg = OmegaConf.load(path)
        value = OmegaConf.select(cfg, "experiment.output_dir")
    except Exception:
        return None
    output_dir = str(value) if value else None

    return output_dir


def script_config_names(script: str) -> list[str]:
    """
    学習のスクリプトの名前から, 対応する config の名前の候補を作る関数

    Parameters
    ----------
    script: str
        学習のスクリプトの名前

    Returns
    ----------
    names: list[str]
        拡張子の無い config の名前, train_hf.py なら hf と train_hf の順
    """
    # train_ で始まる名前だけを対応させ, train.py などは train.yaml のまま
    stem = Path(script).stem
    names = []
    rest = stem.removeprefix("train_")
    if stem.startswith("train_") and rest:
        names = [rest, stem]

    return names


def read_default_reference(project_dir: Path, script: str) -> Optional[Path]:
    """
    学習のスクリプトの本文から, 読み込む default の config を探す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    script: str
        学習のスクリプトの名前

    Returns
    ----------
    path: Optional[Path]
        本文に configs/default/<名前>.yaml が 1 種類だけ書かれ, その
        ファイルがあればそのパス, 無いか複数ある場合は None
    """
    # 読めないスクリプトは, 書かれていないものとして扱い
    try:
        text = (project_dir / script).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    names: set[str] = set(
        re.findall(r"configs/default/([\w.-]+\.ya?ml)", text)
    )
    if len(names) != 1:
        return None
    path = project_dir / DEFAULT_DIR / names.pop()
    if not path.is_file():
        return None

    return path


def default_config_for(project_dir: Path, script: Optional[str]) -> Path:
    """
    学習のスクリプトが元にする default の config を選ぶ関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    script: Optional[str]
        学習のスクリプトの名前, None は train.py と同じ扱い

    Returns
    ----------
    path: Path
        default の config, 対応するものが無ければ configs/default/train.yaml
    """
    # スクリプトの本文に書かれた config, 次に名前 (train_hf.py なら hf.yaml,
    # train_hf.yaml) の順で探し, 無ければ train.yaml
    path = project_dir / DEFAULT_CONFIG
    if script is None:
        return path
    referenced = read_default_reference(project_dir, script)
    if referenced is not None:
        return referenced
    for name in script_config_names(script):
        candidate = project_dir / DEFAULT_DIR / f"{name}.yaml"
        if candidate.is_file():
            path = candidate
            break

    return path


def experiment_config_for(project_dir: Path, script: str) -> str:
    """
    学習のスクリプトの既定の experiment の config を選ぶ関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    script: str
        学習のスクリプトの名前

    Returns
    ----------
    relative: str
        プロジェクトのディレクトリからの相対パス, train_hf.py なら
        configs/experiment/hf.yaml, 対応するものが無ければ train.yaml
    """
    # 画面がスクリプトを選んだときと同じ規則で選択
    configs = list_experiment_configs(project_dir)
    for name in script_config_names(script):
        candidate = (EXPERIMENT_DIR / f"{name}.yaml").as_posix()
        if candidate in configs:
            return candidate
    relative = (EXPERIMENT_DIR / "train.yaml").as_posix()

    return relative


def get_output_dirs(project_dir: Path) -> list[Path]:
    """
    プロジェクトの実験の出力先の候補を取得する関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    output_dirs: list[Path]
        各 default と各 experiment の config の experiment.output_dir
    """
    if not is_project_dir(project_dir):
        raise ProjectError(
            f"プロジェクトのディレクトリが見つかりません: {project_dir}"
        )

    # 別の default の config や experiment の config で出力先を変えた実験も
    # 探せるように, 全ての config の出力先の収集
    values = [read_output_dir(project_dir / DEFAULT_CONFIG) or "outputs"]
    values.extend(
        value for value in (
            read_output_dir(path)
            for path in sorted((project_dir / DEFAULT_DIR).glob("*.yaml"))
        )
        if value
    )
    values.extend(
        value for value in (
            read_output_dir(project_dir / config)
            for config in list_experiment_configs(project_dir)
        )
        if value
    )
    output_dirs = []
    for value in values:
        output_dir = (project_dir / value).resolve()
        if output_dir not in output_dirs:
            output_dirs.append(output_dir)

    return output_dirs


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
        path.relative_to(project_dir).as_posix()
        for path in root.rglob("*.yaml")
    )

    return configs
