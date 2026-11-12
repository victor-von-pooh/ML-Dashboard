import clsx from 'clsx'
import { FolderKanban, LayoutGrid, ListChecks, Moon, Sun } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'

import { useProjects, useRunningJobCount } from '../api/hooks'
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

/** 左のサイドバーと本文の枠 */
export function Layout() {
  const projects = useProjects()
  const runningJobs = useRunningJobCount()

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex items-center justify-between px-4 py-4">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" className="size-6" />
            ML-Dashboard
          </NavLink>
          <ThemeToggle />
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
          <NavLink to="/" end className={linkClass}>
            <LayoutGrid className="size-4" aria-hidden />
            プロジェクト
          </NavLink>
          <NavLink to="/jobs" className={linkClass}>
            <ListChecks className="size-4" aria-hidden />
            ジョブ
            {runningJobs > 0 && (
              <span className="tabular ml-auto rounded-full bg-accent-strong px-1.5 text-xs text-white">
                {runningJobs}
                <span className="sr-only"> 件が実行中</span>
              </span>
            )}
          </NavLink>
          <div className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">
            Projects
          </div>
          {projects.data?.map((project) => (
            <NavLink key={project.id} to={`/projects/${project.id}`} className={linkClass}>
              <FolderKanban className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{project.name}</span>
              <span className="tabular ml-auto text-xs text-ink-3">{project.run_count}</span>
            </NavLink>
          ))}
          {projects.data?.length === 0 && (
            <p className="px-2.5 text-xs text-ink-3">まだ登録されていません</p>
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 狭い画面ではサイドバーの代わりに上の帯を出す */}
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 md:hidden">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-6" />
            ML-Dashboard
          </NavLink>
          <ThemeToggle />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
