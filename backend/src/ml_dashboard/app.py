from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles

from ml_dashboard.api.jobs import router as jobs_router
from ml_dashboard.api.routes import router
from ml_dashboard.core.jobs import JobManager
from ml_dashboard.core.projects import ProjectError, ProjectStore
from ml_dashboard.core.settings import get_data_dir

# ビルド済みの画面を置く場所 (パッケージの中)
STATIC_DIR = (Path(__file__).parent / "static").resolve()

# ローカルからだけ使う前提で受け付けるホスト名
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver"]

# 状態を変えるメソッド
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def route_id(route: APIRoute) -> str:
    """
    OpenAPI の操作の ID を関数名から作る関数

    Parameters
    ----------
    route: APIRoute
        API のルート

    Returns
    ----------
    operation_id: str
        関数名 (画面の型の名前に使われる)
    """
    operation_id = route.name

    return operation_id


async def check_origin(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """
    他のサイトから状態を変える API を呼べないようにする関数

    Parameters
    ----------
    request: Request
        リクエスト
    call_next: Callable[[Request], Awaitable[Response]]
        次の処理

    Returns
    ----------
    response: Response
        応答, 別の Origin からの書き込みは 403
    """
    # ブラウザが付ける Origin のホストが, 待ち受けているホストと同じかの確認
    origin = request.headers.get("origin")
    if request.method in UNSAFE_METHODS and origin is not None:
        host = urlsplit(origin).hostname
        if host not in ALLOWED_HOSTS:
            response: Response = JSONResponse(
                {"detail": "別のサイトからの操作は受け付けません"},
                status_code=403
            )
            return response

    response = await call_next(request)

    return response


async def project_error(request: Request, error: Exception) -> Response:
    """
    登録簿が壊れている場合などのエラーを応答に変える関数

    Parameters
    ----------
    request: Request
        リクエスト
    error: Exception
        起きたエラー

    Returns
    ----------
    response: Response
        500 とエラーの内容
    """
    response = JSONResponse({"detail": str(error)}, status_code=500)

    return response


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

    @app.get("/{path:path}", include_in_schema=False)
    def serve_index(path: str) -> FileResponse:
        """
        画面のファイルか, 画面の中の移動先として index.html を返す関数

        Parameters
        ----------
        path: str
            要求されたパス

        Returns
        ----------
        response: FileResponse
            ファイルか index.html
        """
        # 存在しない API は画面ではなく 404 として返却
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "API が見つかりません")

        target = (static_dir / path).resolve()
        if path and target.is_relative_to(static_dir) and target.is_file():
            response = FileResponse(target)
            return response

        response = FileResponse(index)

        return response


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
    app = FastAPI(
        title="ML-Dashboard", version="0.1.0",
        generate_unique_id_function=route_id
    )

    # プロジェクトの登録簿とジョブの管理をアプリに保存
    home = data_dir or get_data_dir()
    app.state.store = ProjectStore(home)
    app.state.jobs = JobManager(home)

    # 他のホスト名での接続 (DNS rebinding) と, 他のサイトからの書き込みの拒否
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    app.middleware("http")(check_origin)
    app.add_exception_handler(ProjectError, project_error)

    # API と画面の登録
    app.include_router(router)
    app.include_router(jobs_router)
    mount_frontend(app, STATIC_DIR)

    return app
