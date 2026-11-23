import { describe, expect, it } from 'vitest'

import {
  axisAt,
  axisLabel,
  axisOptions,
  axisStart,
  columnDirection,
  diffConfigs,
  flattenConfig,
  groupMetrics,
  guessDirection,
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
