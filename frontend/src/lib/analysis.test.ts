import { describe, expect, it } from 'vitest'

import type { RunParams } from '../api/client'
import { groupByParam, metricDirection, metricValue, sensitivity, varyingParams } from './analysis'

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
  run('c', { lr: 0.01, opt: 'SGD', seed: 1, extra: true }, 0.85),
  run('d', { lr: 0.001, opt: 'SGD', seed: 1 }, null),
]

describe('analysis', () => {
  it('値が違う項目を, 全ての実験にある項目から返す', () => {
    expect(varyingParams(runs)).toEqual([
      { key: 'lr', numeric: true, values: 3, complete: true, noise: false },
      { key: 'opt', numeric: false, values: 2, complete: true, noise: false },
      { key: 'extra', numeric: false, values: 2, complete: false, noise: false },
    ])
  })

  it('ベストと最後の指標を取り出す', () => {
    expect(metricValue(runs[0]!, 'best')).toBe(0.8)
    expect(metricValue(runs[0]!, 'final:valid/loss')).toBeCloseTo(0.2)
    expect(metricValue(runs[3]!, 'best')).toBeNull()
  })

  it('指標の向きは監視する指標と名前から決める', () => {
    expect(metricDirection(runs, 'best')).toBe('max')
    expect(metricDirection(runs, 'final:valid/acc')).toBe('max')
    expect(metricDirection(runs, 'final:valid/loss')).toBe('min')
    expect(metricDirection(runs, 'final:valid/auc')).toBe('max')
  })

  it('値ごとの最良値と平均を, 良い順に並べる', () => {
    const rows = groupByParam(runs, 'opt', 'best', 'max')
    expect(rows.map((row) => [row.value, row.count, row.best])).toEqual([
      ['Adam', 2, 0.9],
      ['SGD', 1, 0.85],
    ])
    expect(rows[0]?.mean).toBeCloseTo(0.85)

    // 小さいほど良い指標では最小値が最良
    const loss = groupByParam(runs, 'opt', 'final:valid/loss', 'min')
    expect(loss.map((row) => [row.value, row.best])).toEqual([
      ['Adam', expect.closeTo(0.1)],
      ['SGD', expect.closeTo(0.15)],
    ])
  })

  it('項目が無い実験と null と文字列の "null" を分ける', () => {
    const mixed = [
      run('x', { v: null }, 0.5),
      run('y', { v: 'null' }, 0.6),
      run('z', {}, 0.7),
      run('w', { v: 1 }, 0.8),
      run('u', { v: '1' }, 0.9),
    ]
    // 見た目は同じでも型が違う値は別のまとまり (良い順)
    expect(groupByParam(mixed, 'v', 'best', 'max').map((row) => row.value)).toEqual([
      '1',
      '1',
      '(項目なし)',
      'null',
      'null',
    ])
    expect(groupByParam(mixed, 'v', 'best', 'max')).toHaveLength(5)
  })

  it('結果の動きが大きい項目から並べ, 一部の実験にしか無い項目は後ろにする', () => {
    const result = sensitivity(runs, varyingParams(runs), 'best', 'max')
    expect(result.map((item) => item.keys)).toEqual([['lr'], ['opt'], ['extra']])
    expect(result[0]?.spread).toBeCloseTo(0.1)
  })

  it('いつも同時に変えた項目と, 記録の設定をまとめて扱う', () => {
    const together = [
      run('a', { lr: 0.1, wd: 0, 'experiment.device': 'cpu' }, 0.8),
      run('b', { lr: 0.01, wd: 0.1, 'experiment.device': 'auto' }, 0.9),
    ]
    const params = varyingParams(together)
    expect(params.map((item) => [item.key, item.noise])).toEqual([
      ['lr', false],
      ['wd', false],
      ['experiment.device', true],
    ])
    // device も同じ分け方なので, 記録の設定と一緒にまとめる
    expect(sensitivity(together, params, 'best', 'max').map((item) => item.keys)).toEqual([
      ['lr', 'wd', 'experiment.device'],
    ])
  })
})
