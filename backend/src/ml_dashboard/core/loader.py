import importlib
import threading

# ML-Found のモジュールを初めて読み込むときの排他
# ML-Found のモジュールは互いに読み込み合うので, 別々のスレッドの要求が
# 同時に違うモジュールから読み込むと, Python の読み込みのロックが互いを
# 待つ状態を検出してエラー (_DeadlockError)
ML_FOUND_IMPORT_LOCK = threading.Lock()


def import_ml_found() -> None:
    """
    ML-Found のパッケージを 1 つのスレッドから読み込む関数

    PyTorch も読み込むので, 起動時ではなく初めて使うときに読み込む.
    読み込んだ後は sys.modules から取り出すだけなので, 関数の中の
    import は待たずに済む

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    # パッケージの最上位から読み込み, 中のモジュールを決まった順で読み込み
    with ML_FOUND_IMPORT_LOCK:
        # ml_found の __init__ が中のモジュールを全て読み込むので, これで十分
        importlib.import_module("ml_found")
