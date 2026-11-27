import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProblemProject, ProjectDetail, ProjectInfo, RecordedProjects } from './api/client'
import { GuardBadge } from './features/runs/EvaluationColumns'
import { ThemeProvider } from './lib/theme'
import { useTheme } from './lib/themeContext'
import { StageApp, type StageAppProps } from './StageApp'

/** 登録したプロジェクト */
function projectOf(id: string, name: string): ProjectInfo {
  return {
    id,
    name,
    path: `/work/${name}`,
    python: '/usr/bin/python3',
    created_at: '2026-01-01T00:00:00',
    run_count: 0,
    latest_run: null,
  }
}

const PROJECTS = [projectOf('p1', 'sales'), projectOf('p2', 'churn')]

const DETAIL: ProjectDetail = {
  ...PROJECTS[0]!,
  output_dirs: [],
  scripts: ['train.py'],
  experiment_configs: ['configs/experiment/train.yaml'],
}

/** experiment の config の元の中身 */
const CONFIG_TEXT = 'trainer:\n  epochs: 3\n'

/** 問題の設定の対応 (識別子ごと. 無ければ 404) */
const PROBLEMS: Record<string, ProblemProject> = {
  sales: {
    id: 'sales',
    problem: '売上の予測',
    problem_path: '/home/user/.ml-pathfinder/problems/sales/problem.yaml',
    project_path: '/work/sales',
    project_id: 'p1',
    reason: null,
  },
  fresh: {
    id: 'fresh',
    problem: '新しい課題',
    problem_path: '/home/user/.ml-pathfinder/problems/fresh/problem.yaml',
    project_path: '/work/fresh',
    project_id: null,
    reason: null,
  },
  older: {
    id: 'older',
    problem: '同じプロジェクトの古い課題',
    problem_path: '/home/user/.ml-pathfinder/problems/older/problem.yaml',
    project_path: '/work/fresh',
    project_id: null,
    reason: null,
  },
  draft: {
    id: 'draft',
    problem: '書きかけの課題',
    problem_path: '/home/user/.ml-pathfinder/problems/draft/problem.yaml',
    project_path: null,
    project_id: null,
    reason: 'プロジェクトの記録がありません',
  },
}

/** 置き場の問題の設定に記録された, 登録していないプロジェクト */
const RECORDED: RecordedProjects = {
  root: '/home/user/.ml-pathfinder/problems',
  projects: [
    {
      path: '/work/fresh',
      name: 'fresh',
      problem: '新しい課題',
      problem_path: PROBLEMS.fresh!.problem_path,
      updated_at: null,
    },
  ],
  skipped: [],
  error: null,
}

/** API の頭 `/api/train` の下だけに答える fetch (他の場所を呼べば 404) */
function stubApi(base = '/api/train', jobs?: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (!url.startsWith(`${base}/`)) return new Response(null, { status: 404 })
    const path = url.slice(base.length).split('?')[0]!
    if (path === '/projects' && method === 'POST') {
      const { path: place } = JSON.parse(String(init?.body)) as { path: string }
      return Response.json(projectOf('p3', place.split('/').pop() ?? ''), { status: 201 })
    }
    if (path === '/projects') return Response.json(PROJECTS)
    if (path === '/projects/p1') return Response.json(DETAIL)
    if (path === '/projects/p1/configs/configs/experiment/train.yaml')
      return Response.json({ path: 'configs/experiment/train.yaml', text: CONFIG_TEXT })
    if (path === '/projects/p1/requires')
      return Response.json({ requires: [], missing: [], unknown: [], unchecked: [] })
    if (path === '/projects/p1/validate')
      return Response.json({ ok: true, error: null, diff: {}, monitor_in_default: true })
    if (path === '/projects/p1/model-specs') return Response.json({ specs: [] })
    if (path === '/projects/p1/jobs' && method === 'POST' && jobs) return jobs()
    if (path === '/projects/p1/runs' || path === '/jobs' || path === '/batches')
      return Response.json([])
    if (path === '/registry') return Response.json({ optimizers: [], schedulers: [] })
    if (path === '/problems/projects') return Response.json(RECORDED)
    const problem = /^\/problems\/([^/]+)\/project$/.exec(path)
    if (problem) {
      const found = PROBLEMS[decodeURIComponent(problem[1]!)]
      return found
        ? Response.json(found)
        : Response.json({ detail: '問題の設定が置き場にありません' }, { status: 404 })
    }
    return Response.json({ detail: 'not found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 殻の下の形 (経路の頭 `/train`, API の頭 `/api/train`) で, 経路 `path` を開いて描く */
function renderStage(path = '/train', props: Partial<StageAppProps> = {}) {
  window.history.pushState({}, '', path)
  const onProjectChange = vi.fn()
  const onProjectsChange = vi.fn()
  const all: StageAppProps = {
    basename: '/train',
    apiBase: '/api/train',
    project: null,
    onProjectChange,
    onProjectsChange,
    embedded: true,
    ...props,
  }
  const view = render(<StageApp {...all} />)
  const rerender = (next: Partial<StageAppProps>) => view.rerender(<StageApp {...all} {...next} />)
  return { ...view, rerender, onProjectChange, onProjectsChange }
}

/** 呼んだ API の場所 */
function calledUrls(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input))
}

beforeEach(() => {
  // jsdom は対話の枠を開けず, 大きさの変化も見られないので, 開いた印と空の見張りを置く
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('StageApp', () => {
  it('API を全て apiBase の下に呼び, 部品の中の移動を basename の下に留める', async () => {
    const fetchMock = stubApi()
    renderStage('/train')
    expect(await screen.findByRole('link', { name: 'sales' })).toHaveAttribute(
      'href',
      '/train/projects/p1',
    )
    // サイドバーのリンクも頭の下で, 押すと頭の下に移る
    const jobs = screen.getByRole('link', { name: /ジョブ/ })
    expect(jobs).toHaveAttribute('href', '/train/jobs')
    fireEvent.click(jobs)
    await waitFor(() => expect(window.location.pathname).toBe('/train/jobs'))
    await waitFor(() => expect(calledUrls(fetchMock)).toContain('/api/train/jobs'))
    expect(calledUrls(fetchMock).every((url) => url.startsWith('/api/train/'))).toBe(true)
  })

  it('知らない経路の画面から戻る先も basename の下', async () => {
    stubApi()
    renderStage('/train/unknown')
    expect(await screen.findByRole('link', { name: 'プロジェクトの一覧に戻る' })).toHaveAttribute(
      'href',
      '/train',
    )
  })

  it('embedded ではアプリの名前と明暗の切り替えを出さず, html のクラスを書かない', async () => {
    stubApi()
    window.localStorage.setItem('theme', 'dark')
    renderStage('/train')
    await screen.findByRole('link', { name: 'sales' })
    expect(screen.queryByText('ML-Dashboard')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /モードにする/ })).not.toBeInTheDocument()
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('単独では今まで通り名前と明暗の切り替えを出し, 切り替えると html に書く', async () => {
    stubApi('/api')
    render(
      <StageApp
        basename=""
        apiBase="/api"
        project={null}
        onProjectChange={() => {}}
        onProjectsChange={() => {}}
        embedded={false}
      />,
    )
    await screen.findByRole('link', { name: 'sales' })
    expect(screen.getAllByText('ML-Dashboard').length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'ダークモードにする' })[0]!)
    expect(document.documentElement).toHaveClass('dark')
    expect(window.localStorage.getItem('theme')).toBe('dark')
    // 殻の選びを持たないので, 選んだ問題の設定の欄も出さない
    expect(screen.queryByText('選んだ問題の設定')).not.toBeInTheDocument()
  })

  it('読むだけの明暗は, 殻が html のクラスを替えたら読み直す', async () => {
    function Probe() {
      const { theme, toggle } = useTheme()
      return (
        <button type="button" onClick={toggle}>
          {theme}
        </button>
      )
    }
    render(
      <ThemeProvider readOnly>
        <Probe />
      </ThemeProvider>,
    )
    const probe = screen.getByRole('button')
    expect(probe).toHaveTextContent('light')
    // 部品の中からは切り替えない
    fireEvent.click(probe)
    expect(probe).toHaveTextContent('light')
    expect(document.documentElement).not.toHaveClass('dark')
    // 殻が切り替えると読み直す (グラフはこの値で描き直す)
    act(() => document.documentElement.classList.add('dark'))
    await waitFor(() => expect(probe).toHaveTextContent('dark'))
  })
})

describe('殻で選んだ問題の設定', () => {
  it('登録したプロジェクトを記録した問題の設定なら, 開く先を出して一覧を絞る', async () => {
    stubApi()
    const { onProjectChange } = renderStage('/train', { project: 'sales' })
    expect(await screen.findByText('売上の予測')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /実験の一覧を開く/ })).toHaveAttribute(
      'href',
      '/train/projects/p1',
    )
    expect(screen.getByRole('link', { name: /学習を起動/ })).toHaveAttribute(
      'href',
      '/train/projects/p1/launch',
    )
    const main = screen.getByRole('main')
    await waitFor(() => expect(within(main).queryByRole('link', { name: 'churn' })).toBeNull())
    expect(within(main).getByRole('link', { name: 'sales' })).toBeInTheDocument()
    // 絞りを外せる
    fireEvent.click(screen.getByRole('button', { name: '全てのプロジェクトを出す' }))
    expect(within(main).getByRole('link', { name: 'churn' })).toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('殻が選び直したら, 外した絞りをまた付ける', async () => {
    stubApi()
    const view = renderStage('/train', { project: 'sales' })
    fireEvent.click(await screen.findByRole('button', { name: '全てのプロジェクトを出す' }))
    const main = screen.getByRole('main')
    expect(within(main).getByRole('link', { name: 'churn' })).toBeInTheDocument()
    view.rerender({ project: 'fresh' })
    await screen.findByText('新しい課題')
    view.rerender({ project: 'sales' })
    expect(
      await screen.findByRole('button', { name: '全てのプロジェクトを出す' }),
    ).toBeInTheDocument()
    expect(within(main).queryByRole('link', { name: 'churn' })).toBeNull()
  })

  it('登録していなければ「登録して開く」で登録して実験の一覧に移る (殻には知らせない)', async () => {
    const fetchMock = stubApi()
    const { onProjectChange } = renderStage('/train', { project: 'fresh' })
    expect(await screen.findByText('このプロジェクトはまだ登録していません.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '登録して開く' }))
    await waitFor(() => expect(window.location.pathname).toBe('/train/projects/p3'))
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(String(posted?.[0])).toBe('/api/train/projects')
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ path: '/work/fresh' })
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('開けない問題の設定は理由を, 置き場に無い識別子は無いことを出し, 一覧を絞らない', async () => {
    stubApi()
    const view = renderStage('/train', { project: 'draft' })
    expect(await screen.findByText('プロジェクトの記録がありません')).toBeInTheDocument()
    const main = screen.getByRole('main')
    expect(await within(main).findByRole('link', { name: 'churn' })).toBeInTheDocument()
    view.rerender({ project: 'missing' })
    expect(await screen.findByText(/が置き場にありません/)).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: 'churn' })).toBeInTheDocument()
  })

  it('書き出したプロジェクトを登録すると, その識別子を 1 度だけ殻に知らせる', async () => {
    stubApi()
    const { onProjectChange } = renderStage('/train', { project: 'sales' })
    fireEvent.click((await screen.findAllByRole('button', { name: 'プロジェクトを追加' }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'fresh を登録', hidden: true }))
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith('fresh'))
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  it('殻と同じ問題の設定のプロジェクトを登録したときは知らせない', async () => {
    stubApi()
    const { onProjectChange } = renderStage('/train', { project: 'fresh' })
    fireEvent.click((await screen.findAllByRole('button', { name: 'プロジェクトを追加' }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'fresh を登録', hidden: true }))
    await waitFor(() =>
      expect(screen.getByText(/を登録しました/, { selector: 'p' })).toBeInTheDocument(),
    )
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('殻で選んだ問題の設定も同じプロジェクトを記録していれば, 殻の選びを移さない', async () => {
    stubApi()
    const { onProjectChange } = renderStage('/train', { project: 'older' })
    await screen.findByText('同じプロジェクトの古い課題')
    fireEvent.click((await screen.findAllByRole('button', { name: 'プロジェクトを追加' }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'fresh を登録', hidden: true }))
    await waitFor(() =>
      expect(screen.getByText(/を登録しました/, { selector: 'p' })).toBeInTheDocument(),
    )
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('殻が選び直したらプロジェクトの画面に移し, 知らせた値が返ってきたときは移さない', async () => {
    stubApi()
    const view = renderStage('/train/jobs', { project: 'sales' })
    await screen.findByRole('heading', { name: 'ジョブ' })
    // 最初に受け取った値では移さない
    expect(window.location.pathname).toBe('/train/jobs')
    view.rerender({ project: 'fresh' })
    await waitFor(() => expect(window.location.pathname).toBe('/train'))
    expect(await screen.findByText('新しい課題')).toBeInTheDocument()
  })
})

describe('部品の範囲の外のキー', () => {
  it('根の部品は範囲の印を付ける', async () => {
    stubApi()
    renderStage('/train')
    await screen.findByRole('link', { name: 'sales' })
    expect(screen.getByRole('main').closest('[data-stage-root]')).not.toBeNull()
  })

  it('範囲の外 (殻の帯) で押した Esc では説明を閉じず, 中か body で押すと閉じる', () => {
    render(
      <>
        <header>
          <button type="button">殻の欄</button>
        </header>
        <div data-stage-root>
          <GuardBadge guard={{ state: 'dropped', dropped: ['a: acc (差 -0.1)'], unknown: [] }} />
        </div>
      </>,
    )
    const badge = screen.getByRole('button', { name: '守る指標: 落ちた' })
    fireEvent.click(badge)
    fireEvent.keyDown(screen.getByRole('button', { name: '殻の欄' }), { key: 'Escape' })
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(badge)
    fireEvent.keyDown(badge, { key: 'Escape' })
    expect(badge).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('外したときの下書き', () => {
  /** 学習の起動の画面を開き, config の中身を書き換える */
  async function editLaunch(props: Partial<StageAppProps> = {}, jobs?: () => Promise<Response>) {
    const fetchMock = stubApi('/api/train', jobs)
    const view = renderStage('/train/projects/p1/launch', props)
    const editor = await screen.findByLabelText('config の中身')
    await waitFor(() => expect(editor).toHaveValue(CONFIG_TEXT))
    fireEvent.change(editor, { target: { value: 'trainer:\n  epochs: 9\n' } })
    // 起動の画面のフォーム (登録簿, config の解決) も apiBase の下に呼ぶ
    await waitFor(() => expect(calledUrls(fetchMock)).toContain('/api/train/registry'))
    expect(calledUrls(fetchMock).every((url) => url.startsWith('/api/train/'))).toBe(true)
    return view
  }

  /** 学習の起動の画面の下書き (無ければ undefined) */
  function launchDraft(): { value: { text: string } } | undefined {
    const drafts = JSON.parse(window.localStorage.getItem('ml-dashboard:drafts') ?? '{}') as Record<
      string,
      { value: { text: string } }
    >
    return drafts['launch:p1:']
  }

  it('書き換えてすぐ外すと待たずに下書きに書き, 次に開くと戻して捨てられる', async () => {
    const view = await editLaunch()
    // 待つ前は書いていない
    expect(launchDraft()).toBeUndefined()
    view.unmount()
    expect(launchDraft()?.value.text).toBe('trainer:\n  epochs: 9\n')

    renderStage('/train/projects/p1/launch')
    expect(await screen.findByText(/下書きから戻しました/)).toBeInTheDocument()
    const editor = screen.getByLabelText('config の中身')
    expect(editor).toHaveValue('trainer:\n  epochs: 9\n')
    fireEvent.click(screen.getByRole('button', { name: '下書きを捨てる' }))
    await waitFor(() => expect(editor).toHaveValue(CONFIG_TEXT))
    expect(launchDraft()).toBeUndefined()
  })

  it('殻が問題の設定を替えたときも待たずに書く', async () => {
    const view = await editLaunch({ project: 'sales' })
    expect(launchDraft()).toBeUndefined()
    view.rerender({ project: 'fresh' })
    await waitFor(() => expect(launchDraft()?.value.text).toBe('trainer:\n  epochs: 9\n'))
  })

  it('書き換えを元に戻すと下書きを消す', async () => {
    await editLaunch()
    const editor = screen.getByLabelText('config の中身')
    await waitFor(() => expect(launchDraft()).toBeDefined(), { timeout: 3000 })
    fireEvent.change(editor, { target: { value: CONFIG_TEXT } })
    await waitFor(() => expect(launchDraft()).toBeUndefined())
  })

  it('起動を押した時点で下書きを除け, 応答の前に外されても書かない', async () => {
    const view = await editLaunch({}, () => new Promise<Response>(() => {}))
    await waitFor(() => expect(launchDraft()).toBeDefined(), { timeout: 3000 })
    const start = screen.getByRole('button', { name: '学習を開始' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    expect(launchDraft()).toBeUndefined()
    view.unmount()
    expect(launchDraft()).toBeUndefined()
  })

  it('起動できなかったら下書きを書き戻す', async () => {
    await editLaunch({}, async () => Response.json({ detail: '起動しません' }, { status: 400 }))
    const start = screen.getByRole('button', { name: '学習を開始' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    expect(await screen.findByText('起動しません')).toBeInTheDocument()
    expect(launchDraft()?.value.text).toBe('trainer:\n  epochs: 9\n')
  })
})
