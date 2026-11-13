import { describe, expect, it } from 'vitest'

import type { ModelParam } from '../api/client'
import { countParams, filterParams } from './modelSummary'

const row = (overrides: Partial<ModelParam>): ModelParam => ({
  name: '0.weight',
  kind: 'parameter',
  module: 'Linear',
  shape: '4x3',
  dtype: 'float32',
  numel: 12,
  requires_grad: true,
  same_as: '',
  ...overrides,
})

describe('modelSummary', () => {
  it('種類ごとに要素数を数え, 共有した名前は 1 回だけ数える', () => {
    const rows = [
      row({}),
      row({ name: '0.bias', numel: 4, requires_grad: false }),
      row({ name: '1.running_mean', kind: 'buffer', module: 'BatchNorm1d', numel: 4 }),
      row({ name: '2.weight', same_as: '0.weight' }),
    ]
    expect(countParams(rows)).toEqual({ trainable: 12, frozen: 4, buffer: 4 })
  })

  it('名前か層のクラス名で絞る', () => {
    const rows = [row({}), row({ name: 'qnn.weight', module: 'TorchConnector' })]
    expect(filterParams(rows, 'torch').map((item) => item.name)).toEqual(['qnn.weight'])
    expect(filterParams(rows, ' ')).toHaveLength(2)
  })
})
