import { describe, expect, it } from 'vitest'

import type { RunParams } from '../api/client'
import { groupByParam, metricValue, sensitivity, varyingParams } from './analysis'

function run(id: string, params: RunParams['params'], best: number | null): RunParams {
  return {
    id,
    name: 'demo',
    started_at: '2026-11-13T01:00:00',
    status: 'completed',
    best: best === null ? null : { monitor: 'valid/acc', mode: 'max', epoch: 1, value: best },
    final_metrics: { 'valid/loss': best === null ? null : 1 - best },
    params,
  }
}

const runs = [
  run('a', { lr: 0.1, opt: 'Adam', seed: 1 }, 0.8),
  run('b', { lr: 0.01, opt: 'Adam', seed: 1 }, 0.9),
  run('c', { lr: 0.01, opt: 'SGD', seed: 1 }, 0.85),
  run('d', { lr: 0.001, opt: 'SGD', seed: 1 }, null),
]

describe('analysis', () => {
  it('値が違う項目だけを, 数値かどうかと一緒に返す', () => {
    expect(varyingParams(runs)).toEqual([
      { key: 'opt', numeric: false, values: 2 },
      { key: 'lr', numeric: true, values: 3 },
    ])
  })

  it('ベストと最後の指標を取り出す', () => {
    expect(metricValue(runs[0]!, 'best')).toBe(0.8)
    expect(metricValue(runs[0]!, 'final:valid/loss')).toBeCloseTo(0.2)
    expect(metricValue(runs[3]!, 'best')).toBeNull()
  })

  it('値ごとの最良値と平均を, 良い順に並べる', () => {
    const rows = groupByParam(runs, 'opt', 'best', true)
    expect(rows.map((row) => [row.value, row.count, row.best])).toEqual([
      ['Adam', 2, 0.9],
      ['SGD', 1, 0.85],
    ])
    expect(rows[0]?.mean).toBeCloseTo(0.85)
  })

  it('結果の動きが大きい項目から並べる', () => {
    const result = sensitivity(runs, varyingParams(runs), 'best', true)
    expect(result.map((item) => item.key)).toEqual(['lr', 'opt'])
    expect(result[0]?.spread).toBeCloseTo(0.1)
  })
})
