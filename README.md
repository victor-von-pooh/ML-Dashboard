# ML-Dashboard

[ML-Found](https://github.com/victor-von-pooh/ML-Found) で行った実験の結果を確かめるための, ローカルで動く Web アプリ.

ML-Found が実験ごとに残すディレクトリ (`history.csv`, `config.yaml`, `train.log` など) をそのまま読むので, 学習のコードに手を加えなくても, 既にある実験を一覧にして比べられる.

## できること

- **プロジェクト**: ML-Found を使っているディレクトリを登録する. 親のディレクトリを指定すると, 下の階層のプロジェクトをまとめて探して登録できる
- **実験の一覧**: 状態, default との差分, エポック数, ベストの指標, 学習時間を表で見る. config の差分の文字で絞り込み, 並べ替える
- **実験の詳細**
    - 学習曲線: 学習用と検証用を重ねたグラフ. ベストのエポックと Early Stopping の位置を示す. 拡大と対数の縦軸に対応
    - config: default との差分と, config 全体の検索
    - モデル: モデルの構造, Optimizer, Scheduler
    - 環境: git の情報, OS, PyTorch, パッケージの一覧, 学習時の未コミットの変更
    - ログ: `train.log` を警告とエラーで絞り込み, 検索する
    - ファイル: 学習曲線や生成画像の一覧と, ファイルのダウンロード
- **比較**: 選んだ実験 (8 つまで) の学習曲線を指標ごとに重ね, config の違う項目を並べる
- ライトとダークの表示

今後の予定 (学習の起動, 進み具合の表示, 中断など) は [docs/DESIGN.md](docs/DESIGN.md) の「段階」を参照.

## 必要なもの

- Python 3.10 以上と [uv](https://docs.astral.sh/uv/)
- Node.js 24 以上と [pnpm](https://pnpm.io/)

## 導入と起動

```bash
git clone --recursive https://github.com/victor-von-pooh/ML-Dashboard.git
cd ML-Dashboard
make setup   # submodule, Python と Node.js の依存
make serve   # 画面をビルドして http://127.0.0.1:8765 で起動
```

起動したら, 画面の「プロジェクトを追加」から ML-Found を使っているディレクトリを登録する.

登録したプロジェクトなどのダッシュボードのデータは `~/.ml-dashboard/` に保存する. 環境変数 `ML_DASHBOARD_HOME` で場所を変えられる.
プロジェクトのディレクトリには何も書き込まない.

## 開発

```bash
make dev-backend    # API (http://127.0.0.1:8765, 変更を自動で反映)
make dev-frontend   # 画面 (http://localhost:5173, API に転送)
make check          # lint, 型検査, テスト
make api            # バックエンドの API を変えたら, 画面の型を作り直す
```

| ディレクトリ | 内容 |
| --- | --- |
| `backend/` | API (Python, FastAPI). `core/` が ML-Found の出力の読み込み, `api/` がルーティング |
| `frontend/` | 画面 (TypeScript, React, Vite). `src/api/schema.d.ts` は OpenAPI から生成した型 |
| `ML-Found/` | submodule |
| `docs/DESIGN.md` | 設計の方針と段階 |

## ライセンス

[MIT](LICENSE)
