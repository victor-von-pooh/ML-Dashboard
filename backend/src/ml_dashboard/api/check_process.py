import builtins
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

# 確かめのプロセスを待つ秒数 (自作のクラスの読み込みが止まった場合の上限)
CHECK_TIMEOUT = 120

# 結果を返さずに終わった場合に, 理由に添える標準エラー出力の文字数
STDERR_CHARS = 1000


def make_exception(name: str, message: str) -> Exception:
    """
    種類の名前と文から, 同じ名前の種類のエラーを作る関数

    Parameters
    ----------
    name: str
        エラーの種類の名前
    message: str
        エラーの文

    Returns
    ----------
    error: Exception
        組み込みの種類はその種類, 他は同じ名前の種類のエラー (文は同じ)
    """
    # 画面の文は種類の名前と文だけで作るので, 名前と文が同じものを作成
    cls = getattr(builtins, name, None)
    if not (isinstance(cls, type) and issubclass(cls, Exception)):
        cls = type(name, (Exception,), {})
    error: Exception
    try:
        error = cls(message)
    except Exception:
        error = type(name, (Exception,), {})(message)
    if str(error) != message:
        error = type(name, (Exception,), {})(message)

    return error


def describe_exception(error: BaseException) -> dict[str, Any]:
    """
    エラーの種類の名前と文と原因を, 受け渡せる形にする関数

    Parameters
    ----------
    error: BaseException
        確かめのエラー

    Returns
    ----------
    info: dict[str, Any]
        type, message と, 原因 (cause. 無ければ None) の辞書
    """
    cause = error.__cause__
    info = {
        "type": type(error).__name__,
        "message": str(error),
        "cause": None if cause is None else {
            "type": type(cause).__name__, "message": str(cause)
        }
    }

    return info


def rebuild_exception(info: dict[str, Any]) -> Exception:
    """
    受け取った種類の名前と文と原因から, エラーを作り直す関数

    Parameters
    ----------
    info: dict[str, Any]
        describe_exception で作った辞書

    Returns
    ----------
    error: Exception
        種類の名前と文が同じエラー (原因も同じ形で付ける)
    """
    error = make_exception(str(info["type"]), str(info["message"]))
    cause = info.get("cause")
    if isinstance(cause, dict):
        error.__cause__ = make_exception(
            str(cause["type"]), str(cause["message"])
        )

    return error


def stop_group(process: subprocess.Popen[str]) -> None:
    """
    待ち切りの確かめのプロセスを, 子のプロセスごと止める関数

    Parameters
    ----------
    process: subprocess.Popen[str]
        確かめのプロセス (別のグループで起動したもの)

    Returns
    ----------
    None
    """
    # 孫のプロセスが残らないように, グループごとに停止
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        process.kill()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def run_check_process(
    project_dir: Path, default_path: Path, path: Path
) -> tuple[list[str], list[str], Optional[str]]:
    """
    自作のクラスを読む確かめを, プロジェクトのディレクトリで別のプロセスと
    して行う関数

    学習のスクリプトと同じく, プロジェクトのディレクトリを sys.path の
    先頭に置いて読むので, モジュールの探し方が学習と同じになる

    Parameters
    ----------
    project_dir: Path
        プロジェクトのディレクトリ
    default_path: Path
        元にする default の config
    path: Path
        experiment の config のパス

    Returns
    ----------
    warnings: list[str]
        注意
    notes: list[str]
        お知らせ
    value_error: Optional[str]
        引数の値の誤り, 無ければ None
    """
    # 結果は一時ファイルで受け取り (自作のモジュールの print と分けるため)
    # -m で動かすと, 作業ディレクトリ (プロジェクト) が sys.path の先頭
    with tempfile.TemporaryDirectory() as directory:
        result_path = Path(directory) / "result.json"
        command = [
            sys.executable, "-m", "ml_dashboard.api.check_process",
            str(default_path), str(path), str(result_path), str(project_dir)
        ]
        try:
            process = subprocess.Popen(
                command, cwd=project_dir, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
                start_new_session=True
            )
        except OSError as error:
            raise ValueError(
                f"確かめのプロセスを動かせません: {error}"
            ) from error
        try:
            _, stderr = process.communicate(timeout=CHECK_TIMEOUT)
        except subprocess.TimeoutExpired:
            stop_group(process)
            raise ValueError(
                f"自作のクラスの確かめが {CHECK_TIMEOUT} 秒で"
                "終わりませんでした"
            ) from None
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            result = None

    # 結果を書かずに終わった場合 (sys.exit など) は, 標準エラー出力の末尾を
    # 理由に追加
    if not isinstance(result, dict):
        tail = stderr.strip()[-STDERR_CHARS:]
        raise ValueError(
            "自作のクラスを確かめるプロセスが結果を返さずに終わりました "
            f"(終了コード {process.returncode})"
            + (f": {tail}" if tail else "")
        )
    if isinstance(result.get("error"), dict):
        raise rebuild_exception(result["error"])
    value_error = result.get("value_error")
    checked = (
        [str(text) for text in result.get("warnings", [])],
        [str(text) for text in result.get("notes", [])],
        None if value_error is None else str(value_error)
    )

    return checked


def main() -> None:
    """
    確かめのプロセスの本体の関数 (引数は default, experiment, 結果のパスと
    プロジェクトのディレクトリ)

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # ダッシュボードの確かめと同じ関数で, 読み込みから確かめまでを実行
    from ml_dashboard.api.jobs import check_loaded
    from ml_dashboard.core.loader import import_ml_found

    default_path, path, result_path, project_dir = sys.argv[1:5]
    result: dict[str, Any]
    try:
        import_ml_found()
        from ml_found.config import load_config

        cfg, _ = load_config(default_path, path)
        warnings, notes, value_error = check_loaded(cfg, Path(project_dir))
        result = {
            "warnings": warnings, "notes": notes, "value_error": value_error
        }
    except Exception as error:
        result = {"error": describe_exception(error)}
    Path(result_path).write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
