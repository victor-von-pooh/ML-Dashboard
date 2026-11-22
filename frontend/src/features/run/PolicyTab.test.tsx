import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { History, PolicyOutcome, RunPolicy } from '../../api/client'
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

  it('守り付きの評価の終え方ごとの割合, 守りが働いた割合, 学習の成功の割合を出す', () => {
    const outcome: PolicyOutcome = {
      name: 'guarded_episodes',
      split: 'simulator',
      description: '守りを当てて動かしたエピソード',
      epoch: 7,
      episodes: 8,
      ends: [
        { end: 'terminated', count: 2, ratio: 0.25 },
        { end: 'truncated', count: 4, ratio: 0.5 },
        { end: 'max_steps', count: 0, ratio: 0 },
        { end: 'stop', count: 1, ratio: 0.125 },
        { end: 'handover', count: 1, ratio: 0.125 },
      ],
      guarded: 2,
      guarded_ratio: 0.25,
    }
    const history: History = {
      columns: ['epoch', 'valid/reward', 'valid/success'],
      rows: [
        { epoch: 1, 'valid/reward': 10, 'valid/success': 0.2 },
        { epoch: 2, 'valid/reward': 30, 'valid/success': 0.9 },
        { epoch: 3, 'valid/reward': 20, 'valid/success': null },
      ],
      lr_steps: [],
      named_lr_steps: {},
      x_columns: [],
    }
    render(
      <PolicyTab
        policy={policy}
        outcomes={[outcome]}
        history={history}
        best={{ monitor: 'valid/reward', mode: 'max', epoch: 1, value: 10 }}
      />,
    )
    const table = screen.getByRole('table', { name: 'guarded_episodes の終え方ごとの割合' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(6)
    expect(rows[2]).toHaveTextContent('環境の時間切れ')
    expect(rows[2]).toHaveTextContent('50.0%')
    expect(rows[5]).toHaveTextContent('守りが元の制御に戻した')
    expect(screen.getByText(/守りが止めたか元の制御に戻した: 25.0%/)).toHaveTextContent('(2 / 8)')
    // 件数と説明の間にも区切りを入れ, 評価の名前はカードの見出しの次の段
    expect(
      screen.getByText(
        '分割 simulator · エポック 7 · 8 エピソード · 守りを当てて動かしたエピソード',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'guarded_episodes' })).toBeInTheDocument()
    // 狭い幅でも表の見出しを折らない
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).toHaveClass('whitespace-nowrap')
    }

    // ベストのエポックと, 値のある最後のエポックの成功の割合
    const success = screen.getByRole('region', { name: '学習の成功の割合' })
    expect(within(success).getByText('ベストのエポック (1)').nextSibling).toHaveTextContent('20.0%')
    expect(within(success).getByText('最後のエポック (2)').nextSibling).toHaveTextContent('90.0%')
  })

  it('ベストのエポックに成功の割合の値が無ければそう出す', () => {
    render(
      <PolicyTab
        policy={policy}
        outcomes={[]}
        history={{
          columns: ['epoch', 'valid/reward', 'valid/success'],
          rows: [
            { epoch: 1, 'valid/reward': 10, 'valid/success': 0.2 },
            { epoch: 2, 'valid/reward': 30, 'valid/success': null },
          ],
          lr_steps: [],
          named_lr_steps: {},
          x_columns: [],
        }}
        best={{ monitor: 'valid/reward', mode: 'max', epoch: 2, value: 30 }}
      />,
    )
    const success = screen.getByRole('region', { name: '学習の成功の割合' })
    expect(within(success).getByText('ベストのエポック (2)').nextSibling).toHaveTextContent(
      'このエポックに値がありません',
    )
    expect(within(success).getByText('最後のエポック (1)').nextSibling).toHaveTextContent('20.0%')
  })

  it('評価の無い実験と成功の割合の無い学習はそう出す', () => {
    render(
      <PolicyTab
        policy={policy}
        outcomes={[]}
        history={{
          columns: ['epoch', 'valid/reward'],
          rows: [{ epoch: 1, 'valid/reward': 1 }],
          lr_steps: [],
          named_lr_steps: {},
          x_columns: [],
        }}
        best={null}
      />,
    )
    expect(screen.getByText(/守り付きの評価がありません/)).toBeInTheDocument()
    expect(screen.getByText(/valid\/success がありません/)).toBeInTheDocument()
  })

  it('行の無い評価と知らない終え方を出す', () => {
    render(
      <PolicyTab
        policy={policy}
        outcomes={[
          { name: 'empty', episodes: 0, ends: [], guarded: 0, guarded_ratio: null },
          {
            name: 'odd',
            episodes: 1,
            ends: [{ end: 'other', count: 1, ratio: 1 }],
            guarded: 0,
            guarded_ratio: 0,
          },
        ]}
      />,
    )
    expect(screen.getByText('エピソードの行が無いので, 割合を出せません.')).toBeInTheDocument()
    expect(screen.getByText('その他 (知らない値, 値なし)')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '学習の成功の割合' })).toBeNull()
  })
})
