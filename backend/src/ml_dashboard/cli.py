import argparse
import json
from pathlib import Path

import uvicorn

from ml_dashboard.app import create_app


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
    app = create_app()

    # 画面の型を生成するための仕様の書き出し
    if args.openapi is not None:
        text = json.dumps(app.openapi(), ensure_ascii=False, indent=2)
        args.openapi.write_text(text + "\n", encoding="utf-8")
        return

    # 外から接続できるホストでは, 他の端末から学習を起動できてしまうので警告
    if args.host not in ("127.0.0.1", "localhost"):
        print(
            f"警告: {args.host} で待ち受けます. ML-Dashboard は 1 人で "
            "ローカルから使う前提で, 認証がありません"
        )

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
