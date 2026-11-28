# TODO

このリポジトリでまだやっていないことを, 優先度の順に並べる. 終えたら消す.
優先度: 高・中・低は相対で, 項目があるかぎり高と中を空にしない. 高 = 今の節目「段階をまたいで 1 つのアプリとして流れる」に要るものと, リポジトリの間の食い違い. 中 = 高の次に進めるもの. 低 = 残り (まだ扱っていない型を足す作業もここに置く). 条件待ち = 実例か利用者の判断か上流の版が要る.

## 優先度 高

### `GET /progress` で学習・評価の段階の進みを返す
- 何を: `create_api` に `GET /progress?problem=<識別子>` を足し, 殻で選んだ問題の学習・評価の段階の `state`, `summary`, `back` を返す. 状態は上から順に採る. 問題が置き場に無ければ 404
    - `skip`: 学習しない問題. 問題の設定の `ml.use` が `false` (機械学習を使わないと答えた) か, 受け渡しの受け持ち `part` の `role` が `predict`, `group`, `rank` のどれかで `method` が `pretrained` (既製のモデルをそのまま使う予測, 群分け, 似た写真を探す. ML-Quest の `skeleton_type` の `ready`, `group_ready`, `search` と同じ). `ml.use` は受け渡し (`handoff`) が使わない問題で誤りにして返さないので, 問題の設定から読む. 異常の検知の距離に基づく度合い (受け渡しの学習の値は `None`) は, 実験を作るので要るものとする. 答えていない問題と, ML-Quest が入っていない (任意の依存) か受け渡しを読めない問題は要るものとして扱う
    - `blocked`: 問題に学習のプロジェクトの記録が無いか, 記録の場所に ML-Found のプロジェクトが無い (`back` は `problem`). default の config の `data.dataset` を書いていて, その場所にデータセットが無い (`data`). `model.spec` を書いていて, その場所に定義が無く, `model.placeholder: true` (ML-Quest のファイルの組の骨組みが書く仮のモデルの目印) も無い (`model`). 条件は「12. 学習の準備」の確かめと同じにし, `data.dataset` と `model.spec` を書いていない前提は止めない. データの分析かモデルの作成・選定が要らない問題 (例: 距離に基づく度合いの異常の検知のモデルの定義) では, config に場所を書いていてもその物を前提にしない (要るかの判定の値は, その段階のアプリの `skip` の判定と合わせる). 足りない物が複数あれば, `back` は最も前の段階
    - `running`: そのプロジェクトの学習のジョブが実行中か, 学習の後の処理中
    - `stale` と `done`: `run.json` の状態が完了の実験のうち最も新しいものの `source.yaml` の印 (モデルの定義の sha256 と `dataset.yaml` の sha256) を, 今の default の config の `model.spec` の中身と `data.dataset` の `dataset.yaml` と比べる. 違えば `stale` で, `back` は変わった物のうち最も前の段階 (データセットが変われば `data`, モデルの定義だけなら `model`). 印が無い物は比べず古いと出さない (全て無ければ `done` で, 新しさが分からないと `summary` に書く)
    - `none`: 前提はあり, 完了した実験が無い
    - 登録していないプロジェクトも記録の場所から読む (登録は利用者が押したときだけ行うため). 今の定義との比べは, 学習し直すときの比べ (`compare_current`) を使い回す. この項目では, `source.yaml` に `dataset.yaml` の sha256 が無い前提で, モデルの定義だけを比べる (データセットの比べは中の項目)
- なぜ: 殻の段階の並びに学習・評価の段階の進みの印を出すため. 今は `GET /api/problems/{problem_id}/project` と `run_count` とジョブと学習の準備が別々にあり, 問題の単位で 1 つの状態にまとめた API が無い
- 終わりの条件: docs/DESIGN.md の 4 の節に `GET /progress` と状態の写し方 (`skip` にする受け持ちの値を含む) を書き, API のテストで 6 つの状態と 404 と `back` の 3 つの値を確かめる. `make api` で画面の型を作り直す
- つながり: ML-Studio の docs/DESIGN.md の 2 の節の `GET /progress`, 9 の節の R13, R15, R16. ML-Studio の「段階の並びに段階の進みの印を出す」. 中の「実験の比べる物に `dataset.yaml` の sha256 を足す」の前

### 実験の詳細に次の段階へのボタンを出し, 進みが変わるときに `onProgressChange` を呼ぶ
- 何を: 根の部品の props に `onStageChange`, `nextStage`, `onProgressChange` (どれも任意) を足す. 実験の詳細の「この実験を推論の段階で使うには」の案内に「<`nextStage` の段階の名前>の段階へ」のボタンを出し, 押すと `onStageChange(nextStage)` を呼ぶ. `nextStage` が null (推論の段階が要らないなど, 後ろに要る段階が無い) ならボタンを出さない. 単独の起動 (`onStageChange` と `nextStage` が無い) ではボタンを出さず, 今の文だけを出す. `onProgressChange` は, ジョブの状態が変わるとき (起動した, 実行中から終わった), プロジェクトを登録する, 外すときに呼ぶ
- なぜ: 学習を終えた実験から推論の段階へ移る手段が殻の上の帯しか無く, 殻は部品の中で進みが変わったことを知れないため
- 終わりの条件: docs/DESIGN.md の 3 の節の「根の部品」の表に 3 つの props を書き, 画面のテストで, ボタンが `nextStage` の名前で `onStageChange(nextStage)` を呼ぶこと, `nextStage` が null のときと単独で出ないこと, ジョブの状態の変化と登録で `onProgressChange` を呼ぶことを確かめる
- つながり: ML-Studio の docs/DESIGN.md の 2 の節の `onStageChange`, `nextStage`, `onProgressChange`, 9 の節の R14, R13. ML-Studio の「根の部品に段階を移る `onStageChange` を渡す」と「段階の並びに段階の進みの印を出す」

## 優先度 中

### 実験の比べる物に `dataset.yaml` の sha256 を足す
- 何を: `GET /progress` の `stale` の比べに, 完了した最も新しい実験の `source.yaml` の `dataset.yaml` の sha256 と, 今の `data.dataset` の `dataset.yaml` の sha256 の比べを足す. 違えば `back` を `data` にする. 欄の名前と形は ML-Found の docs/FORMAT.md に従い, 欄の無い実験は比べない
- なぜ: データセットを書き出し直しても, 実験が古いと出ないため. 今の実験の `source.yaml` にデータセットの印が無い
- 終わりの条件: ML-Found の版を上げ, API のテストで, データセットだけが変わると `stale` と `data`, 両方が変わると `data`, 欄の無い実験では古いと出さないことを確かめる. docs/DESIGN.md の 2 の節の「読むファイル」に読む欄を書く
- つながり: ML-Studio の docs/DESIGN.md の 9 の節の R15 と段階の物の表. ML-Found の「実験の source.yaml に dataset.yaml の sha256 を残す」の後. 高の「`GET /progress` で学習・評価の段階の進みを返す」の後

### 前提が足りない文に戻る段階へのボタンを出す
- 何を: 学習の準備の欄で, データセットが無いときに「データの分析の段階へ」, モデルの定義が無く仮のモデルの目印も無いときに「モデルの作成・選定の段階へ」のボタンを出す. 選んだ問題の欄で, 学習のプロジェクトの記録が無いか記録の場所に無いときに「問題の設定の段階へ」のボタンを出す. 押すと `onStageChange` を呼ぶ. `onStageChange` が無いときは今の文だけを出す. 条件は `GET /progress` の `blocked` と同じにする
- なぜ: 足りない物を置く段階の名前は出すが, その段階へ移る手段が殻の上の帯しか無いため
- 終わりの条件: docs/DESIGN.md の 3 の節の「殻で選んだ問題」と 12 の節に書き, 画面のテストで 3 つのボタンが正しい段階の鍵で `onStageChange` を呼ぶことと, 単独では出ないことを確かめる
- つながり: ML-Studio の docs/DESIGN.md の 9 の節の R16 と条件の表. 高の 2 つの項目の後 (`onStageChange` の props と `blocked` の条件を使う)

## 優先度 低

### 開いているプロジェクトが選んだ問題の物でないときに食い違いを出す
- 何を: `/projects/{id}` の下を開いたとき, そのプロジェクトが殻で選んだ問題の記録した学習のプロジェクトでなければ, 「開いている学習のプロジェクトは選んだ問題の物ではありません」の文と, プロジェクトの画面へ移るボタンを出す. 殻の選びは替えない. `project` が null のときと単独の起動では出さない
- なぜ: 直接の URL で開いたプロジェクトを選んだ問題と確かめずに出すので, 他の問題の実験を取り違えるため. 殻が選んだ問題を URL に持つと多くは起きないので, 高と中の後に置く
- 終わりの条件: docs/DESIGN.md の 3 の節の「殻で選んだ問題」に書き, 画面のテストで, 違う問題のプロジェクトの URL で文が出て, 同じ問題では出ないことを確かめる
- つながり: ML-Studio の docs/DESIGN.md の 9 の節の R18. ML-Studio の「選んだ問題を URL に持つ」と「開いている物と選んだ問題の食い違いを殻の e2e で確かめる」

## 条件待ち

無し
