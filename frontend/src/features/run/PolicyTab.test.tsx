import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { RunPolicy } from '../../api/client'
import { PolicyTab } from './PolicyTab'

const policy: RunPolicy = {
  path: 'policy',
  error: null,
  format_version: 1,
  head: 'categorical',
  observation_space: { type: 'box', shape: [2], low: [null, null], high: [null, null] },
  action_space: { type: 'discrete', n: 2, start: 0 },
  guards: {
    action_low: null,
    action_high: null,
    allowed_actions: [0],
    observation_low: [-2.4, null],
    observation_high: [2.4, null],
    fallback: { kind: 'handover', action: null },
  },
  weights: 'policy.pt',
  weights_sha256: 'a'.repeat(64),
  weights_status: 'mismatch',
  weights_size: 1024,
  model_class: 'train.PolicyNet',
  created_at: '2026-11-20T10:00:00+09:00',
  metadata: { env: 'CartPole-v1' },
}

describe('PolicyTab', () => {
  it('守りの表, 外れたときの動き, 重みの確かめ, 人が承認する旨を出し, 重みのリンクを置かない', () => {
    render(<PolicyTab policy={policy} />)
    expect(screen.getByRole('note')).toHaveTextContent('実機での実行は道具の外')
    expect(screen.getByRole('note')).toHaveTextContent('人が承認')
    expect(screen.getByText('元の制御に戻す (行動を返さない)')).toBeInTheDocument()
    expect(screen.getByText('違う (読む側は読まない)')).toBeInTheDocument()

    const observation = screen.getByRole('table', { name: '観測の要素ごとの範囲と止める条件' })
    const cells = within(observation).getAllByRole('row')[1]!.textContent
    expect(cells).toContain('-2.4')
    expect(cells).toContain('2.4')
    const actions = screen.getByRole('table', { name: '行動と選んでよい行動' })
    expect(within(actions).getByText('選ばない')).toBeInTheDocument()
    expect(screen.getByText(/CartPole-v1/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('読めない一式は中身を出さずに理由だけを出す', () => {
    render(
      <PolicyTab
        policy={{
          ...policy,
          error: 'policy.json を読めません: ValueError: 版 2 は新しい',
          guards: null,
          observation_space: null,
          action_space: null,
          weights_status: null,
        }}
      />,
    )
    expect(screen.getByText(/版 2 は新しい/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('note')).toBeInTheDocument()
  })
})
