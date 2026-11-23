import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PolicyEstimate, TrajectoryInfo } from '../../api/client'
import { TrajectoriesTab } from './TrajectoriesTab'

const usable: TrajectoryInfo = {
  name: 'valid_best',
  file: 'trajectories/valid_best.csv',
  has_info: true,
  format_version: 1,
  source: 'evaluation_loader',
  env: 'CartPole-v1',
  epoch: 3,
  description: null,
  episodes: 2,
  rows: 6,
  complete: true,
  with_action_prob: true,
  action_space: { type: 'discrete', n: 2, start: 0 },
  reason: null,
  notice: null,
}

const refused: TrajectoryInfo = {
  ...usable,
  name: 'greedy',
  file: 'trajectories/greedy.csv',
  with_action_prob: false,
  reason: '記録した方策が行動を選んだ確率の列が無いので見積もれません',
}

const estimate: PolicyEstimate = {
  name: 'valid_best',
  policy: 'epsilon_greedy',
  epsilon: 0,
  gamma: 0.9,
  action_start: 0,
  action_count: 2,
  best_action: 1,
  value: 1.9,
  ordinary: 0.95,
  per_decision: 1.2,
  behavior_value: 1.5,
  episodes: 2,
  steps: 6,
  effective_sample_size: 1.2,
  max_weight_share: 1,
  zero_weight_episodes: 1,
  underflow_episodes: 0,
  low_ess: false,
  notes: ['見積もる方策が選ばない行動 (確率 0) を記録した方策が 1 歩でとりました'],
}

function renderTab(trajectories: TrajectoryInfo[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrajectoriesTab
        trajectories={trajectories}
        projectId="p"
        runId="cartpole/2026-11-20/10-00-00"
      />
    </QueryClientProvider>,
  )
}

describe('TrajectoriesTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('選んだ方策, ε, γ で見積もりを求め, 比べと知らせを出す', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(estimate), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderTab([refused, usable])

    // 見積もれる軌跡を先に選び, 一様では ε を選べない
    expect(screen.getByLabelText('軌跡')).toHaveValue('valid_best')
    expect(screen.getByText('0 から 1 の 2 個')).toBeInTheDocument()
    expect(screen.getByLabelText('ε (0 以上 1 以下)')).toBeDisabled()
    fireEvent.click(screen.getByLabelText('記録で最も多い行動の ε-greedy'))
    fireEvent.change(screen.getByLabelText('ε (0 以上 1 以下)'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('割引率 γ (0 以上 1 以下)'), {
      target: { value: '0.9' },
    })
    expect(screen.getByText(/ε = 0 では, 記録で最も多い行動の他/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '見積もる' }))

    const result = await screen.findByRole('region', { name: '見積もり valid_best' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p/runs/cartpole/2026-11-20/10-00-00/trajectories/valid_best/estimate?policy=epsilon_greedy&epsilon=0&gamma=0.9',
      expect.anything(),
    )
    const table = within(result).getByRole('table', { name: 'valid_best の見積もりの比べ' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(5)
    expect(rows[1]).toHaveTextContent('1.9')
    expect(rows[4]).toHaveTextContent('記録の方策の平均')
    expect(rows[4]).toHaveTextContent('1.5')
    expect(
      within(result).getByText(/記録で最も多い行動 \(1\) の他をとったエピソードの重みが 0/),
    ).toBeInTheDocument()
    expect(within(result).getByText(/確率 0/)).toBeInTheDocument()
    // 有効なサンプルの数と重みが 0 のエピソードは, エピソードの数と並べる
    expect(within(result).getByText('1.2 / 2', { selector: 'dd' })).toBeInTheDocument()
    expect(within(result).getByText('1 / 2', { selector: 'dd' })).toBeInTheDocument()
  })

  it('見積もれない軌跡は理由を出し, ボタンを押せない', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderTab([refused])
    expect(screen.getByText(/この軌跡は見積もれません: .*確率の列/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '見積もる' })).toBeDisabled()
  })

  it('範囲の外の γ ではボタンを押せない', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderTab([usable])
    fireEvent.change(screen.getByLabelText('割引率 γ (0 以上 1 以下)'), {
      target: { value: '1.5' },
    })
    expect(screen.getByText('ε と γ は 0 以上 1 以下の数にしてください.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '見積もる' })).toBeDisabled()
  })
})
