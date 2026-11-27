import builtins
import importlib.abc
import importlib.machinery
import importlib.util
import itertools
import sys
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

# 確かめごとにプロジェクトのモジュールを読む頭の名前 (後ろに番号)
PREFIX = "_ml_dashboard_project_"

# 頭の名前のパッケージに持たせるプロジェクトのディレクトリの属性の名前
PROJECT_DIR_ATTRIBUTE = "__ml_dashboard_project_dir__"

# 頭の名前の番号 (確かめごとに別の名前)
COUNTER = itertools.count()

# 元の import (プロジェクトのモジュールでないものはそのまま)
ORIGINAL_IMPORT = builtins.__import__

# 探すものを sys.meta_path に 1 度だけ置くための排他
FINDER_LOCK = threading.Lock()


def is_project_module(project_dir: Path, name: str) -> bool:
    """
    最上位の名前がプロジェクトのディレクトリのモジュールかを返す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    name: str
        モジュールの最上位の名前

    Returns
    ----------
    found: bool
        <名前>.py か <名前>/__init__.py がある場合は True
    """
    # 名前でないもの (空, パスの区切りを含むなど) は対象外
    if not name.isidentifier():
        return False
    found = (project_dir / f"{name}.py").is_file() or (
        project_dir / name / "__init__.py"
    ).is_file()

    return found


def project_dir_of(package: str) -> Optional[Path]:
    """
    頭の名前のパッケージが読むプロジェクトのディレクトリを返す関数

    Parameters
    ----------
    package: str
        モジュールの最上位の名前

    Returns
    ----------
    project_dir: Optional[Path]
        プロジェクトのディレクトリ, 頭の名前でなければ None
    """
    if not package.startswith(PREFIX):
        return None
    value = getattr(sys.modules.get(package), PROJECT_DIR_ATTRIBUTE, None)
    project_dir = value if isinstance(value, Path) else None

    return project_dir


class ProjectImport:
    def __init__(self, package: str, project_dir: Path):
        # 頭の名前とプロジェクトのディレクトリを保存
        self.package = package
        self.project_dir = project_dir

    def __call__(
        self, name: str, namespace: Optional[dict[str, Any]] = None,
        local_namespace: Optional[dict[str, Any]] = None,
        fromlist: Optional[Sequence[str]] = None, level: int = 0
    ) -> ModuleType:
        """
        プロジェクトのモジュールの import を頭の名前の下で行う関数

        Parameters
        ----------
        name: str
            import するモジュールの名前
        namespace: Optional[dict[str, Any]] = None
            import 文を書いたモジュールの名前空間
        local_namespace: Optional[dict[str, Any]] = None
            import 文を書いた場所の名前空間
        fromlist: Optional[Sequence[str]] = None
            from ... import で取り出す名前, import 文では None
        level: int = 0
            相対 import の階層, 0 は絶対 import

        Returns
        ----------
        module: ModuleType
            import 文に返すモジュール
        """
        # 相対 import とプロジェクトの外のモジュールはそのまま
        top = name.partition(".")[0]
        if level != 0 or not is_project_module(self.project_dir, top):
            return ORIGINAL_IMPORT(
                name, namespace, local_namespace, fromlist or (), level
            )

        # import a.b は a を, from a.b import c は a.b を返す決まり
        module = ORIGINAL_IMPORT(
            f"{self.package}.{name}", namespace, local_namespace,
            fromlist or (), 0
        )
        if fromlist:
            return module
        module = sys.modules[f"{self.package}.{top}"]

        return module


class ProjectLoader(importlib.machinery.SourceFileLoader):
    def exec_module(self, module: ModuleType) -> None:
        """
        プロジェクトのモジュールを, 中の import 文も頭の名前の下で読むように
        して実行する関数

        Parameters
        ----------
        module: ModuleType
            実行するモジュール

        Returns
        ----------
        None
        """
        # モジュールの名前空間の組み込みだけ import を差し替え
        package = module.__name__.partition(".")[0]
        project_dir = project_dir_of(package)
        if project_dir is not None:
            namespace = dict(vars(builtins))
            namespace["__import__"] = ProjectImport(package, project_dir)
            module.__dict__["__builtins__"] = namespace
        super().exec_module(module)


class ProjectFinder(importlib.abc.MetaPathFinder):
    def find_spec(
        self, fullname: str, path: Optional[Sequence[str]],
        target: Optional[ModuleType] = None
    ) -> Optional[importlib.machinery.ModuleSpec]:
        """
        頭の名前の下のモジュールをプロジェクトのディレクトリから探す関数

        Parameters
        ----------
        fullname: str
            探すモジュールの名前
        path: Optional[Sequence[str]]
            親のパッケージの __path__ (使わない)
        target: Optional[ModuleType] = None
            読み直す場合のモジュール (使わない)

        Returns
        ----------
        spec: Optional[importlib.machinery.ModuleSpec]
            見つかったモジュールの仕様, 頭の名前の下でないか無ければ None
        """
        package, _, rest = fullname.partition(".")
        project_dir = project_dir_of(package)
        if project_dir is None or not rest:
            return None
        parts = rest.split(".")
        if not all(part.isidentifier() for part in parts):
            return None

        # パッケージは __path__ を空にし, 中のモジュールもここで探す
        base = project_dir.joinpath(*parts)
        locations: Optional[list[str]] = None
        if (base / "__init__.py").is_file():
            file, locations = base / "__init__.py", []
        elif base.with_name(f"{base.name}.py").is_file():
            file = base.with_name(f"{base.name}.py")
        else:
            return None
        spec = importlib.util.spec_from_file_location(
            fullname, file, loader=ProjectLoader(fullname, str(file)),
            submodule_search_locations=locations
        )

        return spec


def install_finder() -> None:
    """
    頭の名前の下のモジュールを探すものを sys.meta_path に置く関数

    1 度だけ最後に置き, 頭の付かない名前には働かない

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    with FINDER_LOCK:
        if not any(
            isinstance(finder, ProjectFinder) for finder in sys.meta_path
        ):
            sys.meta_path.append(ProjectFinder())


@contextmanager
def project_modules(project_dir: Path) -> Iterator[str]:
    """
    プロジェクトのモジュールを, 確かめごとの頭の名前の下で読めるようにする
    関数

    終わったら頭の名前の下のモジュールを sys.modules から外す

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    package: Iterator[str]
        頭の名前 (モジュールの名前に package. を付けて読む)
    """
    install_finder()

    # 頭の名前のパッケージ (__path__ が空で, 中はプロジェクトから探す)
    package = f"{PREFIX}{next(COUNTER)}"
    spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
    module = importlib.util.module_from_spec(spec)
    setattr(module, PROJECT_DIR_ATTRIBUTE, project_dir)
    sys.modules[package] = module
    try:
        yield package
    finally:
        # 頭の名前の下で読んだモジュールを全て除去
        for name in list(sys.modules):
            if name == package or name.startswith(f"{package}."):
                sys.modules.pop(name, None)
