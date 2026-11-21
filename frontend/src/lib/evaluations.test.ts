import { describe, expect, it } from 'vitest'

import type { EvaluationValue, RunEvaluations } from '../api/client'
import {
  NO_COLUMNS,
  chooseColumns,
  collectColumns,
  diffTone,
  initialDesc,
  matchesValueFilters,
  parseValueFilters,
} from './evaluations'

function value(patch: Partial<EvaluationValue>): EvaluationValue {
  return {
    evaluation: 'baseline_test',
    column: 'mae',
    value: 0.4,
    guard: false,
    diff: false,
    better: 'lower',
    baseline: '今のやり方',
    ...patch,
  }
}

const first: RunEvaluations = {
  values: [
    value({}),
    value({ column: 'mae_diff', value: -0.1, diff: true }),
    value({ evaluation: 'other', column: 'score', value: 3, better: null }),
  ],
  guard: { state: 'kept', dropped: [], unknown: [] },
}
const second: RunEvaluations = {
  values: [
    value({ evaluation: 'guard_test', column: 'acc', value: 0.9, guard: true, better: 'higher' }),
    value({ value: 0.6 }),
    value({ column: 'mae_diff', value: 0.1, diff: true }),
  ],
  guard: { state: 'dropped', dropped: ['guard_test: acc (差 -0.01)'], unknown: [] },
}

describe('collectColumns', () => {
  it('守る指標の表を先に, 評価の名前, 列の順で全ての実験の列を集める', () => {
    const columns = collectColumns([first, undefined, second])
    expect(columns.map((column) => column.key)).toEqual([
      'guard_test:acc',
      'baseline_test:mae',
      'baseline_test:mae_diff',
      'other:score',
    ])
    expect(columns[0]!.guard).toBe(true)
  })

  it('実験で向きが違う列は向きを分からないとする', () => {
    const flipped: RunEvaluations = { values: [value({ better: 'higher' })] }
    const [column] = collectColumns([first, flipped])
    expect(column!.better).toBeNull()
  })
})

describe('chooseColumns', () => {
  const columns = collectColumns([first, second])
  it('選んだ列が無ければ先頭の列を上限まで', () => {
    expect(chooseColumns(columns, [], 2).map((column) => column.key)).toEqual([
      'guard_test:acc',
      'baseline_test:mae',
    ])
  })
  it('選んだ列のうち今ある列だけを, 重複を除いて選んだ順に', () => {
    const chosen = chooseColumns(columns, ['other:score', 'gone:x', 'other:score'], 3)
    expect(chosen.map((column) => column.key)).toEqual(['other:score'])
  })
  it('並べない印だけなら並べず, 選んだ列が全て無くなったら先頭の列', () => {
    expect(chooseColumns(columns, [NO_COLUMNS], 3)).toEqual([])
    expect(chooseColumns(columns, ['gone:x'], 1).map((column) => column.key)).toEqual([
      'guard_test:acc',
    ])
  })
})

describe('diffTone', () => {
  it('差の列を向きに合わせて良し悪しに分ける', () => {
    expect(diffTone(value({ diff: true, value: -0.1 }))).toBe('good')
    expect(diffTone(value({ diff: true, value: 0.1 }))).toBe('bad')
    expect(diffTone(value({ diff: true, value: 0.1, better: 'higher' }))).toBe('good')
    expect(diffTone(value({ diff: true, value: 0 }))).toBe('same')
  })
  it('計算の誤差の幅の差は同じとする', () => {
    expect(diffTone(value({ diff: true, value: 1e-17 }))).toBe('same')
    expect(diffTone(value({ diff: true, value: -1e-17 }))).toBe('same')
    expect(diffTone(value({ diff: true, value: 1e-6 }))).toBe('bad')
  })
  it('向きの分からない差, 差でない値, 値の無い差は色を付けない', () => {
    expect(diffTone(value({ diff: true, value: 0.1, better: null }))).toBeNull()
    expect(diffTone(value({ value: 0.1 }))).toBeNull()
    expect(diffTone(value({ diff: true, value: null }))).toBeNull()
  })
})

describe('initialDesc', () => {
  it('小さいほど良い列は小さい順, 他は大きい順から', () => {
    const columns = collectColumns([first])
    expect(initialDesc(columns[0])).toBe(false)
    expect(initialDesc(columns[2])).toBe(true)
  })
})

describe('parseValueFilters', () => {
  const columns = collectColumns([first, second])
  it('列と比べ方と数の語を値の絞り込みにし, 他は文字の語にする', () => {
    const { filters, words } = parseValueFilters('Adam mae<0.5 guard_test:ACC>=0.8 lr=0.1', columns)
    expect(filters).toEqual([
      { key: 'baseline_test:mae', op: '<', threshold: 0.5 },
      { key: 'guard_test:acc', op: '>=', threshold: 0.8 },
    ])
    expect(words).toEqual(['adam', 'lr=0.1'])
  })
  it('列に当たらない語は文字の語のまま', () => {
    const { filters, words, unresolved } = parseValueFilters('missing<1 mae<abc', columns)
    expect(filters).toEqual([])
    expect(words).toEqual(['missing<1', 'mae<abc'])
    expect(unresolved).toEqual(['missing<1'])
  })
  it('値で絞り込み, 値の無い実験は外す', () => {
    const { filters } = parseValueFilters('mae_diff<0', columns)
    expect(matchesValueFilters(first, filters)).toBe(true)
    expect(matchesValueFilters(second, filters)).toBe(false)
    expect(matchesValueFilters(undefined, filters)).toBe(false)
    expect(matchesValueFilters(undefined, [])).toBe(true)
  })
})
