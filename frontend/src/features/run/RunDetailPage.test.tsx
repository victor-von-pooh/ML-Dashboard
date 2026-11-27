import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobInfo, ProjectDetail, RunDetail } from '../../api/client'
import { StageApp } from '../../StageApp'

const RUN_ID = 'demo/2026-11-28/10-00-00'
// ジョブの無い (端末から起動した) 別の実験
const OTHER_ID = 'demo/2026-11-28/09-00-00'

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
function runOf(bundle: boolean, id = RUN_ID): RunDetail {
  const files = ['run.json', 'final_model.pt', ...(bundle ? ['inference/inference.yaml'] : [])]
  return {
    id,
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
function jobOf(status: 'running' | 'finished', returnCode = 0): JobInfo {
  return {
    id: '0123456789ab',
    project_id: 'p1',
    script: 'train.py',
    config: 'configs/experiment/train.yaml',
    created_at: '2026-11-28T10:00:00+09:00',
    pid: 1,
    status,
    return_code: status === 'finished' ? returnCode : null,
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

/** 答えを変えられる API の様子 */
interface ApiState {
  /** ジョブの一覧 (error は 500 で答える) */
  jobs: JobInfo[] | 'error'
  /** RUN_ID の実験が推論の一式を書き出したか */
  bundle: boolean
  /** 実験の詳細の答えを待たせる間の約束 (null は待たせない) */
  runGate: Promise<void> | null
}

/** API の頭 base の下に, state に合わせて答える fetch */
function stubApi(base: string, state: ApiState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith(`${base}/`)) return new Response(null, { status: 404 })
    const path = decodeURIComponent(url.slice(base.length).split('?')[0]!)
    if (path === '/jobs')
      return state.jobs === 'error'
        ? Response.json({ detail: 'error' }, { status: 500 })
        : Response.json(state.jobs)
    for (const id of [RUN_ID, OTHER_ID]) {
      const run = `/projects/p1/runs/${id}`
      if (path === run) {
        if (id === OTHER_ID) return Response.json(runOf(true, OTHER_ID))
        // 待たせる前に決めた中身を返す (待つ間に書き出した一式は, 次の読み直しで見える)
        const bundle = state.bundle
        if (state.runGate) await state.runGate
        return Response.json(runOf(bundle))
      }
      if (path === `${run}/results`)
        return Response.json({
          evaluations: [],
          samples: [],
          trajectories: [],
          policy_outcomes: [],
          notices: [],
        })
      if (path === `${run}/relaunch`) return Response.json({ reason: null })
    }
    if (path === '/projects/p1/notes') return Response.json({})
    if (path === '/projects/p1') return Response.json(PROJECT)
    if (path === '/projects') return Response.json([PROJECT])
    if (path === '/batches' || path === '/projects/p1/runs') return Response.json([])
    return Response.json({ detail: 'not found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 経路 path (basename の下) を開いて根の部品を描く */
function renderAt(path: string, basename = '', apiBase = '/api', embedded = false) {
  window.history.pushState({}, '', `${basename}${path}`)
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
}

// ジョブの一覧は動いているジョブがある間 1.5 秒ごとに読み直すので, 変わるのを長めに待つ
const SLOW = { timeout: 5000 }

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
      const state: ApiState = { jobs: [jobOf('running')], bundle: false, runGate: null }
      const fetchMock = stubApi(apiBase, state)
      renderAt(`/projects/p1/runs/${RUN_ID}`, basename, apiBase, embedded)

      // run.json は完了でもジョブが動いている間は, 後の処理の途中であることとジョブへのリンク
      expect(await screen.findByText(/スクリプトが学習の後の処理/, {}, SLOW)).toBeInTheDocument()
      expect(screen.getByText('後の処理中')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'ジョブを開く' })).toHaveAttribute(
        'href',
        `${basename}/jobs/0123456789ab`,
      )
      expect(screen.queryByText('この実験を推論の段階で使うには')).not.toBeInTheDocument()
      expect(screen.queryByText(/学習の結果から作る/)).not.toBeInTheDocument()

      // ジョブが終わっても, 実験の詳細の読み直しが解けるまでは古いファイルの一覧
      // (一式なし) で「学習の結果から作る」を出さない
      let release = () => {}
      state.runGate = new Promise((resolve) => {
        release = resolve
      })
      state.bundle = true
      state.jobs = [jobOf('finished')]
      await waitFor(
        () => expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument(),
        SLOW,
      )
      expect(screen.queryByText('この実験を推論の段階で使うには')).not.toBeInTheDocument()
      expect(screen.queryByText(/学習の結果から作る/)).not.toBeInTheDocument()

      // 読み直した実験の詳細 (一式あり) で, 開き直さずに「実験の一覧から登録」の案内に変わる
      state.runGate = null
      release()
      expect(await screen.findByText(/実験の一覧から登録/, {}, SLOW)).toBeInTheDocument()
      expect(screen.getByText('この実験を推論の段階で使うには')).toBeInTheDocument()
      expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument()
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.every(([input]) => String(input).startsWith(`${apiBase}/`)),
        ).toBe(true),
      )
    },
    15_000,
  )

  it('ジョブの無い (端末から起動した) 実験には, 今まで通り案内を出す', async () => {
    stubApi('/api', { jobs: [], bundle: false, runGate: null })
    renderAt(`/projects/p1/runs/${RUN_ID}`)
    expect(await screen.findByText(/学習の結果から作る/, {}, SLOW)).toBeInTheDocument()
    expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument()
  })

  it.each([
    { label: '失敗', job: jobOf('finished', 1), text: /途中で失敗しました/ },
    {
      label: '中断',
      job: { ...jobOf('finished', -2), stop_requested: true, force_count: 1 },
      text: /途中で止まりました/,
    },
  ])(
    '後の処理で$labelしたジョブの実験には, 案内を出さずジョブの状態を出す',
    async ({ label, job, text }) => {
      stubApi('/api', { jobs: [job], bundle: false, runGate: null })
      renderAt(`/projects/p1/runs/${RUN_ID}`)
      expect(await screen.findByText(text, {}, SLOW)).toBeInTheDocument()
      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'ジョブを開く' })).toHaveAttribute(
        'href',
        '/jobs/0123456789ab',
      )
      expect(screen.queryByText('この実験を推論の段階で使うには')).not.toBeInTheDocument()
    },
  )

  it('ジョブの一覧を読めなければ, 案内を出し続ける', async () => {
    stubApi('/api', { jobs: 'error', bundle: false, runGate: null })
    renderAt(`/projects/p1/runs/${RUN_ID}`)
    expect(await screen.findByText(/学習の結果から作る/, {}, SLOW)).toBeInTheDocument()
    expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument()
  })

  it('別の実験に移ったら, 前の実験のジョブの様子を持ち越さずに見直す', async () => {
    stubApi('/api', { jobs: [jobOf('running')], bundle: false, runGate: null })
    renderAt(`/projects/p1/runs/${RUN_ID}`)
    expect(await screen.findByText(/スクリプトが学習の後の処理/, {}, SLOW)).toBeInTheDocument()

    // 同じ画面の部品のまま, ジョブの無い実験 (一式あり) に移る
    act(() => {
      window.history.pushState({}, '', `/projects/p1/runs/${OTHER_ID}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(await screen.findByText(/実験の一覧から登録/, {}, SLOW)).toBeInTheDocument()
    expect(screen.queryByText(/スクリプトが学習の後の処理/)).not.toBeInTheDocument()
  })
})
