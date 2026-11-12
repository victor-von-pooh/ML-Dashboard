# よく使うコマンドをまとめる. 詳しくは README を参照

# 待ち受けるポート (make serve PORT=8800 のように変更)
PORT ?= 8765

# 開発用のサーバーは変更のたびに作り直されるので, make を実行した間は同じトークンを使用
DEV_TOKEN ?= $(shell python3 -c 'import secrets; print(secrets.token_urlsafe(16))')

.PHONY: setup dev-backend dev-frontend build serve api check

# 依存のインストール
setup:
	git submodule update --init
	cd backend && uv sync
	cd frontend && pnpm install

# 開発用のサーバー (2 つの端末で起動)
dev-backend:
	@echo "画面を開く: http://localhost:5173/api/auth?token=$(DEV_TOKEN)"
	cd backend && ML_DASHBOARD_TOKEN=$(DEV_TOKEN) uv run uvicorn ml_dashboard.app:create_app --factory --reload --port $(PORT)

dev-frontend:
	cd frontend && API_PORT=$(PORT) pnpm dev

# 画面をビルドしてバックエンドのパッケージに入れる
build:
	cd frontend && pnpm build

# ビルドした画面ごと起動
serve: build
	cd backend && uv run ml-dashboard --port $(PORT)

# API の型を作り直す
api:
	cd frontend && pnpm gen:api

# lint, 型検査, テスト
check:
	cd backend && uv run ruff check . && uv run mypy src && uv run pytest -q
	cd frontend && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
