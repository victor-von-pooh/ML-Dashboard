import { describe, expect, it } from 'vitest'

import type { History } from '../api/client'
import { compareCharts, withoutAxis, type CompareEntry } from './compareCharts'

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
    x_columns: ['epoch'],
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

  it('横軸に選んだ列を使える実験だけを描き, 使えない実験を分ける', () => {
    // a は環境のステップ数を記録した強化学習, c は記録していない実験
    const base = history(3, 1)
    const steps: CompareEntry = {
      ...entry('a', 1, null),
      history: {
        ...base,
        columns: [...base.columns, 'env_steps'],
        rows: base.rows.map((row) => ({ ...row, env_steps: Number(row.epoch) * 100 })),
        x_columns: ['epoch', 'env_steps'],
      },
    }
    const other = entry('c', 1, null)
    const charts = compareCharts([steps, other], false, 'env_steps')
    // 横軸の列そのもののグラフは出さない
    expect(charts.map((chart) => chart.column)).toEqual(['valid/loss', 'valid/fid'])
    const loss = charts.find((chart) => chart.column === 'valid/loss')!
    expect(loss.series.map((item) => item.name)).toEqual(['a'])
    expect(loss.series[0]!.points.map(([x]) => x)).toEqual([100, 200, 300])
    expect(loss.missing).toEqual([])
    expect(withoutAxis([steps, other], 'env_steps')).toEqual(['c'])
    expect(withoutAxis([steps, other], 'epoch')).toEqual([])

    // エポックの横軸では, 記録した列もグラフにする
    const byEpoch = compareCharts([steps, other], false)
    expect(byEpoch.map((chart) => chart.column)).toContain('env_steps')
  })
})
