import clsx from 'clsx'
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  ChartScatter,
  GitCompareArrows,
  Play,
  Search,
  Trophy,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

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
import { MAX_COMPARE, summarizeDiff } from '../../lib/metrics'

type SortKey = 'started' | 'best' | 'duration' | 'epochs'

const STATUS_FILTERS: { id: RunStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'completed', label: '完了' },
  { id: 'running', label: '実行中' },
  { id: 'stopped', label: '中断' },
  { id: 'failed', label: '失敗' },
  { id: 'unknown', label: '未完了' },
]

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

/** 欠けた値を常に末尾に置く比較 */
function compareValues(x: number, y: number, desc: boolean): number {
  if (Number.isNaN(x) && Number.isNaN(y)) return 0
  if (Number.isNaN(x)) return 1
  if (Number.isNaN(y)) return -1
  return desc ? y - x : x - y
}

/** 最新の実験と同じ名前と指標の実験の中で最も良い実験 */
function findBestRun(runs: RunSummary[], latest?: RunSummary): RunSummary | undefined {
  const comparable = runs.filter(
    (run) => run.best && run.name === latest?.name && run.best.monitor === latest?.best?.monitor,
  )
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
    <th
      className={clsx('px-3 py-2 font-medium', className)}
      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
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

/** プロジェクトが変わったら状態を作り直すように, プロジェクトごとに描き分ける */
export function ProjectRunsPage() {
  const { projectId = '' } = useParams()
  return <RunsPage key={projectId} projectId={projectId} />
}

function RunsPage({ projectId }: { projectId: string }) {
  const project = useProject(projectId)
  const runs = useRuns(projectId)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<RunStatus | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'started', desc: true })

  // 比較に選んだ実験は URL に残し, 比較から戻っても選んだままにする
  // 読み込んだ後は, 一覧に無い ID と重複を除外
  const known = runs.data ? new Set(runs.data.map((run) => run.id)) : null
  const selected = [...new Set(params.getAll('sel'))].filter((id) => !known || known.has(id))
  const setSelected = (ids: string[]) => {
    const next = new URLSearchParams()
    for (const id of ids) next.append('sel', id)
    setParams(next, { replace: true })
  }

  const all = useMemo(() => runs.data ?? [], [runs.data])
  const latest = useMemo(
    () =>
      all.reduce<RunSummary | undefined>(
        (newest, run) =>
          !newest || new Date(run.started_at) > new Date(newest.started_at) ? run : newest,
        undefined,
      ),
    [all],
  )
  const bestRun = useMemo(() => findBestRun(all, latest), [all, latest])

  // 絞り込みと並べ替え
  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = all.filter((run) => {
      if (status !== 'all' && run.status !== status) return false
      const text = [run.id, ...summarizeDiff(run.diff)].join(' ').toLowerCase()
      return words.every((word) => text.includes(word))
    })
    return [...filtered].sort((a, b) =>
      compareValues(sortValue(a, sort.key), sortValue(b, sort.key), sort.desc),
    )
  }, [all, query, status, sort])

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: all.length }
    for (const run of all) result[run.status] = (result[run.status] ?? 0) + 1
    return result
  }, [all])

  if (project.error) {
    return (
      <>
        <PageHeader breadcrumb={<Link to="/">プロジェクト</Link>} title={projectId} />
        <ErrorBox error={project.error}>
          <Link to="/" className="mt-1 inline-block text-accent-text hover:underline">
            プロジェクトの一覧に戻る
          </Link>
        </ErrorBox>
      </>
    )
  }

  const totalTime = all.reduce((sum, run) => sum + (run.duration_sec ?? 0), 0)
  const full = selected.length >= MAX_COMPARE

  const onSort = (key: SortKey) =>
    setSort((previous) => ({ key, desc: previous.key === key ? !previous.desc : true }))

  const toggle = (id: string) =>
    setSelected(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : full
          ? selected
          : [...selected, id],
    )

  const compare = () => {
    const next = new URLSearchParams()
    for (const id of selected) next.append('run', id)
    navigate(`/projects/${projectId}/compare?${next.toString()}`)
  }

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/">プロジェクト</Link>}
        title={project.data?.name ?? projectId}
        subtitle={<span className="font-mono text-xs">{project.data?.path}</span>}
        actions={
          <>
            <Link
              to={`/projects/${projectId}/analysis`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
            >
              <ChartScatter className="size-4" aria-hidden />
              分析
            </Link>
            <Link
              to={`/projects/${projectId}/launch`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
            >
              <Play className="size-4" aria-hidden />
              学習を起動
            </Link>
            {selected.length > 0 && (
              <Button variant="ghost" onClick={() => setSelected([])}>
                選択を解除
              </Button>
            )}
            <Button
              variant="primary"
              icon={GitCompareArrows}
              disabled={selected.length < 2}
              onClick={compare}
              title={selected.length < 2 ? '2 つ以上の実験を選んでください' : undefined}
            >
              比較 {selected.length > 0 && `(${selected.length})`}
            </Button>
          </>
        }
      />

      {all.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="実験" value={all.length} hint={`完了 ${counts.completed ?? 0}`} />
          <StatTile
            label={bestRun?.best ? `ベスト (${bestRun.name})` : 'ベスト'}
            value={bestRun?.best ? formatMetric(bestRun.best.value) : '—'}
            hint={bestRun?.best ? `${bestRun.best.monitor} · ${bestRun.id}` : undefined}
          />
          <StatTile
            label="最新の実験"
            value={latest ? formatRelative(latest.started_at) : '—'}
            hint={latest?.id}
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
            aria-label="実験を絞り込む"
            placeholder="名前や config の差分で絞り込む (例: lr=0.001)"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="状態で絞り込む">
          {STATUS_FILTERS.filter((item) => item.id === 'all' || counts[item.id]).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStatus(item.id)}
              aria-pressed={status === item.id}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                status === item.id
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line text-ink-2 hover:bg-surface-2',
              )}
            >
              {item.label} <span className="tabular">{counts[item.id] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
      {full && (
        <p className="mb-2 text-xs text-ink-3">
          比較できるのは {MAX_COMPARE} つまでです. 他を選ぶには選択を外してください.
        </p>
      )}

      {runs.isPending && <Spinner />}
      {runs.error && <ErrorBox error={runs.error} />}
      {runs.data?.length === 0 && (
        <EmptyState icon={FlaskConical} title="実験がありません">
          ML-Found で学習すると, 出力先 ({project.data?.output_dirs.join(', ')})
          の実験がここに表示されます.
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
              {visible.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  projectId={projectId}
                  checked={selected.includes(run.id)}
                  disabled={!selected.includes(run.id) && full}
                  isBest={run.id === bestRun?.id}
                  onToggle={() => toggle(run.id)}
                />
              ))}
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

function RunRow({
  run,
  projectId,
  checked,
  disabled,
  isBest,
  onToggle,
}: {
  run: RunSummary
  projectId: string
  checked: boolean
  disabled: boolean
  isBest: boolean
  onToggle: () => void
}) {
  const diff = summarizeDiff(run.diff)
  const progress = run.progress
  return (
    <tr
      className={clsx(
        'border-b border-line last:border-b-0 hover:bg-surface-2/60',
        checked && 'bg-accent-soft/60',
      )}
    >
      <td className="px-3 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
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
          className="font-medium text-ink hover:text-accent-text"
        >
          {run.name}
        </Link>
        <div className="tabular text-xs text-ink-3">{formatDateTime(run.started_at)}</div>
        {run.error && (
          <div className="max-w-72 truncate text-xs text-critical-text" title={run.error}>
            {run.error}
          </div>
        )}
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
        {run.planned_epochs != null && <span className="text-ink-3"> / {run.planned_epochs}</span>}
        {run.early_stopped_epoch != null && (
          <div className="text-[11px] text-ink-3">Early Stopping</div>
        )}
        {progress && (
          <div className="text-[11px] text-accent-text">エポック {progress.epoch} を学習中</div>
        )}
      </td>
      <td className="tabular px-3 py-2.5 text-right">
        {run.best ? (
          <>
            <div className="flex items-center justify-end gap-1 font-medium">
              {isBest && (
                <Trophy className="size-3.5 text-warning" aria-label="同じ名前の実験のベスト" />
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
}
