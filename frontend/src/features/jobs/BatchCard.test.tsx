import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BatchInfo } from '../../api/client'
import { BatchCard } from './BatchCard'

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

function batch(extra: Partial<BatchInfo> = {}): BatchInfo {
  return {
    id: '0123456789ab',
    project_id: 'demo',
    script: 'train.py',
    default_config: null,
    created_at: '2026-11-22T10:00:00+09:00',
    owner: { hostname: 'host', pid: 1, started_at: '2026-11-22T09:00:00+09:00' },
    candidates: [
      {
        path: 'models/a.yaml',
        name: 'a',
        sha256: 'a',
        state: 'finished',
        job_id: 'job1',
        mismatch: false,
      },
      {
        path: 'models/b.yaml',
        name: 'b',
        sha256: 'b',
        state: 'finished',
        job_id: 'job2',
        mismatch: false,
      },
    ],
    waiting_for: [],
    project_name: 'demo',
    finished: true,
    owned: true,
    ...extra,
  } as BatchInfo
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BatchCard', () => {
  it('終わったまとまりは, 確かめてから記録を消す', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    render(wrap(<BatchCard batch={batch()} jobs={[]} />))

    fireEvent.click(screen.getByRole('button', { name: '記録を消す' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('候補のジョブと実験は残ります'))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/batches/0123456789ab',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    )
  })

  it('確かめで取りやめれば消さない', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', () => false)
    render(wrap(<BatchCard batch={batch()} jobs={[]} />))
    fireEvent.click(screen.getByRole('button', { name: '記録を消す' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('進めている途中のまとまりには消すボタンを出さない', () => {
    const running = batch({
      finished: false,
      candidates: [
        {
          path: 'models/a.yaml',
          name: 'a',
          sha256: 'a',
          state: 'running',
          job_id: 'job1',
          mismatch: false,
        },
        {
          path: 'models/b.yaml',
          name: 'b',
          sha256: 'b',
          state: 'waiting',
          job_id: null,
          mismatch: false,
        },
      ],
    })
    render(wrap(<BatchCard batch={running} jobs={[]} />))
    expect(screen.queryByRole('button', { name: '記録を消す' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '残りを取りやめる' })).toBeInTheDocument()
  })
})
