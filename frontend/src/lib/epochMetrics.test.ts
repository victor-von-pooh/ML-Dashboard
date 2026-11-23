import { describe, expect, it } from 'vitest'

import type { History } from '../api/client'
import { epochMetrics } from './epochMetrics'

function history(rows: History['rows']): History {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return { columns, rows, lr_steps: [], named_lr_steps: {}, x_columns: [] }
}

const BEST = { monitor: 'valid/acc', mode: 'max' as const, epoch: 2, value: 0.9 }

describe('epochMetrics', () => {
  const data = history([
    { epoch: 1, 'train/loss': 0.9, 'valid/loss': 0.6, 'valid/acc': 0.5, lr: 0.1 },
    { epoch: 2, 'train/loss': 0.5, 'valid/loss': 0.4, 'valid/acc': 0.9, lr: 0.1 },
    { epoch: 3, 'train/loss': 0.3, 'valid/loss': null, 'valid/acc': null, lr: 0.01 },
  ])

  it('指標ごとの行と, 学習用, 検証用, どれでもない列に分ける', () => {
    const table = epochMetrics(data, 2, BEST, 1)!
    expect(table.phases).toEqual(['train', 'valid', 'other'])
    expect(table.rows.map((row) => row.name)).toEqual(['loss', 'acc', 'lr'])
    expect(table.rows[0]!.cells.train!.value).toBe(0.5)
    expect(table.rows[0]!.cells.valid!.value).toBe(0.4)
  })

  it('監視する指標は ML-Found の向き, 他は名前から推測し, 最も良い値に印を付ける', () => {
    const table = epochMetrics(data, 2, BEST, 1)!
    const [loss, acc, lr] = table.rows
    expect(acc!.monitor).toBe(true)
    expect(acc!.direction).toEqual({ direction: 'max', guessed: false })
    expect(acc!.cells.valid!.best).toBe(true)
    expect(loss!.direction).toEqual({ direction: 'min', guessed: true })
    // 学習用の損失はエポック 3 が最も小さい
    expect(loss!.cells.train!.best).toBe(false)
    expect(loss!.cells.valid!.best).toBe(true)
    // 学習率は向きが無いので印を付けない
    expect(lr!.direction).toBeNull()
    expect(lr!.cells.other!.best).toBe(false)
  })

  it('検証の間隔を空けた実験の検証しないエポックは, 検証なしと分ける', () => {
    const spaced = epochMetrics(data, 3, BEST, 2)!
    expect(spaced.rows[0]!.cells.valid).toMatchObject({ value: null, skipped: true })
    expect(spaced).toMatchObject({ skipped: true, missing: false })
    // 間隔が 1 なら, ただ値の無い列
    const plain = epochMetrics(data, 3, BEST, 1)!
    expect(plain.rows[0]!.cells.valid!.skipped).toBe(false)
    expect(plain).toMatchObject({ skipped: false, missing: true })
  })

  it('再開で重なったエポックは最後の行を使い, 記録の無いエポックは null', () => {
    const resumed = history([
      { epoch: 1, 'train/loss': 0.9 },
      { epoch: 1, 'train/loss': 0.7 },
    ])
    expect(epochMetrics(resumed, 1, null, 1)!.rows[0]!.cells.train!.value).toBe(0.7)
    expect(epochMetrics(resumed, 5, null, 1)).toBeNull()
  })
})
