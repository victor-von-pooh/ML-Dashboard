# TODO

このリポジトリでまだやっていないことを, 優先度の順に並べる. 終えたら消す.
優先度: 高 = 「強化学習の記録した軌跡を画面で分析する」に要るものか, リポジトリの間の食い違い. 中 = 「生成で画像の他の作るものを画面で通す」に要るもの. 低 = その先. 条件待ち = 実例か利用者の判断が要る.

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

### 検証のエポックだけの指標と FID の重みの注意
- 何を: `valid/fid` のように検証のエポックだけにある小さいほど良い指標を, 値の無い (空の) エポックを飛ばし, 良い向きと一緒に出す. 追加の依存 `fid` を初めて使うときに約 91 MB の重みを取る注意を画面に出す
- なぜ: 検証のエポックだけの指標は空のエポックで線が途切れ, 向きが分からないと良し悪しを読み違える. 重みの取得は利用者に知らせないと, 学習が止まったように見えるため
- 終わりの条件: 学習曲線と比べで検証のエポックだけの指標が空のエポックを飛ばして描かれ, 良い向きが出る. `fid` を使う学習の起動前に重みの取得の注意が出る. 画面のテストがある
- つながり: ML-Quest の「生成の骨組みで FID を数えて監視する」

## 条件待ち

### 学習の起動に混合精度と勾配の蓄積の欄
- 何を: 学習の起動のフォームに, 混合精度と勾配の蓄積の欄を足す
- 待っているもの: ML-Found の「大きな学習済みのモデルの微調整の補助」(ML-Found の config に勾配の蓄積と混合精度の項目が入ってから)
