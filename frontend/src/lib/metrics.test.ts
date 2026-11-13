import { describe, expect, it } from 'vitest'

import {
  diffConfigs,
  flattenConfig,
  groupMetrics,
  lrStepPoints,
  summarizeDiff,
  toPoints,
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
    const history = { columns: ['loss'], rows: [{ loss: 1 }, { loss: null }], lr_steps: [] }
    expect(toPoints(history, 'loss')).toEqual([
      [1, 1],
      [2, null],
    ])
  })
})

describe('lrStepPoints', () => {
  it('エポックの中の更新を等間隔に並べ, 最初の更新をエポックの位置にする', () => {
    const steps = [
      { step: 1, epoch: 1, lr: 0.1 },
      { step: 2, epoch: 1, lr: 0.2 },
      { step: 3, epoch: 1, lr: 0.3 },
      { step: 4, epoch: 1, lr: 0.4 },
      { step: 5, epoch: 2, lr: 0.5 },
      { step: 6, epoch: 2, lr: null },
    ]
    expect(lrStepPoints(steps)).toEqual([
      [1, 0.1],
      [1.25, 0.2],
      [1.5, 0.3],
      [1.75, 0.4],
      [2, 0.5],
      [2.25, null],
    ])
  })

  it('間引いた記録でも, 次のエポックの最初との差で位置を決める', () => {
    const steps = [
      { step: 1, epoch: 1, lr: 1 },
      { step: 51, epoch: 1, lr: 0.5 },
      { step: 101, epoch: 2, lr: 0.25 },
      { step: 199, epoch: 2, lr: 0.1 },
    ]
    expect(lrStepPoints(steps).map(([x]) => x)).toEqual([1, 1.5, 2, 2.98])
    expect(lrStepPoints([])).toEqual([])
  })
})
