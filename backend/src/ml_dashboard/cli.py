import argparse
import json
from pathlib import Path

import uvicorn

from ml_dashboard.app import create_app, get_token


def parse_args() -> argparse.Namespace:
    """
    コマンドライン引数を読み込む関数

    Parameters
    ----------
    None

    Returns
    ----------
    args: argparse.Namespace
        コマンドライン引数
    """
    parser = argparse.ArgumentParser(prog="ml-dashboard")
    parser.add_argument("--host", default="127.0.0.1", help="待ち受けるホスト")
    parser.add_argument("--port", type=int, default=8765, help="ポート番号")
    parser.add_argument(
        "--openapi", type=Path, default=None,
        help="起動せずに OpenAPI の仕様をこのファイルに書き出す"
    )
    args = parser.parse_args()

    return args


def main() -> None:
    """
    ダッシュボードを起動する関数

    Parameters
    ----------
    None

    Returns
    ----------
    None
    """
    args = parse_args()

    # 画面の型を生成するための仕様の書き出し
    if args.openapi is not None:
        app = create_app(token="unused")
        text = json.dumps(app.openapi(), ensure_ascii=False, indent=2)
        args.openapi.write_text(text + "\n", encoding="utf-8")
        return

    # 外から接続できるホストでは, 他の端末から学習を起動できる可能性を警告
    if args.host not in ("127.0.0.1", "localhost"):
        print(
            f"警告: {args.host} で待ち受けます. ML-Dashboard は学習の"
            "プロセスを起動できるので, トークンを知る人はコードを実行できます"
        )

    # 起動ごとのトークン付きの URL の表示
    # 全てのアドレスで待ち受ける場合も, 手元のブラウザで開ける URL を表示
    app = create_app(token=get_token(None))
    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    print(
        "ML-Dashboard を開く: "
        f"http://{shown}:{args.port}/api/auth?token={app.state.token}",
        flush=True
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
