import { describe, expect, it } from 'vitest'

import {
  axisAt,
  axisLabel,
  axisOptions,
  axisStart,
  columnDirection,
  curveColumns,
  diffConfigs,
  flattenConfig,
  groupMetrics,
  guessDirection,
  evaluationTitle,
  isAnomalyEvaluation,
  isDemandEvaluation,
  isPriceEvaluation,
  isUpliftEvaluation,
  metricLabel,
  metricNote,
  hasAxis,
  identicalSeries,
  integerAxis,
  judgedOnly,
  pointStyle,
  summarizeDiff,
  toPoints,
  validInterval,
} from './metrics'

describe('groupMetrics', () => {
  it('学習用と検証用を同じ指標にまとめ, 損失を先頭, 学習率を末尾にする', () => {
    const groups = groupMetrics([
      'epoch',
      'train/acc',
      'train/loss',
      'valid/acc',
      'valid/loss',
      'lr',
    ])
    expect(groups).toEqual([
      { name: 'loss', keys: ['train/loss', 'valid/loss'] },
      { name: 'acc', keys: ['train/acc', 'valid/acc'] },
      { name: 'lr', keys: ['lr'] },
    ])
  })

  it('train と valid 以外の接頭辞はそのままの名前で扱う', () => {
    expect(groupMetrics(['epoch', 'grad/norm', 'valid/loss_random'])).toEqual([
      { name: 'grad/norm', keys: ['grad/norm'] },
      { name: 'loss_random', keys: ['valid/loss_random'] },
    ])
  })
})

describe('groupMetrics の train_eval', () => {
  it('学習用データを評価し直した値も同じ指標にまとめる', () => {
    expect(groupMetrics(['epoch', 'train/loss', 'train_eval/loss', 'valid/loss'])).toEqual([
      { name: 'loss', keys: ['train/loss', 'train_eval/loss', 'valid/loss'] },
    ])
  })
})

describe('flattenConfig', () => {
  it('入れ子の辞書を点区切りの項目にし, 配列と空の辞書は値として残す', () => {
    expect(
      flattenConfig({ trainer: { epochs: 10, early: { use: true } }, ms: [1, 2], params: {} }),
    ).toEqual({ 'trainer.epochs': 10, 'trainer.early.use': true, ms: [1, 2], params: {} })
  })
})

describe('diffConfigs', () => {
  it('値が違う項目と, 片方にしか無い項目を返す', () => {
    const keys = diffConfigs([
      { optimizer: { lr: 0.1, name: 'Adam' }, seed: 1 },
      { optimizer: { lr: 0.01, name: 'Adam' }, seed: 1, extra: true },
    ])
    expect(keys).toEqual(['extra', 'optimizer.lr'])
  })
})

describe('summarizeDiff', () => {
  it('diff.yaml の形を「項目=値」にする', () => {
    expect(
      summarizeDiff({
        'optimizer.lr': { default: 0.01, experiment: 0.001 },
        'experiment.device': { default: 'auto', experiment: 'cpu' },
      }),
    ).toEqual(['optimizer.lr=0.001', 'experiment.device=cpu'])
  })
})

describe('toPoints', () => {
  it('エポックの列が無い場合は行の番号を使う', () => {
    const history = {
      columns: ['loss'],
      rows: [{ loss: 1 }, { loss: null }],
      lr_steps: [],
      named_lr_steps: {},
      x_columns: [],
    }
    expect(toPoints(history, 'loss')).toEqual([
      [1, 1],
      [2, null],
    ])
  })
})

describe('横軸の列', () => {
  // 強化学習のエポックごとの環境のステップ数 (step の extra の env_steps)
  const rl = {
    columns: ['epoch', 'train/reward', 'env_steps'],
    rows: [
      { epoch: 1, 'train/reward': 10, env_steps: 200 },
      { epoch: 2, 'train/reward': null, env_steps: null },
      { epoch: 3, 'train/reward': 30, env_steps: 700 },
    ],
    lr_steps: [],
    named_lr_steps: {},
    x_columns: ['epoch', 'env_steps'],
  }
  const plain = { ...rl, columns: ['epoch', 'train/reward'], x_columns: ['epoch'] }

  it('選んだ列を横軸にし, その列の値の無い行を除く', () => {
    expect(toPoints(rl, 'train/reward', 'env_steps')).toEqual([
      [200, 10],
      [700, 30],
    ])
    expect(toPoints(rl, 'train/reward')).toEqual([
      [1, 10],
      [2, null],
      [3, 30],
    ])
  })

  it('候補はエポックを先頭に重ねずに並べ, 候補に無い実験は横軸に使えない', () => {
    expect(axisOptions([plain, rl, rl])).toEqual(['epoch', 'env_steps'])
    expect(axisOptions([{ ...plain, x_columns: [] }])).toEqual(['epoch'])
    expect(hasAxis(rl, 'env_steps')).toBe(true)
    expect(hasAxis(plain, 'env_steps')).toBe(false)
    expect(hasAxis(plain, 'epoch')).toBe(true)
  })

  it('エポックの位置を横軸の上の位置にし, 値が整数かを見る', () => {
    expect(axisAt(rl, 'env_steps', 3)).toBe(700)
    expect(axisAt(rl, 'env_steps', 2)).toBeNull()
    expect(axisAt(rl, 'env_steps', 9)).toBeNull()
    expect(axisAt(rl, 'epoch', 9)).toBe(9)
    // 再開で同じエポックが重なる場合は最後の行
    const resumed = { ...rl, rows: [...rl.rows, { epoch: 3, env_steps: 800 }] }
    expect(axisAt(resumed, 'env_steps', 3)).toBe(800)
    expect(axisLabel('epoch')).toBe('エポック')
    expect(axisLabel('env_steps')).toBe('env_steps')
    expect(integerAxis([rl], 'env_steps')).toBe(true)
    const halves = { ...rl, rows: [{ epoch: 1, env_steps: 0.5 }] }
    expect(integerAxis([rl, halves], 'env_steps')).toBe(false)
    // 数え上げる列は 0 から描き, 負の値のある列とエポックは最初の値から
    expect(axisStart([rl], 'env_steps')).toBe(0)
    expect(axisStart([{ ...rl, rows: [{ epoch: 1, env_steps: -5 }] }], 'env_steps')).toBeUndefined()
    expect(axisStart([rl], 'epoch')).toBeUndefined()
  })
})

describe('identicalSeries', () => {
  it('全ての点が同じ値の系列を, 名前の組にまとめる', () => {
    const a: [number, number | null][] = [
      [1, 0.5],
      [2, 0.25],
    ]
    expect(
      identicalSeries([
        { name: 'a', points: a },
        { name: 'b', points: [...a] },
        {
          name: 'c',
          points: [
            [1, 0.5],
            [2, 0.3],
          ],
        },
        { name: 'd', points: [[1, null]] },
        { name: 'e', points: [[1, null]] },
        { name: 'f', points: [[1, 0.5]] },
        {
          name: 'g',
          points: [
            [1, null],
            [2, 0.25],
          ],
        },
      ]),
    ).toEqual([['a', 'b']])
  })
})

describe('pointStyle', () => {
  it('毎エポックの系列は孤立した点が無く, 値の無い点で途切れさせる', () => {
    const style = pointStyle([
      [1, 0.9],
      [2, 0.5],
      [3, 0.3],
    ])
    expect([...style.isolated]).toEqual([])
    expect(style.sparse).toBe(false)
  })

  it('何エポックかおきに記録する系列は, 全ての点を孤立した点としてつなぐ', () => {
    const points: [number, number | null][] = Array.from({ length: 30 }, (_, index) => {
      const epoch = index + 1
      return [epoch, epoch % 10 === 0 ? 80 - epoch : null]
    })
    const style = pointStyle(points)
    expect([...style.isolated]).toEqual([9, 19, 29])
    expect(style.sparse).toBe(true)
  })

  it('途中の欠けで孤立した点だけに記号を付け, 線はつながない', () => {
    const style = pointStyle([
      [1, 0.9],
      [2, 0.8],
      [3, null],
      [4, 0.6],
      [5, null],
    ])
    expect([...style.isolated]).toEqual([3])
    expect(style.sparse).toBe(false)
  })

  it('値のある点が 1 つだけの系列は記号で描き, つなぐ相手は無い', () => {
    const style = pointStyle([
      [1, null],
      [2, 0.5],
    ])
    expect([...style.isolated]).toEqual([1])
    expect(style.sparse).toBe(false)
  })
})

describe('検証の間隔', () => {
  it('config の trainer.valid_every_n_epochs を読み, 無いか読めなければ 1', () => {
    expect(validInterval({ trainer: { valid_every_n_epochs: 3 } })).toBe(3)
    expect(validInterval({ trainer: { epochs: 7 } })).toBe(1)
    expect(validInterval({ trainer: { valid_every_n_epochs: '3' } })).toBe(1)
    expect(validInterval({ trainer: [1, 2] })).toBe(1)
    expect(validInterval(null)).toBe(1)
  })

  it('間隔が 2 以上の実験の valid/ と train_eval/ だけを, 検証したエポックだけの指標とする', () => {
    expect(judgedOnly('valid/loss', 3)).toBe(true)
    expect(judgedOnly('train_eval/acc', 2)).toBe(true)
    expect(judgedOnly('train/loss', 3)).toBe(false)
    expect(judgedOnly('lr', 3)).toBe(false)
    expect(judgedOnly('valid/loss', 1)).toBe(false)
  })

  it('毎エポック検証する実験の途中の欠け (nan) は, 点の並びからは何エポックかおきとしない', () => {
    // 間隔 3 で 7 エポック (3, 6, 7) と同じ並びに見えても, 推測ではつながない
    const style = pointStyle([
      [1, 0.9],
      [2, null],
      [3, 0.7],
      [4, 0.6],
    ])
    expect(style.sparse).toBe(false)
  })
})

describe('指標の良い向き', () => {
  it('名前から推測し, FID と Chamfer 距離は小さいほど良い', () => {
    expect(guessDirection('valid/fid')).toBe('min')
    expect(guessDirection('valid/chamfer')).toBe('min')
    expect(guessDirection('valid/loss')).toBe('min')
    expect(guessDirection('valid/acc')).toBe('max')
    expect(guessDirection('valid/reward')).toBeNull()
  })

  it('fid と chamfer は語として現れる場合だけ小さいほど良い', () => {
    expect(guessDirection('fid')).toBe('min')
    expect(guessDirection('valid/fid_inception')).toBe('min')
    expect(guessDirection('valid/chamfer_l2')).toBe('min')
    // 部分一致の名前 (大きいほど良い指標) は小さいほど良いにしない
    expect(guessDirection('valid/confidence')).not.toBe('min')
    expect(guessDirection('valid/fidelity')).not.toBe('min')
    expect(guessDirection('valid/chamfered')).not.toBe('min')
  })

  it('表を作る課題の列ごとの分布の近さ (column_distance) は小さいほど良い', () => {
    expect(guessDirection('valid/column_distance')).toBe('min')
    expect(guessDirection('distance')).toBe('min')
    // 監視する指標なら ML-Found の向き, 監視が損失の実験でも名前から小さいほど良い
    expect(
      columnDirection('valid/column_distance', [{ monitor: 'valid/column_distance', mode: 'min' }]),
    ).toEqual({ direction: 'min', guessed: false })
    expect(
      columnDirection('valid/column_distance', [{ monitor: 'valid/loss', mode: 'min' }]),
    ).toEqual({ direction: 'min', guessed: true })
    // 部分一致の名前は小さいほど良いにしない
    expect(guessDirection('valid/distances_kept')).toBeNull()
  })

  it('並べる課題の Recall@K と NDCG は大きいほど良い', () => {
    expect(guessDirection('valid/recall_at_k')).toBe('max')
    expect(guessDirection('valid/ndcg')).toBe('max')
    expect(guessDirection('valid/mrr')).toBe('max')
    // 監視が損失の実験でも名前から大きいほど良い (推測)
    for (const key of ['valid/recall_at_k', 'valid/ndcg']) {
      expect(columnDirection(key, [{ monitor: 'valid/loss', mode: 'min' }])).toEqual({
        direction: 'max',
        guessed: true,
      })
    }
  })

  it('群分けのシルエット係数と調整ランド指数は大きいほど良い', () => {
    expect(guessDirection('valid/silhouette')).toBe('max')
    expect(guessDirection('ari')).toBe('max')
    expect(guessDirection('ari_min_diff')).toBe('max')
    // ari は語として現れる場合だけ (variance などを含めない)
    expect(guessDirection('valid/variance')).toBeNull()
    expect(columnDirection('valid/silhouette', [{ monitor: 'valid/loss', mode: 'min' }])).toEqual({
      direction: 'max',
      guessed: true,
    })
  })

  it('群分けの指標と列に日本語の説明を添える', () => {
    expect(metricNote('valid/silhouette')).toBe('シルエット係数 (群のまとまり. -1 から 1)')
    expect(metricNote('ari_min')).toBe('調整ランド指数の最小 (作り直した群との一致の最も低い値)')
    expect(metricNote('ari_diff')).toBe('調整ランド指数の平均 (比べる相手との差)')
    expect(metricNote('silhouette_baseline')).toBe('シルエット係数 (比べる相手の値)')
    // 評価に固有の列は, その評価の名前を渡したときだけ
    expect(metricNote('k', 'group_stability')).toBe('群の数')
    expect(metricNote('stability', 'group_summary')).toMatch(/^安定性 \(/)
    // 表の見出しは日本語の名前を主にし, 説明は別に持つ
    expect(metricLabel('rows', 'group_summary')).toEqual({ label: '行の数', note: null })
    expect(metricLabel('group', 'group_summary')).toEqual({
      label: '群',
      note: '群の番号. 全体は全ての行',
    })
    expect(metricLabel('ari_diff')).toEqual({
      label: '調整ランド指数の平均 (比べる相手との差)',
      note: null,
    })
    expect(metricNote('k', 'ranking_test')).toBeNull()
    expect(metricNote('rows')).toBeNull()
    expect(metricNote('valid/loss')).toBeNull()
    expect(metricNote('constructor')).toBeNull()
    expect(metricNote('k', 'constructor')).toBeNull()
  })

  it('異常の検知の評価は, 名前の形 (anomaly_<分割> など) で列の日本語の名前を引く', () => {
    expect(metricLabel('k', 'anomaly_test')?.label).toBe('上位の件数 K')
    expect(metricLabel('anomalies', 'anomaly_unlabeled')?.label).toBe('異常の行の数')
    expect(metricNote('precision_at_k', 'anomaly_valid')).toMatch(/異常の割合が小さいと低く出る/)
    expect(metricLabel('average_precision', 'anomaly_test')?.label).toBe('PR-AUC')
    // 度合いの分布と上位の行の要約の score は異常の度合い
    expect(metricLabel('quantile', 'anomaly_scores_test')?.label).toBe('分位')
    expect(metricLabel('score', 'anomaly_scores_test')?.label).toBe('異常の度合い')
    expect(metricLabel('column', 'anomaly_top_unlabeled')?.label).toBe('最も外れた列')
    expect(metricLabel('column_share', 'anomaly_top_test')?.label).toBe('その列が占める割合')
    // anomaly_scores_test を anomaly_<分割> と取り違えない
    expect(metricLabel('k', 'anomaly_scores_test')).toBeNull()
    expect(metricLabel('score', 'anomaly_test')).toBeNull()
    // 分割の後ろに _ が続く名前と, 別の頭の名前は引かない
    expect(metricLabel('k', 'anomaly_test_extra')).toBeNull()
    expect(metricLabel('k', 'my_anomaly_test')).toBeNull()
    // 学習曲線の指標は評価の名前なしでも引く
    expect(metricLabel('valid/precision_at_k')?.label).toBe('上位 K 件の適合率')
    expect(evaluationTitle('anomaly_test')).toBe('上位 K 件の適合率と PR-AUC')
    expect(evaluationTitle('anomaly_scores_unlabeled')).toBe('度合いの分布')
    expect(evaluationTitle('anomaly_top_valid')).toBe('上位の行の要約')
    expect(evaluationTitle('group_stability')).toBeNull()
    expect(isAnomalyEvaluation('anomaly_valid')).toBe(true)
    expect(isAnomalyEvaluation('baseline_test')).toBe(false)
  })

  it('異常の検知の指標は名前から大きいほど良いと推測する', () => {
    expect(guessDirection('valid/precision_at_k')).toBe('max')
    expect(guessDirection('valid/average_precision')).toBe('max')
  })

  it('効果を見積もるの評価は, 名前の形 (uplift_<分割>, qini_curve_<分割>) で列の日本語の名前を引く', () => {
    expect(metricLabel('treated', 'uplift_test')?.label).toBe('処置の群の行の数')
    expect(metricLabel('control', 'uplift_valid')?.label).toBe('対照の群の行の数')
    expect(metricLabel('k', 'uplift_test')?.label).toBe('上位の割合 K')
    expect(metricNote('qini', 'uplift_test')).toMatch(/^Qini の係数 \(.*0 はでたらめに配るのと同じ/)
    expect(metricLabel('uplift_at_k', 'uplift_test')?.label).toBe('上位 K 割の効果の差')
    expect(metricLabel('effect', 'uplift_test')?.label).toBe('全体の効果の差')
    // Qini の曲線の qini は係数でなく曲線の値
    expect(metricLabel('qini', 'qini_curve_test')?.label).toBe('Qini の値')
    expect(metricLabel('random', 'qini_curve_test')?.label).toBe('でたらめに配る線')
    expect(metricLabel('fraction', 'qini_curve_valid')?.label).toBe('上位の行の割合')
    // qini_curve_test を uplift_<分割> と, uplift_test_extra を uplift_<分割> と取り違えない
    expect(metricLabel('treated', 'qini_curve_test')).toBeNull()
    expect(metricLabel('treated', 'uplift_test_extra')).toBeNull()
    // 学習曲線の指標は評価の名前なしでも引く
    expect(metricLabel('valid/qini')?.label).toBe('Qini の係数')
    expect(evaluationTitle('uplift_test')).toBe('Qini の係数と上位 K 割の効果の差')
    expect(evaluationTitle('qini_curve_valid')).toBe('Qini の曲線')
    expect(isUpliftEvaluation('qini_curve_test')).toBe(true)
    expect(isUpliftEvaluation('anomaly_test')).toBe(false)
    expect(isAnomalyEvaluation('uplift_test')).toBe(false)
    // 曲線に描く列 (Qini の曲線は上位の行の数を描かない)
    expect(curveColumns('qini_curve_test')).toEqual(['qini', 'random'])
    expect(curveColumns('anomaly_scores_test')).toBeNull()
  })

  it('値段を変える判断の評価は, 名前の形 (price_<分割>) で列の日本語の名前を引く', () => {
    expect(metricLabel('mae', 'price_test')?.label).toBe('売れた数の平均絶対誤差')
    expect(metricLabel('rmse', 'price_valid')?.label).toBe('売れた数の二乗平均平方根誤差')
    expect(metricNote('elasticity', 'price_test')).toMatch(/1 % 上げたとき.*良し悪しの向きは無い/)
    expect(metricLabel('profit_gain', 'price_test')?.label).toBe('見込みの利益の差')
    expect(metricLabel('profit_ratio', 'price_test')?.label).toBe('見込みの利益の比')
    expect(metricLabel('max_change', 'price_test')?.label).toBe('値段を変える幅の上限')
    expect(metricLabel('products', 'price_test')?.label).toBe('商品の数')
    // price_items_test のような形の違う評価と, 学習曲線の valid/mae は引かない
    expect(metricLabel('profit', 'price_items_test')).toBeNull()
    expect(metricLabel('valid/mae')).toBeNull()
    expect(metricLabel('mae', 'uplift_test')).toBeNull()
    expect(evaluationTitle('price_test')).toBe('売れた数の予測の誤差と見込みの利益')
    expect(isPriceEvaluation('price_valid')).toBe(true)
    expect(isPriceEvaluation('uplift_test')).toBe(false)
    expect(isUpliftEvaluation('price_test')).toBe(false)
    // 監視する指標の valid/mae は ML-Found の向き, 監視しなくても名前から小さいほど良い
    expect(columnDirection('valid/mae', [{ monitor: 'valid/mae', mode: 'min' }])).toEqual({
      direction: 'min',
      guessed: false,
    })
    expect(guessDirection('valid/mae')).toBe('min')
  })

  it('時間をまたぐ量の判断の評価は, 名前の形 (demand_<分割>, demand_levels_<分割>) で列の日本語の名前を引く', () => {
    expect(metricLabel('mae', 'demand_test')?.label).toBe('需要の平均絶対誤差')
    expect(metricLabel('pinball_loss', 'demand_valid')?.label).toBe('分位点の損失の平均')
    expect(metricLabel('order_cost', 'demand_test')?.label).toBe('選んだ発注の数での損')
    expect(metricLabel('order_cost_saving', 'demand_test')?.label).toBe('発注の数の損の差')
    expect(metricNote('order_cost_ratio', 'demand_test')).toMatch(/100 % は変わらない/)
    expect(metricLabel('capped', 'demand_test')?.label).toBe('上限に当たった行の数')
    expect(metricLabel('loss', 'demand_levels_test')?.label).toBe('分位点の損失')
    // demand_levels_test は demand_<分割> の列の名前を引かない
    expect(metricLabel('mae', 'demand_levels_test')).toBeNull()
    expect(metricLabel('mae', 'demand_items_test')).toBeNull()
    expect(evaluationTitle('demand_test')).toBe('需要の予測の誤差と発注の数の損')
    expect(evaluationTitle('demand_levels_valid')).toBe('水準ごとの分位点の損失')
    expect(isDemandEvaluation('demand_levels_test')).toBe(true)
    expect(isDemandEvaluation('price_test')).toBe(false)
    expect(isPriceEvaluation('demand_test')).toBe(false)
    // 学習曲線の valid/pinball_loss は名前から小さいほど良い
    expect(guessDirection('valid/pinball_loss')).toBe('min')
  })

  it('効果を見積もるの Qini の係数は名前から大きいほど良いと推測する', () => {
    expect(guessDirection('valid/qini')).toBe('max')
    expect(columnDirection('valid/qini', [{ monitor: 'valid/qini', mode: 'max' }])).toEqual({
      direction: 'max',
      guessed: false,
    })
  })

  it('監視する指標は ML-Found の向き, 他は推測, 学習率と推測できない列は null', () => {
    const best = { monitor: 'valid/fid', mode: 'min' as const }
    expect(columnDirection('valid/fid', [best])).toEqual({ direction: 'min', guessed: false })
    expect(columnDirection('valid/reward', [{ monitor: 'valid/reward', mode: 'max' }])).toEqual({
      direction: 'max',
      guessed: false,
    })
    expect(columnDirection('valid/loss', [best])).toEqual({ direction: 'min', guessed: true })
    expect(columnDirection('lr', [best])).toBeNull()
    expect(columnDirection('lr_generator')).toBeNull()
    expect(columnDirection('valid/reward')).toBeNull()
  })

  it('比べる実験で監視する指標の向きが食い違う場合は推測に任せる', () => {
    const bests = [
      { monitor: 'valid/score', mode: 'min' as const },
      { monitor: 'valid/score', mode: 'max' as const },
      null,
    ]
    expect(columnDirection('valid/score', bests)).toEqual({ direction: 'max', guessed: true })
  })
})
