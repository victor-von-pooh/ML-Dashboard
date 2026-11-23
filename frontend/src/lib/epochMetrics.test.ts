import { describe, expect, it } from 'vitest'

import type { BestValue, History } from '../api/client'
import { epochMetrics, indexHistory } from './epochMetrics'

function history(rows: History['rows']): History {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return { columns, rows, lr_steps: [], named_lr_steps: {}, x_columns: [] }
}

/** history.csv の行から, 選んだエポックの表を作る */
function table(rows: History['rows'], epoch: number, best: BestValue | null, interval = 1) {
  return epochMetrics(indexHistory(history(rows), best), epoch, best, interval)
}

const BEST: BestValue = { monitor: 'valid/acc', mode: 'max', epoch: 2, value: 0.9 }

const ROWS: History['rows'] = [
  { epoch: 1, 'train/loss': 0.9, 'valid/loss': 0.6, 'valid/acc': 0.5, lr: 0.1 },
  { epoch: 2, 'train/loss': 0.5, 'valid/loss': 0.4, 'valid/acc': 0.9, lr: 0.1 },
  { epoch: 3, 'train/loss': 0.3, 'valid/loss': null, 'valid/acc': null, lr: 0.01 },
]

describe('epochMetrics', () => {
  it('指標ごとの行と, 学習用, 検証用, その他の値の列に分ける', () => {
    const result = table(ROWS, 2, BEST)!
    expect(result.phases).toEqual(['train', 'valid', 'other'])
    expect(result.rows.map((row) => row.name)).toEqual(['loss', 'acc', 'lr'])
    expect(result.rows[0]!.cells.train!.value).toBe(0.5)
    expect(result.rows[0]!.cells.valid!.value).toBe(0.4)
  })

  it('監視する指標は run.json のベストのエポックだけに印を付け, 他は推測の最良に印を付ける', () => {
    const result = table(ROWS, 2, BEST)!
    const [loss, acc, lr] = result.rows
    expect(acc!.monitor).toBe(true)
    expect(acc!.direction).toEqual({ direction: 'max', guessed: false })
    expect(acc!.cells.valid!.mark).toBe('best')
    expect(loss!.direction).toEqual({ direction: 'min', guessed: true })
    // 学習用の損失はエポック 3 が最も小さい
    expect(loss!.cells.train!.mark).toBeNull()
    expect(loss!.cells.valid!.mark).toBe('guessed')
    expect(result.guessed).toBe(true)
    // 学習率は向きが無いので印を付けない
    expect(lr!.direction).toBeNull()
    expect(lr!.cells.other!.mark).toBeNull()
  })

  it('監視する指標の値が最も良くても, モデルに選ばれたエポックでなければ印を付けない', () => {
    // Early Stopping の前などで, ベストのエポックの後により良い値が記録された場合
    const best: BestValue = { ...BEST, epoch: 1 }
    expect(table(ROWS, 2, best)!.rows[1]!.cells.valid!.mark).toBeNull()
    expect(table(ROWS, 1, best)!.rows[1]!.cells.valid!.mark).toBe('best')
  })

  it('検証の間隔を空けた実験の検証しないエポックは, 検証なしと分ける', () => {
    const spaced = table(ROWS, 3, BEST, 2)!
    expect(spaced.rows[0]!.cells.valid).toMatchObject({ value: null, skipped: true })
    expect(spaced).toMatchObject({ skipped: true, missing: false })
    // 間隔が 1 なら, ただ値の無い列
    const plain = table(ROWS, 3, BEST, 1)!
    expect(plain.rows[0]!.cells.valid!.skipped).toBe(false)
    expect(plain).toMatchObject({ skipped: false, missing: true })
  })

  it('再開で重なったエポックは最後の行を使い, 最良も最後の行だけで求める', () => {
    const resumed: History['rows'] = [
      { epoch: 1, 'train/loss': 0.1 },
      { epoch: 1, 'train/loss': 0.7 },
      { epoch: 2, 'train/loss': 0.5 },
    ]
    // 使われなかった 0.1 は数えず, エポック 2 の 0.5 が最良
    expect(table(resumed, 1, null)!.rows[0]!.cells.train).toMatchObject({ value: 0.7, mark: null })
    expect(table(resumed, 2, null)!.rows[0]!.cells.train!.mark).toBe('guessed')
    expect(table(resumed, 5, null)).toBeNull()
  })
})
