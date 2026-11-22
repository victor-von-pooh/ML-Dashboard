import { describe, expect, it } from 'vitest'

import type { History } from '../api/client'
import { compareCharts, type CompareEntry } from './compareCharts'

/** 何エポックかおきに検証する実験の推移 (検証しないエポックの valid/ は空) */
function history(epochs: number, every: number): History {
  return {
    columns: ['epoch', 'train/loss', 'valid/loss', 'valid/fid'],
    rows: Array.from({ length: epochs }, (_, index) => {
      const epoch = index + 1
      const judged = epoch % every === 0 || epoch === epochs
      return {
        epoch,
        'train/loss': 1 / epoch,
        'valid/loss': judged ? 1.1 / epoch : null,
        'valid/fid': judged ? 200 / epoch : null,
      }
    }),
    lr_steps: [],
    named_lr_steps: {},
  }
}

function entry(label: string, every: number, best: CompareEntry['best']): CompareEntry {
  return {
    label,
    color: '--series-1',
    history: history(7, every),
    config: { trainer: { valid_every_n_epochs: every } },
    best,
  }
}

describe('compareCharts', () => {
  it('検証のエポックだけの valid/fid は空のエポックを飛ばしてつなぎ, 監視する向きを出す', () => {
    const fidBest = { monitor: 'valid/fid', mode: 'min' as const, epoch: 7, value: 28 }
    const charts = compareCharts([entry('a', 5, fidBest), entry('b', 1, fidBest)], false)
    // 検証用がある指標の学習用は出さない
    expect(charts.map((chart) => chart.column)).toEqual(['valid/loss', 'valid/fid'])

    const fid = charts.find((chart) => chart.column === 'valid/fid')!
    // 間隔 5 の実験だけを, 検証した 5, 7 エポックの点でつなぐ
    expect(fid.series.map((item) => item.sparse)).toEqual([true, undefined])
    expect(fid.sparse).toEqual(['a'])
    expect(fid.direction).toEqual({ direction: 'min', guessed: false })

    // 監視していない損失は名前から推測した向き
    const loss = charts.find((chart) => chart.column === 'valid/loss')!
    expect(loss.direction).toEqual({ direction: 'min', guessed: true })
  })

  it('指標の無い実験を分け, 学習用は指定した場合だけ出す', () => {
    const other: CompareEntry = {
      ...entry('c', 1, null),
      history: { ...history(3, 1), columns: ['epoch', 'train/loss', 'valid/loss'] },
    }
    const charts = compareCharts([entry('a', 5, null), other], true)
    expect(charts.map((chart) => chart.column)).toEqual(['train/loss', 'valid/loss', 'valid/fid'])
    expect(charts.find((chart) => chart.column === 'valid/fid')!.missing).toEqual(['c'])
  })
})
