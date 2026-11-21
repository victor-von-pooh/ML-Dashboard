import hashlib
import os
import stat
from pathlib import Path
from typing import Optional

from ml_dashboard.core.model_spec import MODEL_SPEC_FILE, read_copy
from ml_dashboard.core.models import (
    ModelSpecInfo,
    ModelSpecList,
    RunModel,
    RunSource,
)

# プロジェクトのモデルの定義の置き場 (利用者の決め) と, 候補にする拡張子
MODELS_DIR = "models"
SPEC_SUFFIXES = (".yaml", ".yml")

# 一覧にする定義の数と, 辿るファイルとディレクトリの数の上限
MAX_MODEL_SPECS = 200
MAX_WALKED = 5000

# 候補にできる定義の大きさの上限 (ML-Found が写せる大きさ)
MAX_SPEC_BYTES = 16 * 1024 * 1024

# 写しの記録を辿る回数の上限 (写しから起動し直した実験の元の定義)
MAX_ORIGIN_HOPS = 10

# 読んだ定義の sha256 の覚え (場所から, (i-node, 大きさ, 更新の時刻) と
# sha256)
SPEC_SHA_CACHE: dict[str, tuple[tuple[int, int, int], Optional[str]]] = {}


def spec_name(path: str) -> str:
    """
    定義の場所から名前を決める関数

    Parameters
    ----------
    path: str
        定義の場所 (プロジェクトからの相対パスか, 外なら絶対パス)

    Returns
    ----------
    name: str
        models/ からの相対の場所から拡張子を除いたもの. models/ の外は
        場所から拡張子を除いたもの
    """
    without = Path(path).with_suffix("")
    parts = without.parts
    if len(parts) > 1 and parts[0] == MODELS_DIR:
        name = Path(*parts[1:]).as_posix()
    else:
        name = without.as_posix()

    return name


def spec_sha256(path: Path) -> Optional[str]:
    """
    定義のファイルの sha256 を, 変わらない間は覚えた値で求める関数

    Parameters
    ----------
    path: Path
        定義のファイル

    Returns
    ----------
    sha256: Optional[str]
        中身の SHA-256, リンク, 普通でないファイル, 大きすぎるファイル,
        読めないファイルは None
    """
    # i-node, 大きさ, 更新の時刻が同じなら前に求めた値
    try:
        found = path.lstat()
    except OSError:
        return None
    key = (found.st_ino, found.st_size, found.st_mtime_ns)
    cached = SPEC_SHA_CACHE.get(str(path))
    if cached is not None and cached[0] == key:
        return cached[1]

    # リンクを辿らずに読んだ中身のハッシュ
    content, _ = read_copy(path)
    sha256 = None if content is None else hashlib.sha256(content).hexdigest()
    SPEC_SHA_CACHE[str(path)] = (key, sha256)

    return sha256


def spec_problem(project_dir: Path, path: Path) -> Optional[str]:
    """
    定義のファイルを候補にできない理由を返す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    path: Path
        定義のファイル (models/ の下)

    Returns
    ----------
    problem: Optional[str]
        リンク (途中のディレクトリも), 普通でないファイル, 大きすぎる,
        config に書けない場所の理由. 候補にできれば None
    """
    # 途中のディレクトリと, ファイル自体のリンク
    relative = path.relative_to(project_dir)
    current = project_dir
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return "シンボリックリンクなので選べません"

    # config の参照 (${) とホームの展開 (~) に読まれる場所
    text = relative.as_posix()
    if "${" in text or text.startswith("~"):
        return "場所が ${ を含むか ~ で始まるので, config に書けません"

    # 普通のファイルで, ML-Found が写せる大きさまで
    try:
        found = path.lstat()
    except OSError:
        return "読めません"
    if not stat.S_ISREG(found.st_mode):
        return "普通のファイルではありません"
    if found.st_size > MAX_SPEC_BYTES:
        return "16 MiB を超えるので, ML-Found が実験に写せません"
    problem = None

    return problem


def find_spec_files(folder: Path) -> list[Path]:
    """
    models/ の下の定義のファイルを集める関数

    Parameters
    ----------
    folder: Path
        プロジェクトの models/

    Returns
    ----------
    files: list[Path]
        *.yaml と *.yml (中のディレクトリも. リンクのディレクトリと隠し
        ファイルは除く), 場所の順で上限まで
    """
    # リンクのディレクトリを辿らず, 辿った数にも上限を置いて収集
    files: list[Path] = []
    walked = 0
    for root, dirs, names in os.walk(folder, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not name.startswith("."))
        walked += len(dirs) + len(names)
        for name in sorted(names):
            if not name.startswith(".") and name.endswith(SPEC_SUFFIXES):
                files.append(Path(root) / name)
        if walked > MAX_WALKED:
            break
    files = sorted(files)[:MAX_MODEL_SPECS]

    return files


def list_model_specs(project_dir: Path) -> ModelSpecList:
    """
    プロジェクトの models/ のモデルの定義の一覧を作る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ

    Returns
    ----------
    specs: ModelSpecList
        場所, 名前, sha256, 大きさ, 選べない理由 (場所の順) と, 一覧を
        作れない理由
    """
    # models/ が無いか, リンクのプロジェクトは空
    folder = project_dir / MODELS_DIR
    if folder.is_symlink():
        return ModelSpecList(
            notice="models/ がシンボリックリンクなので, 定義を選べません"
        )
    if not folder.is_dir():
        return ModelSpecList(notice="models/ がありません")

    # 候補にできるファイルだけ中身を読んでハッシュを求める
    specs: list[ModelSpecInfo] = []
    for path in find_spec_files(folder):
        relative = path.relative_to(project_dir).as_posix()
        problem = spec_problem(project_dir, path)
        sha256 = spec_sha256(path) if problem is None else None
        if problem is None and sha256 is None:
            problem = "読めません"
        try:
            size: Optional[int] = path.lstat().st_size
        except OSError:
            size = None
        specs.append(ModelSpecInfo(
            path=relative, name=spec_name(relative), sha256=sha256,
            size=size, reason=problem
        ))
    listing = ModelSpecList(specs=specs)

    return listing


def copy_run_key(project_dir: Path, path: str) -> Optional[str]:
    """
    model_spec の場所が実験の写しを指す場合に, その実験のディレクトリの
    鍵を作る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    path: str
        source.yaml の model_spec の path

    Returns
    ----------
    key: Optional[str]
        実験のディレクトリの正規化した絶対パス. 写しを指さない場合は None
    """
    if Path(path).name != MODEL_SPEC_FILE:
        return None
    target = Path(path)
    if not target.is_absolute():
        target = project_dir / target
    key = os.path.normpath(target.parent)

    return key


def find_origin(
    project_dir: Path, path: str, sha256: Optional[str],
    sources: dict[str, Optional[RunSource]]
) -> tuple[str, bool]:
    """
    写しから起動し直した実験の, 元の定義の場所を辿る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    path: str
        実験の source.yaml の model_spec の path
    sha256: Optional[str]
        実験の写した中身の sha256
    sources: dict[str, Optional[RunSource]]
        同じ一覧で読んだプロジェクトの実験 (ディレクトリの鍵から起動の
        しかた)

    Returns
    ----------
    origin: str
        元の定義の場所. 写しでなければ記録の場所のまま
    known: bool
        元の場所が分かったか. 辿った先の実験が無い, sha256 が違う, 打ち
        切った写しは False
    """
    # 読んだ実験の中だけを, 同じ中身の間辿る (同じ実験に 2 度来るか,
    # 上限を超えたら打ち切り)
    visited: set[str] = set()
    current = path
    for _ in range(MAX_ORIGIN_HOPS + 1):
        key = copy_run_key(project_dir, current)
        if key is None or key not in sources:
            return current, key is None
        source = sources[key]
        previous = source.model_spec if source is not None else None
        if (
            key in visited or previous is None or previous.path is None
            or sha256 is None or previous.sha256 != sha256
        ):
            return current, False
        visited.add(key)
        current = previous.path

    return current, False


def describe_models(
    project_dir: Path, sources: dict[str, Optional[RunSource]]
) -> dict[str, Optional[RunModel]]:
    """
    プロジェクトの実験ごとに, 使ったモデルの定義の名前を決める関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    sources: dict[str, Optional[RunSource]]
        プロジェクトの全ての実験 (ディレクトリの鍵から起動のしかた)

    Returns
    ----------
    models: dict[str, Optional[RunModel]]
        ディレクトリの鍵から定義. 定義の場所の記録が無い実験は None
    """
    models: dict[str, Optional[RunModel]] = {}
    for key, source in sources.items():
        spec = source.model_spec if source is not None else None
        if spec is None or spec.path is None:
            models[key] = None
            continue

        # 写した中身の分かる実験だけ sha256 を使い, 写しなら元を辿る
        sha256 = spec.sha256 if spec.status == "copied" else None
        origin, known = find_origin(project_dir, spec.path, sha256, sources)
        models[key] = RunModel(
            name=spec_name(origin) if known else "写し", path=origin,
            sha256=sha256, origin_known=known
        )

    return models


def run_key(run_dir: Path) -> str:
    """
    実験のディレクトリから, describe_models の鍵を作る関数

    Parameters
    ----------
    run_dir: Path
        実験のディレクトリ

    Returns
    ----------
    key: str
        正規化した絶対パス
    """
    key = os.path.normpath(run_dir.absolute())

    return key
