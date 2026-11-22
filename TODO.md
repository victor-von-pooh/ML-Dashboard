# TODO

このリポジトリでまだやっていないことを, 優先度の順に並べる. 終えたら消す.
優先度: 高 = 「強化学習の方策を推論まで通す」に要るものか, リポジトリの間の食い違い. 中 = 「生成と強化学習の学習を画面で通す」に要るもの. 低 = その先. 条件待ち = 実例か利用者の判断が要る.

## 優先度 高

無し

## 優先度 中

無し

## 優先度 低

### ML-Found の内部のモジュールを使わない
- 何を: `backend/src/ml_dashboard/api/jobs.py` と `backend/src/ml_dashboard/core/results.py` が読み込む ML-Found の内部のモジュールをやめ, ML-Found の公開の関数 (`ml_found` と下のパッケージの `__all__` にある名前) だけを使う. 今使っている公開でない名前は, `ml_found.training.optim` の `named_views`, `uses_named_optimizers`, `resolve_optimizer_class`, `resolve_scheduler_class`, `check_optim_config`, `missing_data_size_params`, `try_build_optim`, `ml_found.training.registry` の `check_optim_params`, `check_param_values`, `ml_found.experiment.setup` の `check_name`, `check_resume_path`, `check_trainer_config`, `ml_found.config.loader` の `params_sections`, `parse_overrides`, `ml_found.experiment.results` の `read_samples_index`, `ml_found.rl.bundle` の `file_sha256`. 公開の名前を内部のモジュールから読んでいる所 (`load_config`, `get_device`, `describe_optimizers`, `load_task`, `load_samples`, `read_policy_spec` など) も公開の場所から読む
- なぜ: 画面は自分の組のライブラリの公開の口だけを使う方針 (ML_tester の VISION.md の方針の柱 2) と食い違い, ML-Found の中のモジュールの名前や引数を変えると画面が壊れうる
- 終わりの条件: ML-Found の内部のモジュール (`ml_found.training.optim` など) を名指す読み込みが無く, 起動の前の確かめと結果の表示が今と同じに動く
- つながり: ML-Found の「画面が使う確かめの関数を公開する」

### 学習曲線の横軸を選ぶ
- 何を: 学習曲線の横軸を, エポックのほかに `history.csv` の他の列 (環境のステップ数, 見たサンプルの数など) から選べるようにする
- なぜ: 強化学習や長さの違う学習では, エポックで並べても進み具合を比べにくい
- 終わりの条件: 実験の詳細と比較で横軸の列を選べ, 選んだ列が無い実験はそう出す
- つながり: 無し

### 見本の横に同じエポックの評価
- 何を: 見本のタブで, 選んだエポックの指標の値 (`history.csv`) を見本の横に並べる
- なぜ: 見本の良し悪しと数字を 1 つの画面で見比べるため
- 終わりの条件: エポックを選ぶと, そのエポックの学習用と検証用の指標が見本の横に出る
- つながり: 無し

### 同じ名前の実験を比べるときの見出し
- 何を: 比較の画面で, 選んだ実験が全て同じ名前のとき, 見出し (系列の名前と表の実験の欄) を日付と時刻だけにせず, 実験の名前も出す
- なぜ: 今は名前が 1 種類だと `11-20 19-03-26` のように名前が消え, 図や共有した画面から何の実験かが分からない
- 終わりの条件: 同じ名前の実験だけを比べても, 見出しに実験の名前が出る. 画面のテストがある
- つながり: 無し

### 候補のまとまりの記録の後片付け
- 何を: 終わった候補のまとまりの記録 (置き場の `batches/<ID>/`) を, 画面から消すか, 古いものを自動で消す
- なぜ: 今は記録と候補の config が置き場に残り続ける (小さいので急がない)
- 終わりの条件: 終わったまとまりを消せ, 消しても候補のジョブと実験は残る. テストがある
- つながり: 無し

### 登録で上の階層の関係ない仮想環境を拾わない
- 何を: プロジェクトを登録するときに, プロジェクトのディレクトリから上に向かって仮想環境を探す範囲を, プロジェクトに関係する環境だけに限る
- なぜ: 今は上の階層にある関係ない仮想環境 (ホームの近くの別の作業の環境など) を拾い, 学習をその Python で動かしうる
- 終わりの条件: 上の階層に関係ない仮想環境があっても拾わず, 拾う範囲が DESIGN.md に書いてある. テストがある
- つながり: 無し

### 守り付きの評価の判定と応答の欄
- 何を: 守り付きの評価を数えるかを `kind` が `table` かで決め, 評価のタブの表の決め方と揃える. docs/DESIGN.md に `policy_outcomes` の応答の欄 (`episodes`, `ends`, `guarded`, `guarded_ratio` など) を書く
- なぜ: 今は横軸の無い曲線が評価のタブで表として出るのに, 割合には数えない. 応答の欄の名前が文書に無い
- 終わりの条件: 評価のタブ, 割合, DESIGN.md の 3 つで守り付きの評価の決め方が揃い, 応答の欄が DESIGN.md にある. テストがある
- つながり: ML-Found (守り付きの評価 `evaluate_policy` の列)

### 方策のタブの割合のカードの表示の残り
- 何を: ベストのエポックに `valid/success` が無いときはそう出す. 評価の名前の見出しの段を揃え, 狭い幅で表の見出しを折らず, 件数と説明の間に区切りを入れる
- なぜ: 今はベストに値が無いと何も言わずに行が消え, 幅 390px で「エピソード」が縦に折れる
- 終わりの条件: ベストに値が無いときの表示と, 狭い幅での表の見出しを画面のテストで確かめる
- つながり: 無し

### 方策のタブの図と e2e に守り付きの評価
- 何を: `docs/images/policy.png` を割合のカードが写る形で撮り直し, e2e の fixture (`e2e/fixtures/rl`) に守り付きの評価を足して, 方策のタブの割合を通しで確かめる
- なぜ: 今の図と e2e は割合のカードを写さず, 確かめていない
- 終わりの条件: 図に割合のカードが写り, e2e が割合のカードの値を確かめる
- つながり: 上の「方策のタブの割合のカードの表示の残り」

### 実験の詳細に Scheduler の主な引数を出す
- 何を: backend の `OptimizerInfo` に `scheduler_params` (ML-Found の `run.json` の `optimizers` の項目) を足し, `openapi.json` と `schema.d.ts` を作り直す. 実験の詳細のモデルのタブ (`RunTabs.tsx`. Optimizer が 1 つの実験の欄と, 名前付きの Optimizer の表の両方) に, Scheduler のクラス名の下で引数を表にする. 中に Scheduler を持つもの (`schedulers`) は入れ子で出す. `lr_lambdas` の要素と `scale_fn` は文字か `{function, args, keywords}` の辞書 (`function` も文字か辞書) で, `groups` はパラメータグループごと, `milestones` は並び. `"inf"` などの文字はそのまま出す
- なぜ: 同じ条件で学習し直すときに, 自分で渡した Scheduler の引数を探す手間を無くすため
- 終わりの条件: config から作った Scheduler と自分で渡した Scheduler (SequentialLR の入れ子と partial の関数を含む) の実験で, 画面から引数が読める. 画面のテストがある
- つながり: ML-Found の docs/FORMAT.md の「run.json」

### 入れ方のカードで版が古い時を分けて出す
- 何を: backend の `RequirementCheck` に `version` と `min_version` (ML-Found の `describe_requirements` の確かめの項目) を足し, `openapi.json` と `schema.d.ts` を作り直す. 入れ方のカード (`RequirementCard.tsx`) で, 確かめが通らず `version` がある時は「無い」でなく「版が古い」と, 入っている版と下限を出す
- なぜ: ML-Found が追加の依存の版の下限を確かめるので, 入っているのに版が古い時も今は「無い」と出て, 入れ直す理由を取り違えるため
- 終わりの条件: 下限より古い版が入った環境で, カードに「版が古い」と版と下限が出る. backend と画面のテストがある
- つながり: ML-Found の docs/DESIGN.md の「5. 追加の依存」

## 条件待ち

### 学習の起動に混合精度と勾配の蓄積の欄
- 何を: 学習の起動のフォームに, 混合精度と勾配の蓄積の欄を足す
- 待っているもの: ML-Found の「大きな学習済みのモデルの微調整の補助」(ML-Found の config に勾配の蓄積と混合精度の項目が入ってから)

### 選んだ候補をプロジェクトの既定の定義にする
- 何を: 比べて選んだ実験の定義 (写した `model_spec.yaml`) を, 利用者が確かめてからプロジェクトの `models/` の定義か default の config の `model.spec` に戻す手段を足す (今は選んだ定義が実験の写しに残るだけで, 次の学習の既定にするには利用者が手で写すか config を書き換える)
- 待っているもの: 利用者の判断 (ダッシュボードはプロジェクトのファイルを変えない決まりなので, 決まりを変えるか, 戻すのは別の段階か利用者の手で行うかを確かめる)
