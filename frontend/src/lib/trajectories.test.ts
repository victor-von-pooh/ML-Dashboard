import { describe, expect, it } from 'vitest'

import type { PolicyEstimate } from '../api/client'
import {
  comparisonRows,
  describeSource,
  describeTarget,
  estimateWarnings,
  parseRate,
} from './trajectories'

const estimate: PolicyEstimate = {
  name: 'coin',
  policy: 'uniform',
  epsilon: 1,
  gamma: 1,
  action_start: 0,
  action_count: 2,
  best_action: null,
  value: 2,
  ordinary: 1.7007,
  per_decision: 1.8,
  behavior_value: 2,
  episodes: 2,
  steps: 6,
  effective_sample_size: 2,
  max_weight_share: 0.5,
  zero_weight_episodes: 0,
  underflow_episodes: 0,
  low_ess: false,
  low_ess_ratio: 0.1,
  notes: [],
}

describe('trajectories', () => {
  it('0 以上 1 以下の数だけを読む', () => {
    expect(parseRate('0')).toBe(0)
    expect(parseRate('0.25')).toBe(0.25)
    expect(parseRate('1')).toBe(1)
    expect(parseRate('')).toBeNull()
    expect(parseRate('1.5')).toBeNull()
    expect(parseRate('-0.1')).toBeNull()
    expect(parseRate('abc')).toBeNull()
  })

  it('見積もる方策と記録した評価を言葉にする', () => {
    expect(describeTarget('uniform', 1, null)).toContain('一様')
    expect(describeTarget('epsilon_greedy', 0.1, 1)).toContain('記録で最も多い行動 1')
    expect(describeSource('evaluation_loader')).toContain('EvaluationLoader')
    expect(describeSource(null)).toBe('不明')
  })

  it('3 つの見積もりと記録の方策の平均を並べる', () => {
    expect(comparisonRows(estimate).map((row) => [row.key, row.value])).toEqual([
      ['value', 2],
      ['ordinary', 1.7007],
      ['per_decision', 1.8],
      ['behavior_value', 2],
    ])
  })

  it('有効なサンプルの数が少ないときと, ε = 0 で重みが 0 のときに知らせる', () => {
    expect(estimateWarnings(estimate)).toEqual([])
    const [low] = estimateWarnings({
      ...estimate,
      episodes: 20,
      effective_sample_size: 1.42,
      max_weight_share: 0.84,
      low_ess: true,
    })
    expect(low).toContain('有効なサンプルの数 1.42 がエピソードの数 20 の 10.0% より少ない')
    expect(low).toContain('84.0%')

    const greedy = {
      ...estimate,
      policy: 'epsilon_greedy' as const,
      best_action: 1,
      zero_weight_episodes: 1,
    }
    expect(estimateWarnings({ ...greedy, epsilon: 0 })).toEqual([
      'ε = 0 では, 記録で最も多い行動 (1) の他をとったエピソードの重みが 0 になります (1 / 2 エピソード).',
    ])
    // ε が 0 でなければ, 重みが 0 なのは空間の外の行動などなので ε の知らせは出さない
    expect(estimateWarnings({ ...greedy, epsilon: 0.1 })).toEqual([])
    expect(
      estimateWarnings({ ...greedy, epsilon: 0, value: null, zero_weight_episodes: 2 })[0],
    ).toContain('重み付きの見積もりは決まりません')
  })
})
