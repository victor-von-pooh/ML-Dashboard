import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from 'react-router'

import { ApiContext, ApiError, createApi } from './api/client'
import { Layout } from './components/Layout'
import { NotFound, RouteError } from './components/RouteError'
import { AnalysisPage } from './features/analysis/AnalysisPage'
import { ComparePage } from './features/compare/ComparePage'
import { JobDetailPage, JobsPage } from './features/jobs/JobsPage'
import { LaunchPage } from './features/jobs/LaunchPage'
import { ProjectsPage } from './features/projects/ProjectsPage'
import { RequirementsPage } from './features/requirements/RequirementsPage'
import { RunDetailPage } from './features/run/RunDetailPage'
import { ProjectRunsPage } from './features/runs/RunsPage'
import { StageContext, useStage, type StageValue } from './lib/stage'
import { ThemeProvider } from './lib/theme'

/** 学習・評価の段階の画面の根の部品の props (殻と単独で同じ形) */
export interface StageAppProps {
  /** 画面の経路の頭 (例 `/train`). 単独では `""` */
  basename: string
  /** API の頭 (例 `/api/train`). 単独では `/api` */
  apiBase: string
  /** 殻で選んだ問題の設定の識別子. null は選んでいない (今まで通り) */
  project: string | null
  /** 置き場の問題の設定に記録されたプロジェクトを登録したときに, その識別子で呼ぶ */
  onProjectChange: (project: string | null) => void
  /** 問題の設定の一覧が変わったときに呼ぶ (このアプリは一覧を変えないので呼ばない) */
  onProjectsChange: () => void
  /** 殻の下に載せたか (アプリの名前と明暗の切り替えを出さず, 明暗は読むだけにする) */
  embedded: boolean
}

/** 部品ごとの TanStack Query の client */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        // 見つからないなどの利用者側のエラーは繰り返さない
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
      },
    },
  })
}

/** 部品が知らせた値が返ってきたかを聞く (読むと知らせた値を忘れる) */
const ReportedBackContext = createContext<(project: string | null) => boolean>(() => false)

/**
 * 殻が project を替えたら, プロジェクトの画面に移す
 *
 * 最初に受け取った値と, 部品が知らせた値が返ってきたときは移さない (開いた URL と,
 * 登録した後の画面に留まるため). 既にプロジェクトの画面にいれば移さない (履歴を増やさないため)
 */
function FollowProject() {
  const { project } = useStage()
  const reportedBack = useContext(ReportedBackContext)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // 経路は移動のたびに変わるので, 移すかを決めるときだけ読む
  const path = useRef(pathname)
  useLayoutEffect(() => {
    path.current = pathname
  }, [pathname])
  // 前に合わせた値 (undefined はまだ合わせていない. StrictMode の 2 度の実行でも 1 度だけ移す)
  const followed = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (followed.current === project) return
    const first = followed.current === undefined
    followed.current = project
    const own = reportedBack(project)
    if (first || own || path.current === '/') return
    void navigate('/')
  }, [project, reportedBack, navigate])
  return null
}

/** 経路の一番外の要素 (殻の選びに合わせる見張りと, サイドバーと本文の枠) */
function StageRoot() {
  return (
    <>
      <FollowProject />
      <Layout />
    </>
  )
}

/** 部品の中の経路 (basename の下) */
function makeRouter(basename: string) {
  return createBrowserRouter(
    [
      {
        element: <StageRoot />,
        errorElement: <RouteError />,
        children: [
          { path: '/', element: <ProjectsPage /> },
          { path: '/projects/:projectId', element: <ProjectRunsPage /> },
          { path: '/projects/:projectId/compare', element: <ComparePage /> },
          { path: '/projects/:projectId/analysis', element: <AnalysisPage /> },
          { path: '/projects/:projectId/launch', element: <LaunchPage /> },
          { path: '/projects/:projectId/requirements', element: <RequirementsPage /> },
          { path: '/jobs', element: <JobsPage /> },
          { path: '/jobs/:jobId', element: <JobDetailPage /> },
          { path: '/projects/:projectId/runs/*', element: <RunDetailPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
    { basename: basename || undefined },
  )
}

/** 部品の中のルーター */
type StageRouter = ReturnType<typeof makeRouter>

/** 部品ごとのルーターの入れ物 (生きているルーターを 1 つだけ持つ) */
class RouterHolder {
  /** 生きているルーター (捨てた後は null) */
  private router: StageRouter | null = null

  /** 画面の経路の頭 */
  private readonly basename: string

  /** @param basename - 画面の経路の頭 */
  constructor(basename: string) {
    this.basename = basename
  }

  /** 生きているルーターがあるか */
  get alive(): boolean {
    return this.router !== null
  }

  /** 生きているルーター (無ければ作る) */
  get(): StageRouter {
    this.router ??= makeRouter(this.basename)
    return this.router
  }

  /** 生きているルーターを捨てる */
  dispose(): void {
    this.router?.dispose()
    this.router = null
  }
}

/**
 * 付けている間だけ生きるルーターを持つ (描画のときに作り, 外すときに捨てる)
 *
 * `createBrowserRouter` は作るときに戻ると進むの見張り (`popstate`) を付けるので, 2 度
 * 走る `useState` の初期化では作らず (初期化で作るのは空の入れ物だけ), 描画で入れ物に
 * 作る. 確定しなかった描画 (Suspense の中断や, 割り込む更新での描き直し) で作った
 * ルーターは捨てない (StageApp の下では描画が中断せず, 割り込みで描き直されるのは稀で,
 * 残るのは使われないルーターの見張り 1 つのため). 外すとき (layout effect の後始末) に
 * 捨て, 付け直されたとき (StrictMode の 2 度目の付け) だけ作り直して塗る前に描き直す. 使うときの起動では付け直しが無いので,
 * 最初の描画からルーターを出し, 描き直しも無い. 経路の頭は最初の値を使う
 *
 * @param basename - 画面の経路の頭
 * @returns 生きているルーター
 */
function useMountedRouter(basename: string): StageRouter {
  const [holder] = useState(() => new RouterHolder(basename))
  // 付け直したときに作り直したルーター (描き直すため)
  const [, setRemade] = useState<StageRouter | null>(null)
  useLayoutEffect(() => {
    if (!holder.alive) {
      // StrictMode の付け直しのときだけ走る (使うときの起動では付け直しが無い)
      // oxlint-disable-next-line react/set-state-in-effect -- StrictMode の付け直しのときだけ走るため
      setRemade(holder.get())
    }
    return () => holder.dispose()
  }, [holder])
  return holder.get()
}

/**
 * 学習・評価の段階の画面の根の部品
 *
 * 自分のルーター (basename の下) と TanStack Query の client を持つ. 単独では main.tsx が
 * 既定の値 (basename `""`, apiBase `/api`, project null, embedded false) で描く
 */
export function StageApp({ basename, apiBase, project, onProjectChange, embedded }: StageAppProps) {
  const [queryClient] = useState(makeQueryClient)
  // ルーターは部品ごとに 1 つ (殻は段階を移るたびに部品を作り直す). 経路の頭は最初の値を使う
  const router = useMountedRouter(basename)
  const api = useMemo(() => createApi(apiBase), [apiBase])
  // 部品が殻に知らせた値 (返ってきたときにプロジェクトの画面へ移さないため)
  const reported = useRef<string | null | undefined>(undefined)
  const report = useCallback(
    (next: string | null) => {
      reported.current = next
      onProjectChange(next)
    },
    [onProjectChange],
  )
  const reportedBack = useCallback((next: string | null) => {
    const own = reported.current === next
    reported.current = undefined
    return own
  }, [])
  const stage = useMemo<StageValue>(
    () => ({ project, onProjectChange: report, embedded }),
    [project, report, embedded],
  )
  return (
    <ThemeProvider readOnly={embedded}>
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api}>
          <StageContext.Provider value={stage}>
            <ReportedBackContext.Provider value={reportedBack}>
              {/* 部品の範囲の印 (殻の画面で押したキーを拾わないため. 箱は作らない) */}
              <div data-stage-root className="contents">
                <RouterProvider router={router} />
              </div>
            </ReportedBackContext.Provider>
          </StageContext.Provider>
        </ApiContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
