import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobInfo, ProjectDetail, RunDetail } from '../../api/client'
import { StageApp } from '../../StageApp'

const RUN_ID = 'demo/2026-11-28/10-00-00'

const PROJECT: ProjectDetail = {
  id: 'p1',
  name: 'demo',
  path: '/work/demo',
  python: '/usr/bin/python3',
  created_at: '2026-01-01T00:00:00',
  run_count: 1,
  latest_run: null,
  output_dirs: [],
  scripts: ['train.py'],
  experiment_configs: ['configs/experiment/train.yaml'],
}

/** fit を終えた (run.json が完了の) 実験. bundle は推論の一式を書き出したか */
function runOf(bundle: boolean): RunDetail {
  const files = ['run.json', 'final_model.pt', ...(bundle ? ['inference/inference.yaml'] : [])]
  return {
    id: RUN_ID,
    name: 'demo',
    started_at: '2026-11-28T10:00:00+09:00',
    status: 'completed',
    epochs: 3,
    planned_epochs: 3,
    best: null,
    duration_sec: 30,
    early_stopped_epoch: null,
    diff: {},
    final_metrics: {},
    progress: null,
    error: null,
    model: { name: 'net', path: 'model_spec.yaml', origin_known: true },
    path: '/work/demo/outputs/demo/2026-11-28/10-00-00',
    config: {},
    seed: null,
    device: null,
    parameter_count: null,
    model_structure: null,
    optimizer: null,
    scheduler: null,
    env: [],
    packages: {},
    files: files.map((path) => ({ path, size: 1, kind: 'other', downloadable: true })),
    has_git_diff: false,
    notices: [],
  } as unknown as RunDetail
}

/** この実験を学習したジョブ. running の間は学習のスクリプトが後の処理をしている */
function jobOf(status: 'running' | 'finished'): JobInfo {
  return {
    id: '0123456789ab',
    project_id: 'p1',
    script: 'train.py',
    config: 'configs/experiment/train.yaml',
    created_at: '2026-11-28T10:00:00+09:00',
    pid: 1,
    status,
    return_code: status === 'finished' ? 0 : null,
    run_id: RUN_ID,
    finished_at: null,
    stop_requested: false,
    force_count: 0,
    attached: true,
    hostname: 'host',
    default_config: null,
    project_name: 'demo',
    run: { status: 'completed', epochs: 3, planned_epochs: 3, diff: {} },
    progress: null,
    config_text: null,
  } as unknown as JobInfo
}

/**
 * API の頭 base の下に答える fetch. state.finished でジョブが終わり,
 * 同時に推論の一式を書き出した実験を返す
 */
function stubApi(base: string, state: { finished: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith(`${base}/`)) return new Response(null, { status: 404 })
    const path = decodeURIComponent(url.slice(base.length).split('?')[0]!)
    const run = `/projects/p1/runs/${RUN_ID}`
    if (path === '/jobs') return Response.json([jobOf(state.finished ? 'finished' : 'running')])
    if (path === run) return Response.json(runOf(state.finished))
    if (path === `${run}/results`)
      return Response.json({
        evaluations: [],
        samples: [],
        trajectories: [],
        policy_outcomes: [],
        notices: [],
      })
    if (path === `${run}/relaunch`) return Response.json({ reason: null })
    if (path === '/projects/p1/notes') return Response.json({})
    if (path === '/projects/p1') return Response.json(PROJECT)
    if (path === '/projects') return Response.json([PROJECT])
    if (path === '/batches' || path === '/projects/p1/runs') return Response.json([])
    return Response.json({ detail: 'not found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  // jsdom は要素を画面に寄せないので, タブが選んだタブを見せる呼び出しを空にする
  Element.prototype.scrollIntoView ??= () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('実験の詳細の次の段階への案内', () => {
  it.each([
    { label: '単独', basename: '', apiBase: '/api', embedded: false },
    { label: '殻の下', basename: '/train', apiBase: '/api/train', embedded: true },
  ])(
    '$label: 学習の後の処理の間は案内を出さず, ジョブが終わると開き直さずに一式の案内に変わる',
    async ({ basename, apiBase, embedded }) => {
      const state = { finished: false }
      const fetchMock = stubApi(apiBase, state)
      window.history.pushState({}, '', `${basename}/projects/p1/runs/${RUN_ID}`)
      render(
        <StageApp
          basename={basename}
          apiBase={apiBase}
          project={null}
          onProjectChange={() => {}}
          onProjectsChange={() => {}}
          embedded={embedded}
        />,
      )

      // run.json は完了でもジョブが動いている間は, 後の処理の途中であることとジョブへのリンク
      expect(await screen.findByText(/スクリプトが学習の後の処理/)).toBeInTheDocument()
      expect(screen.getByText('後の処理中')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'ジョブを開く' })).toHaveAttribute(
        'href',
        `${basename}/jobs/0123456789ab`,
      )
      expect(screen.queryByText('この実験を推論の段階で使うには')).not.toBeInTheDocument()
      expect(screen.queryByText(/学習の結果から作る/)).not.toBeInTheDocument()

      // ジョブが終わる (一式を書き出す) と, ジョブの一覧の読み直しで実験の詳細も読み直す
      state.finished = true
      expect(
        await screen.findByText(/実験の一覧から登録/, {}, { timeout: 5000 }),
      ).toBeInTheDocument()
      expect(screen.getByText('この実験を推論の段階で使うには')).toBeInTheDocument()
      expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument()
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.every(([input]) => String(input).startsWith(`${apiBase}/`)),
        ).toBe(true),
      )
    },
    10_000,
  )
})
