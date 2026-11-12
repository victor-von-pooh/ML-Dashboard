import clsx from 'clsx'
import { ArrowDown, ArrowUp, FlaskConical, GitCompareArrows, Search, Trophy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { encodeRunId, type RunStatus, type RunSummary } from '../../api/client'
import { useProject, useRuns } from '../../api/hooks'
import {
  Button,
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  StatTile,
  StatusBadge,
} from '../../components/ui'
import { formatDateTime, formatDuration, formatMetric, formatRelative } from '../../lib/format'
import { summarizeDiff } from '../../lib/metrics'

type SortKey = 'started' | 'best' | 'duration' | 'epochs'

const STATUS_FILTERS: { id: RunStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'completed', label: '完了' },
  { id: 'running', label: '実行中' },
  { id: 'stopped', label: '中断' },
  { id: 'failed', label: '失敗' },
  { id: 'unknown', label: '未完了' },
]

// 比べられる実験の数の上限 (グラフの系列の色の数)
const MAX_COMPARE = 8

/** 並べ替えに使う値 */
function sortValue(run: RunSummary, key: SortKey): number {
  switch (key) {
    case 'started':
      return new Date(run.started_at).getTime()
    case 'best':
      if (!run.best) return Number.NaN
      return run.best.mode === 'max' ? run.best.value : -run.best.value
    case 'duration':
      return run.duration_sec ?? Number.NaN
    case 'epochs':
      return run.epochs
  }
}

/** 同じ指標で比べたときに最も良い実験 */
function findBestRun(runs: RunSummary[]): RunSummary | undefined {
  const withBest = runs.filter((run) => run.best)
  const monitor = withBest[0]?.best?.monitor
  const comparable = withBest.filter((run) => run.best?.monitor === monitor)
  return comparable.reduce<RunSummary | undefined>((best, run) => {
    if (!best?.best || !run.best) return run
    const better =
      run.best.mode === 'max' ? run.best.value > best.best.value : run.best.value < best.best.value
    return better ? run : best
  }, undefined)
}

function SortHeader({
  label,
  id,
  sort,
  onSort,
  className,
}: {
  label: string
  id: SortKey
  sort: { key: SortKey; desc: boolean }
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort.key === id
  const Icon = sort.desc ? ArrowDown : ArrowUp
  return (
    <th className={clsx('px-3 py-2 font-medium', className)}>
      <button
        type="button"
        onClick={() => onSort(id)}
        className={clsx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}
      >
        {label}
        {active && <Icon className="size-3" aria-hidden />}
      </button>
    </th>
  )
}

export function RunsPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  const runs = useRuns(projectId)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<RunStatus | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'started', desc: true })
  const [selected, setSelected] = useState<string[]>([])

  const all = useMemo(() => runs.data ?? [], [runs.data])
  const bestRun = useMemo(() => findBestRun(all), [all])

  // 絞り込みと並べ替え
  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = all.filter((run) => {
      if (status !== 'all' && run.status !== status) return false
      const text = [run.id, ...summarizeDiff(run.diff)].join(' ').toLowerCase()
      return words.every((word) => text.includes(word))
    })
    return [...filtered].sort((a, b) => {
      const x = sortValue(a, sort.key)
      const y = sortValue(b, sort.key)
      if (Number.isNaN(x)) return 1
      if (Number.isNaN(y)) return -1
      return sort.desc ? y - x : x - y
    })
  }, [all, query, status, sort])

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: all.length }
    for (const run of all) result[run.status] = (result[run.status] ?? 0) + 1
    return result
  }, [all])

  const totalTime = all.reduce((sum, run) => sum + (run.duration_sec ?? 0), 0)

  const onSort = (key: SortKey) =>
    setSort((previous) => ({ key, desc: previous.key === key ? !previous.desc : true }))

  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length < MAX_COMPARE
          ? [...previous, id]
          : previous,
    )

  const compare = () => {
    const params = new URLSearchParams()
    for (const id of selected) params.append('run', id)
    navigate(`/projects/${projectId}/compare?${params.toString()}`)
  }

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/">プロジェクト</Link>}
        title={project.data?.name ?? projectId}
        subtitle={<span className="font-mono text-xs">{project.data?.path}</span>}
        actions={
          <Button
            variant="primary"
            icon={GitCompareArrows}
            disabled={selected.length < 2}
            onClick={compare}
            title={selected.length < 2 ? '2 つ以上の実験を選んでください' : undefined}
          >
            比較 {selected.length > 0 && `(${selected.length})`}
          </Button>
        }
      />
      {project.error && <ErrorBox error={project.error} />}

      {all.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="実験" value={all.length} hint={`完了 ${counts.completed ?? 0}`} />
          <StatTile
            label="ベストの実験"
            value={bestRun?.best ? formatMetric(bestRun.best.value) : '—'}
            hint={bestRun?.best ? `${bestRun.best.monitor} · ${bestRun.id}` : undefined}
          />
          <StatTile
            label="最新の実験"
            value={all[0] ? formatRelative(all[0].started_at) : '—'}
            hint={all[0]?.id}
          />
          <StatTile label="学習時間の合計" value={formatDuration(totalTime)} />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-ink-3" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="名前や config の差分で絞り込む (例: lr=0.001)"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.filter((item) => item.id === 'all' || counts[item.id]).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStatus(item.id)}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                status === item.id
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-ink-2 hover:bg-surface-2',
              )}
            >
              {item.label} <span className="tabular">{counts[item.id] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {runs.isPending && <Spinner />}
      {runs.error && <ErrorBox error={runs.error} />}
      {runs.data?.length === 0 && (
        <EmptyState icon={FlaskConical} title="実験がありません">
          ML-Found で学習すると, 出力先 ({project.data?.output_dirs.join(", ")}) の実験がここに表示されます.
        </EmptyState>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-ink-3">
              <tr>
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">比較に選ぶ</span>
                </th>
                <th className="px-3 py-2 font-medium">状態</th>
                <SortHeader label="実験" id="started" sort={sort} onSort={onSort} />
                <th className="px-3 py-2 font-medium">default との差分</th>
                <SortHeader
                  label="エポック"
                  id="epochs"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortHeader
                  label="ベスト"
                  id="best"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
                <SortHeader
                  label="学習時間"
                  id="duration"
                  sort={sort}
                  onSort={onSort}
                  className="text-right"
                />
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const diff = summarizeDiff(run.diff)
                const checked = selected.includes(run.id)
                return (
                  <tr
                    key={run.id}
                    className={clsx(
                      'border-b border-line last:border-b-0 hover:bg-surface-2/60',
                      checked && 'bg-accent-soft/60',
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && selected.length >= MAX_COMPARE}
                        onChange={() => toggle(run.id)}
                        aria-label={`${run.id} を比較に選ぶ`}
                        className="size-4 accent-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        to={`/projects/${projectId}/runs/${encodeRunId(run.id)}`}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {run.name}
                      </Link>
                      <div className="tabular text-xs text-ink-3">
                        {formatDateTime(run.started_at)}
                      </div>
                    </td>
                    <td className="max-w-80 px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {diff.slice(0, 4).map((item) => (
                          <span
                            key={item}
                            className="max-w-full truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2"
                            title={item}
                          >
                            {item}
                          </span>
                        ))}
                        {diff.length > 4 && (
                          <span className="text-[11px] text-ink-3" title={diff.slice(4).join('\n')}>
                            +{diff.length - 4}
                          </span>
                        )}
                        {diff.length === 0 && <span className="text-xs text-ink-3">なし</span>}
                      </div>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {run.epochs}
                      {run.planned_epochs != null && (
                        <span className="text-ink-3"> / {run.planned_epochs}</span>
                      )}
                      {run.early_stopped_epoch != null && (
                        <div className="text-[11px] text-ink-3">Early Stopping</div>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {run.best ? (
                        <>
                          <div className="flex items-center justify-end gap-1 font-medium">
                            {run.id === bestRun?.id && (
                              <Trophy
                                className="size-3.5 text-warning"
                                aria-label="プロジェクトのベスト"
                              />
                            )}
                            {formatMetric(run.best.value)}
                          </div>
                          <div className="text-[11px] text-ink-3">
                            {run.best.monitor} @ {run.best.epoch}
                          </div>
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-ink-2">
                      {formatDuration(run.duration_sec)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {all.length > 0 && visible.length === 0 && (
        <p className="py-10 text-center text-sm text-ink-3">条件に合う実験はありません.</p>
      )}
    </>
  )
}
