import { describe, expect, it } from 'vitest'

import type { PolicySpace } from '../api/client'
import {
  boundRows,
  describeFallback,
  discreteRows,
  formatBound,
  formatShare,
  spaceSize,
  trainingSuccess,
  weightsStatus,
} from './policy'

const observation: PolicySpace = {
  type: 'box',
  shape: [4],
  low: [null, null, null, null],
  high: [null, null, null, null],
}

describe('方策の守りの表', () => {
  it('box の空間と止める条件を要素ごとに並べ, null は制限なしにする', () => {
    const { rows, total } = boundRows(
      observation,
      [-2.4, null, -0.21, null],
      [2.4, null, 0.21, null],
    )
    expect(total).toBe(4)
    expect(rows[0]).toEqual({
      index: 0,
      spaceLow: null,
      spaceHigh: null,
      guardLow: -2.4,
      guardHigh: 2.4,
    })
    expect(rows[1]!.guardLow).toBeNull()
    expect(formatBound(rows[1]!.guardLow)).toBe('制限なし')
    expect(formatBound(0)).toBe('0')
  })

  it('守りが null (全体に制限なし) でも要素ごとの行を作る', () => {
    const { rows } = boundRows(observation, null, undefined)
    expect(rows.map((row) => row.guardHigh)).toEqual([null, null, null, null])
  })

  it('要素の多い空間は先頭だけを返し, 全体の数を添える', () => {
    const big: PolicySpace = { type: 'box', shape: [10, 50] }
    expect(spaceSize(big)).toBe(500)
    const { rows, total } = boundRows(big, null, null, 200)
    expect(rows).toHaveLength(200)
    expect(total).toBe(500)
  })

  it('discrete の行動を start からの番号で並べ, 選んでよい行動に印を付ける', () => {
    const space: PolicySpace = { type: 'discrete', n: 3, start: 1 }
    expect(discreteRows(space, [1, 3]).rows).toEqual([
      { action: 1, allowed: true },
      { action: 2, allowed: false },
      { action: 3, allowed: true },
    ])
    expect(discreteRows(space, null).rows.every((row) => row.allowed)).toBe(true)
  })

  it('外れたときの動きと重みの確かめを文字にする', () => {
    expect(describeFallback({ kind: 'handover', action: null })).toContain('元の制御に戻す')
    expect(describeFallback({ kind: 'stop', action: null })).toContain('止める')
    expect(describeFallback({ kind: 'action', action: [0, 0.5] })).toBe(
      '決めた行動 [0, 0.5] にする',
    )
    expect(describeFallback({ kind: 'action', action: 0 })).toBe('決めた行動 0 にする')
    expect(weightsStatus('match')).toEqual({ label: '一致', tone: 'good' })
    expect(weightsStatus('mismatch').tone).toBe('critical')
    expect(weightsStatus('missing').label).toBe('重みが無い')
  })
})

describe('評価の割合と学習の成功の割合', () => {
  it('割合を百分率にし, 無い割合は - にする', () => {
    expect(formatShare(0.125)).toBe('12.5%')
    expect(formatShare(null)).toBe('-')
  })

  it('valid/success のベストと最後の値を, epoch の無い行は並びの番号で取る', () => {
    const history = {
      columns: ['valid/success'],
      rows: [{ 'valid/success': 0.5 }, { 'valid/success': 0.75 }, { 'valid/success': null }],
      lr_steps: [],
      named_lr_steps: {},
      x_columns: [],
    }
    expect(
      trainingSuccess(history, { monitor: 'valid/reward', mode: 'max', epoch: 1, value: 1 }),
    ).toEqual({ bestEpoch: 1, best: { epoch: 1, value: 0.5 }, last: { epoch: 2, value: 0.75 } })
    // ベストのエポックに値が無ければ最後の値だけ
    expect(
      trainingSuccess(history, { monitor: 'valid/reward', mode: 'max', epoch: 3, value: 1 }),
    ).toEqual({ bestEpoch: 3, best: null, last: { epoch: 2, value: 0.75 } })
    // ベストのエポックが無ければ bestEpoch も null
    expect(trainingSuccess(history, null)).toEqual({
      bestEpoch: null,
      best: null,
      last: { epoch: 2, value: 0.75 },
    })
    expect(trainingSuccess({ ...history, rows: [{ 'valid/success': null }] }, null)).toBeNull()
    expect(trainingSuccess({ ...history, columns: [] }, null)).toBeNull()
  })
})
