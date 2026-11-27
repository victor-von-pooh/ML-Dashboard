import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JobInfo } from '../../api/client'
import { JobCard } from './JobCard'

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

/** fit の後に評価と推論の一式を書き出すジョブ. 実験の状態は完了 */
function job(extra: Partial<JobInfo> = {}): JobInfo {
  return {
    id: '0123456789ab',
    project_id: 'demo',
    script: 'train.py',
    config: 'configs/experiment/train.yaml',
    created_at: '2026-11-28T10:00:00+09:00',
    pid: 1,
    status: 'running',
    return_code: null,
    run_id: 'outputs/demo/2026-11-28/10-00-00',
    finished_at: null,
    stop_requested: false,
    force_count: 0,
    attached: true,
    hostname: 'host',
    default_config: null,
    project_name: 'demo',
    run: { status: 'completed', epochs: 3, planned_epochs: 3, diff: {} },
    progress: {
      phase: 'valid',
      epoch: 3,
      total_epochs: 3,
      batch: 10,
      total_batches: 10,
      stage: 'epoch_end',
      elapsed_sec: 30,
      updated_at: '2026-11-28T10:00:30+09:00',
      start_epoch: 1,
    },
    config_text: null,
    ...extra,
  } as JobInfo
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('JobCard', () => {
  it('推論の一式を書き出すまで「完了」を出さず, 後の処理の途中であることを出す', () => {
    const { rerender } = render(wrap(<JobCard job={job()} />))
    expect(screen.getByText('後の処理中')).toBeInTheDocument()
    expect(screen.queryByText('完了')).not.toBeInTheDocument()
    expect(screen.getByText(/スクリプトが学習の後の処理/)).toBeInTheDocument()
    // 学習を終えたので, エポックの進捗バーは出さない
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    // エポックで止める要求を読む学習は終えたので, すぐに止めるだけを出す
    expect(screen.queryByRole('button', { name: /エポック/ })).not.toBeInTheDocument()
    // 止める前の確かめは, 一式が残らないことを伝える
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    fireEvent.click(screen.getByRole('button', { name: /すぐに止める/ }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('推論の一式は残りません'))

    // プロセスが終わる (一式を書き終える) と完了
    rerender(
      wrap(
        <JobCard
          job={job({
            status: 'finished',
            return_code: 0,
            finished_at: '2026-11-28T10:01:00+09:00',
            progress: null,
          })}
        />,
      ),
    )
    expect(screen.getByText('完了')).toBeInTheDocument()
    expect(screen.queryByText('後の処理中')).not.toBeInTheDocument()
  })

  it('同じプロセスと確かめられない場合は, 後の処理中のプロセスに割り込まず理由を出す', () => {
    render(wrap(<JobCard job={job({ attached: false })} />))
    expect(screen.getByText('後の処理中')).toBeInTheDocument()
    const force = screen.getByRole('button', { name: /すぐに止める/ })
    expect(force).toBeDisabled()
    expect(force).toHaveAccessibleDescription(/同じプロセスと確かめられないので/)
  })

  it('後の処理で止まったジョブは「完了」にしない', () => {
    render(wrap(<JobCard job={job({ status: 'finished', return_code: 1, progress: null })} />))
    expect(screen.getByText('失敗')).toBeInTheDocument()
    expect(screen.queryByText('完了')).not.toBeInTheDocument()
  })
})
