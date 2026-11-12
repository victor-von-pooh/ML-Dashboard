import os
import secrets
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
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

# 起動ごとのトークンを指定する環境変数と, 保存する Cookie の名前
TOKEN_ENV = "ML_DASHBOARD_TOKEN"
TOKEN_COOKIE = "ml_dashboard_token"

# トークンを受け取って Cookie に保存するパス
AUTH_PATH = "/api/auth"


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
    # ブラウザが付ける Origin が, 接続先 (Host) と同じホストとポートかの確認
    origin = request.headers.get("origin")
    if request.method in UNSAFE_METHODS and origin is not None:
        if urlsplit(origin).netloc != request.headers.get("host"):
            response: Response = JSONResponse(
                {"detail": "別のサイトからの操作は受け付けません"},
                status_code=403
            )
            return response

    response = await call_next(request)

    return response


def make_auth_check(
    token: str
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]],
              Awaitable[Response]]:
    """
    API の呼び出しに起動ごとのトークンを求める処理を作る関数

    Parameters
    ----------
    token: str
        起動ごとのトークン

    Returns
    ----------
    check: Callable
        トークンが無い API の呼び出しを 401 にする処理
    """

    async def check(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        """
        Cookie かヘッダーのトークンを確かめる関数

        Parameters
        ----------
        request: Request
            リクエスト
        call_next: Callable[[Request], Awaitable[Response]]
            次の処理

        Returns
        ----------
        response: Response
            応答, トークンが合わない API の呼び出しは 401
        """
        # 学習を起動できるので, 同じ端末の他の利用者からも使えないように確認
        path = request.url.path
        if path.startswith("/api") and path != AUTH_PATH:
            given = [
                request.cookies.get(TOKEN_COOKIE, ""),
                request.headers.get("x-dashboard-token", "")
            ]
            if not any(same_token(value, token) for value in given):
                response: Response = JSONResponse(
                    {
                        "detail": "起動したときに表示された URL "
                        f"({AUTH_PATH}?token=...) を開いてください"
                    },
                    status_code=401
                )
                return response

        response = await call_next(request)

        return response

    return check


def same_token(given: str, token: str) -> bool:
    """
    トークンが一致するかを, 時間で推測されないように比べる関数

    Parameters
    ----------
    given: str
        送られたトークン
    token: str
        起動ごとのトークン

    Returns
    ----------
    same: bool
        一致するかどうか (ASCII 以外の文字も比較可能)
    """
    same = secrets.compare_digest(given.encode(), token.encode())

    return same


def get_token(token: Optional[str]) -> str:
    """
    起動ごとのトークンを決める関数

    Parameters
    ----------
    token: Optional[str]
        指定されたトークン, None の場合は環境変数かランダムに作成

    Returns
    ----------
    value: str
        トークン
    """
    value = token or os.environ.get(TOKEN_ENV) or secrets.token_urlsafe(24)

    return value


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


def create_app(
    data_dir: Optional[Path] = None, token: Optional[str] = None
) -> FastAPI:
    """
    アプリを組み立てる関数

    Parameters
    ----------
    data_dir: Optional[Path] = None
        ダッシュボードのデータの置き場, None の場合は既定の場所
    token: Optional[str] = None
        API の呼び出しに求めるトークン, None の場合は環境変数かランダムに作成

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

    # トークンの無い呼び出し, 他のサイトからの書き込み,
    # 他のホスト名での接続 (DNS rebinding) の拒否
    app.state.token = get_token(token)
    if token is None and not os.environ.get(TOKEN_ENV):
        # 開発用のサーバーなど, トークンを渡さずに作った場合は開き方を表示
        print(
            f"ML-Dashboard のトークン: {AUTH_PATH}?token={app.state.token}",
            flush=True
        )
    app.middleware("http")(make_auth_check(app.state.token))
    app.middleware("http")(check_origin)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

    @app.get(AUTH_PATH, include_in_schema=False)
    def authenticate(token: str = "") -> Response:
        """
        起動時の URL のトークンを Cookie に保存して画面に移る関数

        Parameters
        ----------
        token: str = ""
            URL で渡されたトークン

        Returns
        ----------
        response: Response
            画面への移動, トークンが違う場合は 401
        """
        if not same_token(token, app.state.token):
            response: Response = JSONResponse(
                {"detail": "トークンが違います"}, status_code=401
            )
            return response

        response = RedirectResponse("/", status_code=303)
        response.set_cookie(
            TOKEN_COOKIE, token, httponly=True, samesite="strict"
        )

        return response
    app.add_exception_handler(ProjectError, project_error)

    # API と画面の登録
    app.include_router(router)
    app.include_router(jobs_router)
    mount_frontend(app, STATIC_DIR)

    return app
