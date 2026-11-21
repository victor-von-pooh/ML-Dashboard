import { describe, expect, it } from 'vitest'

import type { RunModel } from '../api/client'
import { groupByModel, modelKey, modelLabels } from './modelGroups'

function model(name: string, path: string, sha256: string | null, known = true): RunModel {
  return { name, path, sha256, origin_known: known }
}

describe('モデルの定義の組', () => {
  it('組の鍵は元の場所と sha256 で, 名前は表示だけ', () => {
    const a = model('net', 'models/net.yaml', 'a'.repeat(64))
    const b = model('net', 'models/net.yml', 'a'.repeat(64))
    expect(modelKey(a)).not.toBe(modelKey(b))
    expect(modelKey(null)).toBe('none')
    // 「写し」という名前の定義と, 元の分からない写しは別の組
    expect(modelKey(model('写し', 'models/写し.yaml', 'c'.repeat(64)))).not.toBe(
      modelKey(model('写し', 'outputs/x/model_spec.yaml', 'c'.repeat(64), false)),
    )
  })

  it('同じ名前の組だけに, 場所か sha256 の先頭を添える', () => {
    const before = model('net', 'models/net.yaml', '1'.repeat(64))
    const after = model('net', 'models/net.yaml', '2'.repeat(64))
    const other = model('small', 'models/small.yaml', '3'.repeat(64))
    const labels = modelLabels([before, after, other, null])
    expect(labels.get(modelKey(before))).toBe('net (11111111)')
    expect(labels.get(modelKey(after))).toBe('net (22222222)')
    expect(labels.get(modelKey(other))).toBe('small')
    expect(labels.get('none')).toBe('定義の記録が無い')
    // 場所の違う同じ名前は場所も添える
    const yml = model('net', 'models/net.yml', '1'.repeat(64))
    expect(modelLabels([before, yml]).get(modelKey(yml))).toBe('net (models/net.yml, 11111111)')
    // 中身の分からない実験は別の組
    expect(modelLabels([model('net', 'models/net.yaml', null)]).get('models/net.yaml\n')).toBe(
      'net (中身が分からない)',
    )
  })

  it('実験を組ごとにまとめる', () => {
    const a = model('a', 'models/a.yaml', 'a'.repeat(64))
    const b = model('b', 'models/b.yaml', 'b'.repeat(64))
    const groups = groupByModel(
      [
        { id: 1, model: a },
        { id: 2, model: b },
        { id: 3, model: a },
      ],
      (item) => item.model,
    )
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['a', [1, 3]],
      ['b', [2]],
    ])
  })
})
