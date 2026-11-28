import clsx from 'clsx'
import { FolderKanban, LayoutGrid, ListChecks, Menu, Moon, Sun, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

import { useProjects, useRunningJobCount } from '../api/hooks'
import logo from '../assets/logo.svg'
import { useStage } from '../lib/stage'
import { useTheme } from '../lib/themeContext'

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const Icon = theme === 'dark' ? Sun : Moon
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink"
      aria-label={theme === 'dark' ? 'ライトモードにする' : 'ダークモードにする'}
      title={theme === 'dark' ? 'ライトモードにする' : 'ダークモードにする'}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  )
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-accent-soft font-medium text-accent-text'
      : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  )

/** 実行中のジョブの数の印 (読み上げは「N 件が実行中」) */
function RunningBadge({ count }: { count: number }) {
  return (
    <span className="tabular ml-auto rounded-full bg-accent-strong px-1.5 text-xs text-white">
      {count}
      <span className="sr-only"> 件が実行中</span>
    </span>
  )
}

/**
 * 段階の中の移動の項目 (左のサイドバーと狭い画面のメニューで同じ)
 *
 * @param onNavigate - 項目を押したときに呼ぶ (メニューを閉じるため)
 */
function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const projects = useProjects()
  const runningJobs = useRunningJobCount()
  return (
    <>
      <NavLink to="/" end className={linkClass} onClick={onNavigate}>
        <LayoutGrid className="size-4" aria-hidden />
        プロジェクト
      </NavLink>
      <NavLink to="/jobs" className={linkClass} onClick={onNavigate}>
        <ListChecks className="size-4" aria-hidden />
        ジョブ
        {runningJobs > 0 && <RunningBadge count={runningJobs} />}
      </NavLink>
      <div className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">
        登録したプロジェクト
      </div>
      {projects.data?.map((project) => (
        <NavLink
          key={project.id}
          to={`/projects/${project.id}`}
          className={linkClass}
          onClick={onNavigate}
        >
          <FolderKanban className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{project.name}</span>
          <span className="tabular ml-auto text-xs text-ink-3">{project.run_count}</span>
        </NavLink>
      ))}
      {projects.data?.length === 0 && (
        <p className="px-2.5 text-xs text-ink-3">まだ登録されていません</p>
      )}
    </>
  )
}

/** メニューを閉じた後にフォーカスを移す先 (null は移さない) */
type CloseFocus = 'main' | 'button' | null

/**
 * 狭い画面の移動のメニュー (左のサイドバーの代わり. 殻の下でも出す)
 *
 * 開くとメニューの最初の項目へフォーカスを移す (ボタンを押してもフォーカスが移らない
 * ブラウザでも, Esc とフォーカスの出入りの判定が効くように). 閉じ方でフォーカスの
 * 行き先を決める. 項目を選ぶか経路が替わったら本文へ, Esc かボタンで閉じたらボタンへ,
 * 外を押すかフォーカスが外へ出たら移さない. 閉じていても実行中のジョブの数はボタンの
 * 印で分かる
 */
function NavMenu() {
  const [open, setOpen] = useState(false)
  const runningJobs = useRunningJobCount()
  const { pathname } = useLocation()
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  // 閉じた後にフォーカスを移す先 (閉じるときに決め, 閉じた後に読む)
  const closeFocus = useRef<CloseFocus>('main')

  const close = (focus: CloseFocus) => {
    closeFocus.current = focus
    setOpen(false)
  }

  // 経路が替わったら閉じる (戻る・進む, サイドバーでの移動, 殻の段階の移動も同じ).
  // 閉じた後のフォーカスは既定の本文へ
  const [shownPath, setShownPath] = useState(pathname)
  if (shownPath !== pathname) {
    setShownPath(pathname)
    setOpen(false)
  }

  // 開いたら最初の項目へ, 閉じたらフォーカスを決めた先へ移す. 中にあったフォーカスが
  // 消えた (body に落ちた) ときだけ移し, 外の要素へ移ったフォーカスは奪わない
  const opened = useRef(false)
  useEffect(() => {
    if (open) {
      opened.current = true
      panel.current?.querySelector<HTMLElement>('a')?.focus()
      return
    }
    if (!opened.current) return
    opened.current = false
    const focus = closeFocus.current
    closeFocus.current = 'main'
    const lost = document.activeElement === null || document.activeElement === document.body
    if (focus === 'button') button.current?.focus()
    else if (focus === 'main' && lost) document.getElementById('main')?.focus()
  }, [open])

  // メニューの外を押したら閉じる
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return
      closeFocus.current = null
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    close('button')
  }
  const onBlur = (event: FocusEvent) => {
    if (!open || root.current?.contains(event.relatedTarget as Node | null)) return
    close(null)
  }
  const label = open ? '移動のメニューを閉じる' : '移動のメニューを開く'
  const Icon = open ? X : Menu

  return (
    <div ref={root} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        // 押してもフォーカスを動かさない (中の項目のフォーカスが外れて閉じ, click で
        // また開くのを防ぐ. ボタンを押してもフォーカスが移らないブラウザとそろえる)
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => (open ? close('button') : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // 印の数も名前に含める (閉じたままでも実行中のジョブが分かるように)
        aria-label={runningJobs > 0 ? `${label} (${runningJobs} 件のジョブが実行中)` : label}
        className="flex items-center gap-1.5 rounded-lg p-2 text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Icon className="size-4" aria-hidden />
        {runningJobs > 0 && (
          <span
            className="tabular rounded-full bg-accent-strong px-1.5 text-xs text-white"
            aria-hidden
          >
            {runningJobs}
          </span>
        )}
      </button>
      {open && (
        <nav
          ref={panel}
          id={panelId}
          aria-label="移動"
          // 中の文字を押してもフォーカスが外へ出たとみなして閉じないように, 中で受け止める
          tabIndex={-1}
          className="absolute inset-x-0 top-full z-30 flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto border-b border-line bg-surface px-2 py-3 shadow-lg outline-none"
        >
          {/* 今の画面の項目を選んでも経路は替わらないので, 選んだら閉じて本文へ */}
          <NavItems onNavigate={() => close('main')} />
        </nav>
      )}
    </div>
  )
}

/** 左のサイドバーと本文の枠 */
export function Layout() {
  // 殻の下では, アプリの名前と明暗の切り替えを殻の上の帯が持つ
  const { embedded } = useStage()

  return (
    <div className="flex h-full">
      {/* キーボードで左のプロジェクトの一覧を飛ばして本文へ (フォーカスしたときだけ見える) */}
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:outline-2 focus:outline-accent"
      >
        本文へ移る
      </a>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
        {!embedded && (
          <div className="flex items-center justify-between px-4 py-4">
            <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <img src={logo} alt="" className="size-6" />
              ML-Dashboard
            </NavLink>
            <ThemeToggle />
          </div>
        )}
        <nav
          aria-label="移動"
          className={clsx(
            'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4',
            embedded && 'pt-4',
          )}
        >
          <NavItems />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 狭い画面ではサイドバーの代わりに上の帯に移動のメニューを出す. 殻の下では
            アプリの名前と明暗の切り替えを殻の帯が持つので, メニューだけを出す */}
        <header
          className={clsx(
            'relative flex items-center gap-2 border-b border-line bg-surface md:hidden',
            embedded ? 'px-2 py-1' : 'px-2 py-2',
          )}
        >
          <NavMenu />
          {!embedded && (
            <>
              <NavLink to="/" className="flex items-center gap-2 font-semibold">
                <img src={logo} alt="" className="size-6" />
                ML-Dashboard
              </NavLink>
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </>
          )}
        </header>
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
