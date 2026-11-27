import hashlib
import os
import secrets
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles

from ml_dashboard.api.batches import router as batches_router
from ml_dashboard.api.environment import router as environment_router
from ml_dashboard.api.jobs import router as jobs_router
from ml_dashboard.api.notes import router as notes_router
from ml_dashboard.api.requirements import router as requirements_router
from ml_dashboard.api.routes import router
from ml_dashboard.core.batches import BatchManager
from ml_dashboard.core.environment import EnvironmentJobs
from ml_dashboard.core.jobs import JobManager
from ml_dashboard.core.model_spec import COPY_REFUSED_CODE, CopyRefusedError
from ml_dashboard.core.notes import NoteStore
from ml_dashboard.core.projects import ProjectError, ProjectStore
from ml_dashboard.core.settings import get_data_dir, get_problems_dir

# ビルド済みの画面を置く場所 (パッケージの中)
STATIC_DIR = (Path(__file__).parent / "static").resolve()

# ローカルからだけ使う前提で受け付けるホスト名
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

# 状態を変えるメソッド
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# 起動ごとのトークンを指定する環境変数と, 保存する Cookie の名前
TOKEN_ENV = "ML_DASHBOARD_TOKEN"
TOKEN_COOKIE = "ml_dashboard_token"

# 単独の起動で API を置く頭と, トークンを受け取って Cookie に保存するパス
API_PREFIX = "/api"
AUTH_PATH = "/api/auth"

# 仕様の名前と版
TITLE = "ML-Dashboard"
VERSION = "0.1.0"

# API だけのアプリに加える router (どれも頭なし)
ROUTERS = [
    router, jobs_router, batches_router, notes_router, requirements_router,
    environment_router
]


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


async def check_token(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """
    API の呼び出しに起動ごとのトークンを求める関数

    Parameters
    ----------
    request: Request
        リクエスト (request.app は外側のアプリ. token を持つ)
    call_next: Callable[[Request], Awaitable[Response]]
        次の処理

    Returns
    ----------
    response: Response
        応答, Cookie かヘッダーのトークンが合わない API の呼び出しは 401
    """
    # 学習を起動できるので, 同じ端末の他の利用者からも使えないように確認
    token: str = request.app.state.token
    path = request.url.path
    # トークンを受け取る GET /api/auth だけの除外 (他のメソッドは確かめの対象)
    opening = path == AUTH_PATH and request.method == "GET"
    if path.startswith(API_PREFIX) and not opening:
        given = [
            request.cookies.get(cookie_name(token), ""),
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


def cookie_name(token: str) -> str:
    """
    トークンを保存する Cookie の名前を作る関数

    Cookie はポートを区別しないので, 同じ端末で動かす別のインスタンス
    (開発用のサーバーなど) と重ならないように, トークンから名前を作る

    Parameters
    ----------
    token: str
        起動ごとのトークン

    Returns
    ----------
    name: str
        Cookie の名前
    """
    digest = hashlib.sha256(token.encode()).hexdigest()[:12]
    name = f"{TOKEN_COOKIE}_{digest}"

    return name


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


async def copy_refused(request: Request, error: Exception) -> Response:
    """
    実験に写した定義を使えずに起動しないことを応答に変える関数

    Parameters
    ----------
    request: Request
        リクエスト
    error: Exception
        起きたエラー (CopyRefusedError)

    Returns
    ----------
    response: Response
        400 と理由と code (画面が見分けて次の一手を出すため)
    """
    response = JSONResponse(
        {"detail": str(error), "code": COPY_REFUSED_CODE}, status_code=400
    )

    return response


def serve_index(request: Request, path: str) -> FileResponse:
    """
    画面のファイルか, 画面の中の移動先として index.html を返す関数

    Parameters
    ----------
    request: Request
        リクエスト (request.app は画面のディレクトリを持つ)
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

    static_dir: Path = request.app.state.static_dir
    target = (static_dir / path).resolve()
    if path and target.is_relative_to(static_dir) and target.is_file():
        response = FileResponse(target)
        return response

    response = FileResponse(static_dir / "index.html")

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
    if not (static_dir / "index.html").is_file():
        return

    # JavaScript や CSS などのファイルと, 他のパスの index.html の配信
    app.state.static_dir = static_dir
    app.mount(
        "/assets", StaticFiles(directory=static_dir / "assets"), name="assets"
    )
    app.add_api_route(
        "/{path:path}", serve_index, methods=["GET"], include_in_schema=False
    )


def authenticate(request: Request, token: str = "") -> Response:
    """
    起動時の URL のトークンを Cookie に保存して画面に移る関数

    Parameters
    ----------
    request: Request
        リクエスト (request.app は外側のアプリ. token を持つ)
    token: str = ""
        URL で渡されたトークン

    Returns
    ----------
    response: Response
        画面への移動, トークンが違う場合は 401
    """
    if not same_token(token, request.app.state.token):
        response: Response = JSONResponse(
            {"detail": "トークンが違います"}, status_code=401
        )
        return response

    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        cookie_name(token), token, httponly=True, samesite="strict"
    )

    return response


def create_api(
    data_dir: Optional[Path] = None, *, problems_dir: Optional[Path] = None
) -> FastAPI:
    """
    確かめと画面の配信を持たない, API だけのアプリを組み立てる関数

    殻 (ML-Studio) は /api/train のような頭の下に mount し, トークン,
    Origin, ホスト名の確かめは殻が持つ. 終わりの片付けは無い (学習の
    プロセスは別の session で動き, ジョブの記録は置き場のファイル)

    Parameters
    ----------
    data_dir: Optional[Path] = None
        ダッシュボードのデータの置き場, None の場合は既定の場所
    problems_dir: Optional[Path] = None
        ML-Pathfinder の問題の設定の置き場, None の場合は既定の場所
        (環境変数 ML_PATHFINDER_HOME か, ホームの下)

    Returns
    ----------
    app: FastAPI
        頭なしの経路を持つアプリ (仕様の画面は閉じる)
    """
    # 手元のファイルを読めるので, 仕様の画面は非公開
    # (仕様の書き出しは build_openapi)
    app = FastAPI(
        title=TITLE, version=VERSION, generate_unique_id_function=route_id,
        docs_url=None, redoc_url=None, openapi_url=None
    )

    # プロジェクトの登録簿, ジョブの管理, 問題の設定の置き場をアプリに保存
    # (ルートは request.app.state から. 呼ぶたびに新しい管理で, 前の
    # プロセスが持ち主の候補のまとまりの取りやめもここで実行)
    home = data_dir or get_data_dir()
    app.state.store = ProjectStore(home)
    app.state.jobs = JobManager(home)
    app.state.batches = BatchManager(home)
    app.state.environments = EnvironmentJobs(home, app.state.store)
    app.state.notes = NoteStore(home)
    app.state.problems_dir = problems_dir or get_problems_dir()

    # 登録簿が壊れている場合と, 写した定義を使えない場合の応答
    app.add_exception_handler(ProjectError, project_error)
    app.add_exception_handler(CopyRefusedError, copy_refused)

    # API の登録
    for part in ROUTERS:
        app.include_router(part)

    return app


def build_openapi() -> dict[str, Any]:
    """
    単独の起動での経路 (/api の下) の OpenAPI の仕様を作る関数

    外側のアプリの仕様には mount した API が入らないので, API だけの
    アプリの仕様のパスに頭を付ける

    Parameters
    ----------
    None

    Returns
    ----------
    schema: dict[str, Any]
        OpenAPI の仕様
    """
    schema = create_api().openapi()
    schema["paths"] = {
        API_PREFIX + path: item for path, item in schema["paths"].items()
    }

    return schema


def create_app(
    data_dir: Optional[Path] = None, token: Optional[str] = None,
    allowed_hosts: Optional[list[str]] = None
) -> FastAPI:
    """
    単独で起動するアプリを組み立てる関数

    トークン, Origin, ホスト名の確かめ, /api/auth, 画面の配信を持つ外側の
    アプリに, API だけのアプリ (create_api) を /api で mount する

    Parameters
    ----------
    data_dir: Optional[Path] = None
        ダッシュボードのデータの置き場, None の場合は既定の場所
    token: Optional[str] = None
        API の呼び出しに求めるトークン, None の場合は環境変数かランダムに作成
    allowed_hosts: Optional[list[str]] = None
        受け付けるホスト名, None の場合は 127.0.0.1 と localhost

    Returns
    ----------
    app: FastAPI
        アプリ
    """
    # 確かめと画面の配信を持つ外側のアプリ (仕様の画面は閉じる)
    app = FastAPI(
        title=TITLE, version=VERSION, docs_url=None, redoc_url=None,
        openapi_url=None
    )

    # トークンの無い呼び出し, 他のサイトからの書き込み,
    # 他のホスト名での接続 (DNS rebinding) の拒否
    app.state.token = get_token(token)
    if token is None and not os.environ.get(TOKEN_ENV):
        # 開発用のサーバーなど, トークンを渡さずに作った場合は開き方を表示
        print(
            f"ML-Dashboard のトークン: {AUTH_PATH}?token={app.state.token}",
            flush=True
        )
    app.middleware("http")(check_token)
    app.middleware("http")(check_origin)
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=allowed_hosts or ALLOWED_HOSTS
    )

    # トークンの受け取り, API, 画面の登録 (/api/auth は API より先に照合)
    app.add_api_route(
        AUTH_PATH, authenticate, methods=["GET"], include_in_schema=False
    )
    app.mount(API_PREFIX, create_api(data_dir))
    mount_frontend(app, STATIC_DIR)

    return app
