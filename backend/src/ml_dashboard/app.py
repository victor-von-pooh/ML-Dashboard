from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ml_dashboard.api.routes import router
from ml_dashboard.core.projects import ProjectStore
from ml_dashboard.core.settings import get_data_dir

# ビルド済みの画面を置く場所 (パッケージの中)
STATIC_DIR = Path(__file__).parent / "static"


def mount_frontend(app: FastAPI, static_dir: Path) -> None:
    """
    ビルド済みの画面を配信する設定を加える関数

    Parameters
    ----------
    app: FastAPI
        アプリ
    static_dir: Path
        ビルド済みの画面のディレクトリ

    Returns
    ----------
    None
    """
    index = static_dir / "index.html"
    if not index.is_file():
        return

    # JavaScript や CSS などのファイルの配信
    app.mount(
        "/assets", StaticFiles(directory=static_dir / "assets"), name="assets"
    )

    # 画面の中の移動は全て index.html で受ける
    @app.get("/{path:path}", include_in_schema=False)
    def serve_index(path: str) -> FileResponse:
        target = (static_dir / path).resolve()
        if path and target.is_relative_to(static_dir) and target.is_file():
            return FileResponse(target)

        return FileResponse(index)


def create_app(data_dir: Optional[Path] = None) -> FastAPI:
    """
    アプリを組み立てる関数

    Parameters
    ----------
    data_dir: Optional[Path] = None
        ダッシュボードのデータの置き場, None の場合は既定の場所

    Returns
    ----------
    app: FastAPI
        アプリ
    """
    app = FastAPI(title="ML-Dashboard", version="0.1.0")

    # プロジェクトの登録簿をアプリに保存
    app.state.store = ProjectStore(data_dir or get_data_dir())

    # API と画面の登録
    app.include_router(router)
    mount_frontend(app, STATIC_DIR)

    return app
