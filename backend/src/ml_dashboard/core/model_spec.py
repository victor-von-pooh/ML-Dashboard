import hashlib
import os
import stat
from pathlib import Path
from typing import Any, Optional

import yaml
from omegaconf import DictConfig, OmegaConf

from ml_dashboard.core.models import RunModelSpec
from ml_dashboard.core.projects import ProjectError, get_output_dirs
from ml_dashboard.core.results import read_plain_file
from ml_dashboard.core.runs import DATE_PATTERN, TIME_PATTERN, read_source

# 実験に写したモデルの定義のファイルと, 読む大きさの上限 (ML-Found の
# docs/FORMAT.md の model_spec.yaml)
MODEL_SPEC_FILE = "model_spec.yaml"
MAX_MODEL_SPEC_BYTES = 16 * 1024 * 1024

# 写した定義を使えずに起動しないときの文の頭 (画面が見分ける)
COPY_REFUSED = "model.spec が指す, 実験に写した定義を使えないので起動しません"

# 写した定義の入れ子の深さの上限 (深い入れ子で長く止まらないため) と,
# 深さを数える YAML の字句
MAX_DEFINITION_DEPTH = 100
OPEN_EVENTS = (yaml.MappingStartEvent, yaml.SequenceStartEvent)
CLOSE_EVENTS = (yaml.MappingEndEvent, yaml.SequenceEndEvent)

# 写した定義を使えずに起動しないときの応答の code (画面が見分ける)
COPY_REFUSED_CODE = "model_spec_copy_refused"

# 実験のディレクトリだと見分けるファイル (写しの場所を指す model.spec の判定)
RUN_MARKERS = ("config.yaml", "source.yaml")

# モデルの定義を写さなかった理由 (ML-Found の source.yaml の model_spec の
# status. 実験の詳細の画面の言葉と同じ. 知らない値は写していないものとして
# 値のまま出す)
MODEL_SPEC_REASONS = {
    "missing": "定義のファイルが無い",
    "outside": "定義がプロジェクトの外にある",
    "link": "定義の場所がシンボリックリンク",
    "not_file": "定義が普通のファイルでない",
    "unreadable": "定義を読めない",
    "too_large": "定義が 16 MiB を超える",
    "invalid": "定義の場所を読めない",
    "write_failed": "写しを書けなかった",
}


class CopyRefusedError(Exception):
    # 実験に写した定義を使えずに起動しないことを表す例外. 応答は 400 と
    # code (COPY_REFUSED_CODE)
    pass


def find_weight_paths(definition: Any) -> list[str]:
    """
    モデルの定義の中の外部の重みのファイル (weights.path) を集める関数

    ML-ModelControl は weights.path を定義のファイルのディレクトリから辿る
    (絶対のパスも, そのディレクトリか許したディレクトリの中だけを読む) ので,
    写しの場所から組み立てると読めない

    Parameters
    ----------
    definition: Any
        定義 (別名の無い YAML を読んだもの)

    Returns
    ----------
    paths: list[str]
        weights.path の値 (部分モデルの中も含む)
    """
    # 深い入れ子でも止まらないように, 再帰でなく積み上げで辿る処理
    paths: list[str] = []
    stack = [definition]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            weights = node.get("weights")
            if isinstance(weights, dict) and weights.get("path") is not None:
                paths.append(str(weights["path"]))
            children = list(node.values())
        elif isinstance(node, list):
            children = list(node)
        else:
            continue
        # 文書の順に辿るため, 後の子から積み上げ
        stack.extend(reversed(children))

    return paths


def load_definition(content: bytes) -> tuple[Any, Optional[str]]:
    """
    写した定義の中身を YAML として読む関数

    Parameters
    ----------
    content: bytes
        写した定義の中身

    Returns
    ----------
    definition: Any
        読んだ定義, 読めない場合は None
    reason: Optional[str]
        読めない理由, 読めた場合は None
    """
    # 別名 (&a と *a) を持つ定義は読まない (自分を指す別名と, 別名を重ねて
    # 大きく膨らむ定義で止まらないため). 深い入れ子も読めないものとする
    name = f"写した定義 ({MODEL_SPEC_FILE})"
    depth = 0
    try:
        for event in yaml.parse(content, Loader=yaml.SafeLoader):
            if isinstance(event, yaml.AliasEvent):
                return None, (
                    f"{name} が YAML の別名 (*) を使うので, 確かめずに"
                    "使いません"
                )
            # 深すぎる入れ子は, 最後まで読まずに打ち切り
            if isinstance(event, OPEN_EVENTS):
                depth += 1
                if depth > MAX_DEFINITION_DEPTH:
                    return None, (
                        f"{name} の入れ子が {MAX_DEFINITION_DEPTH} 段を"
                        "超えるので, YAML として読めません"
                    )
            elif isinstance(event, CLOSE_EVENTS):
                depth -= 1
        definition = yaml.safe_load(content)
    except (yaml.YAMLError, RecursionError):
        return None, f"{name} を YAML として読めません"

    return definition, None


def read_copy(copy: Path) -> tuple[Optional[bytes], Optional[str]]:
    """
    実験に写したモデルの定義の中身を読む関数

    Parameters
    ----------
    copy: Path
        実験のディレクトリの model_spec.yaml

    Returns
    ----------
    content: Optional[bytes]
        中身, 読めない場合は None
    reason: Optional[str]
        読めない理由, 読めた場合は None
    """
    # リンク, 普通でないファイル, 大きすぎるファイルの除外
    name = f"写した定義 ({MODEL_SPEC_FILE})"
    try:
        found = copy.lstat()
    except FileNotFoundError:
        return None, f"{name} がありません"
    except OSError:
        return None, f"{name} を読めません"
    if stat.S_ISLNK(found.st_mode):
        return None, f"{name} がシンボリックリンクです"
    if not stat.S_ISREG(found.st_mode):
        return None, f"{name} が普通のファイルではありません"
    if found.st_size > MAX_MODEL_SPEC_BYTES:
        return None, f"{name} が 16 MiB を超えています"

    # 確かめた後に置き換えられてもリンクを辿らない読み込み
    content = read_plain_file(copy, None, MAX_MODEL_SPEC_BYTES)
    if content is None:
        return None, f"{name} を読めません"

    return content, None


def find_model_spec_copy(
    project_dir: Path, run_dir: Path, spec: RunModelSpec
) -> tuple[Optional[str], Optional[str]]:
    """
    実験に写したモデルの定義を, もう一度起動するときに使えるかを確かめる関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    run_dir: Path
        実験のディレクトリ
    spec: RunModelSpec
        source.yaml の model_spec

    Returns
    ----------
    path: Optional[str]
        使える写しの場所 (プロジェクトからの相対パス), 使えない場合は None
    reason: Optional[str]
        使えない理由, 使える場合は None
    """
    # 写した記録のある実験だけの選別 (知らない status は写していないもの)
    if spec.status != "copied":
        reason = MODEL_SPEC_REASONS.get(spec.status or "", spec.status)
        return None, f"この実験はモデルの定義を写していません ({reason})"
    if spec.sha256 is None:
        return None, "写したモデルの定義の sha256 が記録されていません"

    # ML-Found が新しい実験に写し直せるように, プロジェクトの中で途中に
    # リンクの無い場所に限定
    copy = run_dir / MODEL_SPEC_FILE
    try:
        relative = run_dir.relative_to(project_dir)
    except ValueError:
        return None, "実験のディレクトリがプロジェクトの外にあります"
    if ".." in relative.parts:
        return None, "実験のディレクトリがプロジェクトの外にあります"
    try:
        linked = run_dir.resolve() != project_dir.resolve() / relative
    except (OSError, RuntimeError):
        linked = True
    if linked:
        return None, (
            "実験のディレクトリの途中にシンボリックリンクがあるので, "
            "写した定義を新しい実験に写し直せません"
        )

    # config の参照 (${) とホームの展開 (~) に読まれる場所の除外
    path = (relative / MODEL_SPEC_FILE).as_posix()
    if "${" in path or path.startswith("~"):
        return None, (
            "写した定義の場所が ${ を含むか ~ で始まるので, config に"
            "書けません"
        )

    # 写しの中身が, 学習を始めたときの中身 (sha256) と同じかの確かめ
    content, reason = read_copy(copy)
    if content is None:
        return None, reason
    if hashlib.sha256(content).hexdigest() != spec.sha256:
        return None, (
            f"写した定義 ({MODEL_SPEC_FILE}) の中身が, 学習を始めたときの"
            "中身 (source.yaml の sha256) と違います"
        )

    # 外部の重みのファイルを読む定義 (写しの場所からは組み立てられない) の除外
    definition, reason = load_definition(content)
    if reason is not None:
        return None, reason
    weights = find_weight_paths(definition)
    if weights:
        return None, (
            f"写しの場所 ({path}) からは外部の重みのファイル "
            f"(weights.path: {weights[0]}) を辿れないため, 写した定義を"
            "使えません (ML-ModelControl は weights.path を定義のファイルの"
            "ディレクトリから辿る)"
        )

    return path, None


def compare_current(
    project_dir: Path, current: Any, sha256: Optional[str]
) -> str:
    """
    今の定義が, 実験の記録した定義と同じ中身かを言う文を作る関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    current: Any
        今の定義の場所 (config の model.spec の値)
    sha256: Optional[str]
        実験の記録した定義の SHA-256

    Returns
    ----------
    message: str
        同じモデルになるか, 違うモデルになるか, 比べられないか
    """
    # 参照 (${) を含む場所と, 記録の無い実験は比べずに終了
    unknown = (
        "記録と比べられないので, この実験の後に書き換えていれば違うモデル"
        "になります"
    )
    if sha256 is None or not isinstance(current, str) or "${" in current:
        return unknown
    path = Path(os.path.expanduser(current))
    if not path.is_absolute():
        path = project_dir / path

    # リンクを辿らずに読み, 記録の sha256 と比べる
    content, _ = read_copy(path)
    if content is None:
        return unknown
    if hashlib.sha256(content).hexdigest() == sha256:
        message = (
            "定義のファイルは記録と同じ中身です. 外部の重みのファイルは"
            "比べていません"
        )
    else:
        message = (
            "定義のファイルが記録 (sha256) と違う中身なので, 違うモデルに"
            "なります"
        )

    return message


def run_of_copy(project_dir: Path, value: Any) -> Optional[Path]:
    """
    model.spec の値が実験に写した定義を指す場合に, その実験を返す関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    value: Any
        config の model.spec の値

    Returns
    ----------
    run_dir: Optional[Path]
        写した実験のディレクトリ. 写しを指さない場合は None
    """
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(os.path.expanduser(value))
    if not path.is_absolute():
        path = project_dir / path
    if path.name != MODEL_SPEC_FILE:
        return None

    # 実験のディレクトリの中か, 実験が消えた後も出力先の下の実験の形に
    # あれば写しの場所
    run_dir: Optional[Path] = path.parent
    in_run = all((path.parent / marker).is_file() for marker in RUN_MARKERS)
    if not in_run and not in_run_shape(project_dir, path):
        run_dir = None

    return run_dir


def in_run_shape(
    project_dir: Path, path: Path, output_dirs: Optional[list[Path]] = None
) -> bool:
    """
    パスが, 出力先の下の実験のディレクトリの形 (<名前>/<日付>/<時刻>/
    model_spec.yaml) にあるかを判定する関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    path: Path
        判定するパス
    output_dirs: Optional[list[Path]] = None
        プロジェクトの出力先 (読んだもの), None の場合は読む

    Returns
    ----------
    shaped: bool
        どれかの出力先の下の実験の形にあるかどうか, 出力先を読めない場合は
        False
    """
    try:
        if output_dirs is None:
            output_dirs = get_output_dirs(project_dir)
        target = path.resolve()
    except (ProjectError, OSError, RuntimeError):
        return False

    # 両側をリンクを辿った場所で比べ, 実験の形の深さと名前だけを認める
    shaped = False
    for output_dir in output_dirs:
        try:
            parts = target.relative_to(output_dir.resolve()).parts
        except (ValueError, OSError, RuntimeError):
            continue
        if (
            len(parts) == 4 and DATE_PATTERN.match(parts[1]) is not None
            and TIME_PATTERN.match(parts[2]) is not None
        ):
            shaped = True

    return shaped


def load_mapping(text: str) -> DictConfig:
    """
    experiment の config の中身を辞書の config として読む関数

    Parameters
    ----------
    text: str
        experiment の config の中身

    Returns
    ----------
    loaded: DictConfig
        読んだ config (参照は解決しない)
    """
    loaded = OmegaConf.create(text) if text.strip() else OmegaConf.create({})
    if not isinstance(loaded, DictConfig):
        raise ValueError(
            "experiment の config が「項目: 値」の形ではありません"
        )
    model = loaded.get("model")
    if model is not None and not isinstance(model, DictConfig):
        raise ValueError("experiment の config の model が辞書ではありません")

    return loaded


def raw_model_spec(loaded: DictConfig) -> Any:
    """
    config の model.spec の値を, 参照を解決せずに取り出す関数

    Parameters
    ----------
    loaded: DictConfig
        config

    Returns
    ----------
    value: Any
        model.spec の値, 無ければ None
    """
    model = loaded.get("model")
    value = None
    if isinstance(model, DictConfig) and "spec" in model:
        container = OmegaConf.to_container(model, resolve=False)
        if isinstance(container, dict):
            value = container.get("spec")

    return value


def default_model_spec(project_dir: Path, default: Optional[str]) -> Any:
    """
    default の config の model.spec の値を読む関数

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    default: Optional[str]
        default の config (プロジェクトからの相対パス)

    Returns
    ----------
    value: Any
        model.spec の値, 読めないか無ければ None
    """
    if default is None:
        return None
    try:
        loaded = OmegaConf.load(project_dir / default)
    except Exception:
        return None
    value = raw_model_spec(loaded) if isinstance(loaded, DictConfig) else None

    return value


def set_model_spec(text: str, path: Optional[str]) -> str:
    """
    experiment の config の中身の model.spec を書き換えるか消す関数

    Parameters
    ----------
    text: str
        experiment の config の中身
    path: Optional[str]
        モデルの定義の場所, None の場合は消す (default の値に戻す)

    Returns
    ----------
    changed: str
        書き換えた YAML (元のコメントは消える)
    """
    loaded = load_mapping(text)
    if path is not None:
        OmegaConf.update(loaded, "model.spec", path, merge=True)
    else:
        # 消して空になった model も削除
        model = loaded.get("model")
        if isinstance(model, DictConfig) and "spec" in model:
            del model["spec"]
            if len(model) == 0:
                del loaded["model"]
    changed = OmegaConf.to_yaml(loaded)

    return changed


def check_copy_for_launch(project_dir: Path, text: str) -> Optional[str]:
    """
    起動する experiment の config の model.spec が実験に写した定義を指す
    場合に, 写しが今も記録の中身かを確かめる関数

    起動の画面を開いてから起動するまでに写しが書き換わっても, 違う定義で
    学習しないため

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    text: str
        experiment の config の中身

    Returns
    ----------
    reason: Optional[str]
        起動しない理由. 写しを指さないか, 確かめられた場合は None
    """
    # 読めない config は起動の前の確認に一任
    try:
        value = raw_model_spec(load_mapping(text))
    except Exception:
        return None
    run_dir = run_of_copy(project_dir, value)
    if run_dir is None:
        return None

    # 写した実験の記録と, 写しの中身の確かめ直し
    source = read_source(run_dir)
    if not run_dir.is_dir():
        reason: Optional[str] = "その実験がありません (消した実験の写し)"
    elif source is None or source.model_spec is None:
        reason = (
            "その実験に, 写した定義の記録 (source.yaml の model_spec) が"
            "ありません"
        )
    else:
        _, reason = find_model_spec_copy(
            project_dir, run_dir, source.model_spec
        )
    if reason is not None:
        reason = f"{COPY_REFUSED} ({value}): {reason}"

    return reason
