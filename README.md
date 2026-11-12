# ML-Dashboard

[ML-Found](https://github.com/victor-von-pooh/ML-Found) で行った実験の結果を確かめるための, ローカルで動く Web アプリ.

ML-Found が実験ごとに残すディレクトリ (`history.csv`, `config.yaml`, `train.log` など) をそのまま読むので, 学習のコードに手を加えなくても, 既にある実験を一覧にして比べられる.

## できること

- **プロジェクト**: ML-Found を使っているディレクトリ (`configs/default/train.yaml` を持つもの) を登録する. 親のディレクトリを指定すると, 3 階層下までのプロジェクトをまとめて探して登録できる (隠しディレクトリと `outputs`, `data`, `node_modules` などは探さない)
- **実験の一覧**: 状態, default との差分, エポック数, ベストの指標, 学習時間を表で見る. config の差分の文字で絞り込み, 並べ替える
- **実験の詳細**
    - 学習曲線: 学習用と検証用を重ねたグラフ. ベストのエポックと Early Stopping の位置を示す. 拡大と対数の縦軸に対応
    - config: default との差分と, config 全体の検索
    - モデル: モデルの構造, Optimizer, Scheduler
    - 環境: git の情報, OS, PyTorch, パッケージの一覧, 学習時の未コミットの変更
    - ログ: `train.log` を警告とエラーで絞り込み, 検索する
    - ファイル: 学習曲線や生成画像の一覧と, ファイルのダウンロード
- **比較**: 選んだ実験 (8 つまで) の学習曲線を指標ごとに重ね, config の違う項目を並べる
- **学習の起動**: 学習のスクリプトと experiment の config を選び, 必要なら画面で書き換えて, プロジェクトの Python で学習を始める. 起動の前に ML-Found で config の誤り (存在しない項目など) を確かめる
- **ジョブ**: 起動した学習のエポックとバッチの進捗バー, 残り時間の目安, 標準出力を見る. エポックの区切りで止めるか, すぐに止める (Ctrl-C と同じ). 学習中の実験は一覧と学習曲線も自動で更新する
- ライトとダークの表示

進み具合の表示と中断は, ML-Found が実験のディレクトリに書く `run.json` と `progress.json`, `STOP` のファイルを使う (ML-Found の README の「学習の外からの確認と中断」). 今後の予定は [docs/DESIGN.md](docs/DESIGN.md) の「段階」を参照.

## 必要なもの

- Python 3.10 以上と [uv](https://docs.astral.sh/uv/). ML-Found の依存の PyTorch も入るので, 最初の `make setup` は時間がかかる
- Node.js 24 以上と [pnpm](https://pnpm.io/)

## 導入と起動

```bash
git clone --recursive https://github.com/victor-von-pooh/ML-Dashboard.git
cd ML-Dashboard
make setup   # submodule, Python と Node.js の依存
make serve   # 画面をビルドして http://127.0.0.1:8765 で起動
```

起動したら, 画面の「プロジェクトを追加」から ML-Found を使っているディレクトリを登録する.

`make serve` は毎回画面をビルドしてから起動する. ポートを変える場合は `make serve PORT=8800` のように指定する. ビルド済みの場合は `cd backend && uv run ml-dashboard --port 8800` でも起動できる.
ローカルから 1 人で使う前提なので, 既定では `127.0.0.1` だけで待ち受ける. `--host` で変えられるが, 認証が無いので勧めない.

登録したプロジェクトなどのダッシュボードのデータは `~/.ml-dashboard/` に保存する. 環境変数 `ML_DASHBOARD_HOME` で場所を変えられる.
画面で書き換えた config と, 起動した学習の標準出力もここに保存する. プロジェクトのディレクトリには, 学習を止めるときの `STOP` 以外は何も書き込まない.

## 開発

```bash
make dev-backend    # API (http://127.0.0.1:8765, 変更を自動で反映. 画面の開発サーバーはこのポートに転送する)
make dev-frontend   # 画面 (http://localhost:5173, API に転送. ポートを変えた場合は両方に PORT=... を付ける)
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
