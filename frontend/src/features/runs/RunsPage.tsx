import clsx from 'clsx'
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  ChartScatter,
  PackageCheck,
  GitCompareArrows,
  Play,
  Search,
  Trophy,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import {
  encodeRunId,
  type GuardCheck,
  type RunNote,
  type RunStatus,
  type RunSummary,
} from '../../api/client'
import { useNotes, useProject, useRuns, useSaveNote } from '../../api/hooks'
import {
  Button,
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  StatTile,
  StatusBadge,
} from '../../components/ui'
import {
  EVALUATION_SORT_PREFIX,
  GUARD_LABELS,
  MAX_LIST_COLUMNS,
  NO_COLUMNS,
  chooseColumns,
  collectColumns,
  findValue,
  initialDesc,
  matchesValueFilters,
  parseValueFilters,
  type EvaluationColumn,
} from '../../lib/evaluations'
import { formatDateTime, formatDuration, formatMetric, formatRelative } from '../../lib/format'
import { MAX_COMPARE, summarizeDiff } from '../../lib/metrics'
import { modelKey, modelLabels } from '../../lib/modelGroups'
import { ReadinessCard } from '../projects/ReadinessCard'
import { StarButton } from '../run/NotePanel'
import {
  ColumnLabel,
  EvaluationCell,
  EvaluationColumnPicker,
  GuardBadge,
} from './EvaluationColumns'

// 並べ替えの名前. 評価の列は ev:<評価の名前>:<列>
type FixedSortKey = 'started' | 'best' | 'duration' | 'epochs'
type SortKey = FixedSortKey | `${typeof EVALUATION_SORT_PREFIX}${string}`
const SORT_KEYS: FixedSortKey[] = ['started', 'best', 'duration', 'epochs']

const GUARD_FILTERS: GuardCheck['state'][] = ['dropped', 'kept', 'unknown']

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
  if (key.startsWith(EVALUATION_SORT_PREFIX)) {
    const value = findValue(run.evaluations, key.slice(EVALUATION_SORT_PREFIX.length))
    return value?.value ?? Number.NaN
  }
  return Number.NaN
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
  label: ReactNode
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
        className={clsx(
          'inline-flex items-center gap-1 text-left hover:text-ink',
          active && 'text-ink',
        )}
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
  const notes = useNotes(projectId)
  const saveNote = useSaveNote(projectId)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  // 絞り込みと並べ替えも URL に残し, 詳細を開いて戻っても同じ一覧にする
  // (q: 文字, status: 状態, star: 星だけ, tag: タグ, sort と desc: 並べ替え)
  const update = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )
  // 検索の文字は入力欄で持ち, 打ち終えてから URL に書く (打つたびに URL を
  // 書き換えると, 入力の位置や変換中の文字が崩れるため). 戻るなどで URL が
  // 変わった場合は入力欄を合わせる
  const urlQuery = params.get('q') ?? ''
  const [query, setQueryText] = useState(urlQuery)
  const [seenQuery, setSeenQuery] = useState(urlQuery)
  if (seenQuery !== urlQuery) {
    setSeenQuery(urlQuery)
    setQueryText(urlQuery)
  }
  const setQuery = (value: string) => setQueryText(value)
  useEffect(() => {
    if (query === urlQuery) return
    const timer = window.setTimeout(() => {
      setSeenQuery(query)
      update({ q: query })
    }, 400)
    return () => window.clearTimeout(timer)
  })
  const statusParam = params.get('status')
  const status: RunStatus | 'all' = STATUS_FILTERS.some((item) => item.id === statusParam)
    ? (statusParam as RunStatus)
    : 'all'
  const setStatus = (value: RunStatus | 'all') => update({ status: value === 'all' ? null : value })
  const starredOnly = params.get('star') === '1'
  const setStarredOnly = (change: (value: boolean) => boolean) =>
    update({ star: change(starredOnly) ? '1' : null })
  const tag = params.get('tag')
  const setTag = (change: (value: string | null) => string | null) => update({ tag: change(tag) })
  const guardParam = params.get('guard')
  const guardFilter = GUARD_FILTERS.find((item) => item === guardParam) ?? null
  const setGuardFilter = (value: GuardCheck['state'] | null) => update({ guard: value })

  // 比較に選んだ実験は URL に残し, 比較から戻っても選んだままにする
  // 読み込んだ後は, 一覧に無い ID と重複を除外
  const known = runs.data ? new Set(runs.data.map((run) => run.id)) : null
  const selected = [...new Set(params.getAll('sel'))].filter((id) => !known || known.has(id))
  const setSelected = (ids: string[]) => {
    // 絞り込みと並べ替えの値は残し, 選んだ実験だけを置き換える
    const next = new URLSearchParams(params)
    next.delete('sel')
    for (const id of ids) next.append('sel', id)
    setParams(next, { replace: true })
  }

  const all = useMemo(() => runs.data ?? [], [runs.data])
  // テスト用の評価の列と, 並べる列 (URL の ev. 選んでいなければ先頭の列)
  const evaluationColumns = useMemo(() => collectColumns(all.map((run) => run.evaluations)), [all])
  const requestedColumns = params.getAll('ev')
  const shownColumns = chooseColumns(evaluationColumns, requestedColumns, MAX_LIST_COLUMNS)
  const setShownColumns = (keys: string[]) => {
    const next = new URLSearchParams(params)
    next.delete('ev')
    // 全て外した場合は, 並べない印を残す (先頭の列に戻さないため)
    for (const key of keys.length > 0 ? keys : [NO_COLUMNS]) next.append('ev', key)
    setParams(next, { replace: true })
  }
  // 並べている評価の列 (並べていない列の並べ替えは捨てる. 何で並んでいるか分かるように)
  const findColumn = (key: string): EvaluationColumn | undefined =>
    key.startsWith(EVALUATION_SORT_PREFIX)
      ? shownColumns.find((column) => column.key === key.slice(EVALUATION_SORT_PREFIX.length))
      : undefined
  const hasGuard = all.some((run) => run.evaluations?.guard)
  // 使ったモデルの定義の名前 (同じ名前で中身の違う定義は sha256 の先頭で見分ける)
  const hasModel = all.some((run) => run.model)
  const labelOfModel = modelLabels(all.map((run) => run.model))
  const noticed = all.filter((run) => run.evaluations?.notice)
  // <列><比べ方><数> の語は評価の値で, 他の語は文字で絞り込む
  const { filters, words, unresolved } = parseValueFilters(query, evaluationColumns)

  const sortParam = params.get('sort') ?? ''
  const sortKey: SortKey =
    SORT_KEYS.includes(sortParam as FixedSortKey) || findColumn(sortParam)
      ? (sortParam as SortKey)
      : 'started'
  const sortDesc = params.get('desc') !== '0'
  const sort = { key: sortKey, desc: sortDesc }
  const setSort = (
    change: (previous: { key: SortKey; desc: boolean }) => { key: SortKey; desc: boolean },
  ) => {
    const next = change(sort)
    update({ sort: next.key === 'started' ? null : next.key, desc: next.desc ? null : '0' })
  }
  // 実験の元にした default のうち一番多いもの (違う default が 2 種類以上の
  // 場合だけ. 違うものに印を付ける)
  const commonDefault = useMemo(() => mostCommonDefault(all), [all])
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

  // 絞り込みと並べ替え (URL の値から求めるので, 毎回計算する. 軽い計算)
  const visible = (() => {
    const filtered = all.filter((run) => {
      if (status !== 'all' && run.status !== status) return false
      if (guardFilter && run.evaluations?.guard?.state !== guardFilter) return false
      if (!matchesValueFilters(run.evaluations, filters)) return false
      const note = notes.data?.[run.id]
      if (starredOnly && !note?.starred) return false
      if (tag && !note?.tags.includes(tag)) return false
      // メモとタグの文字でも絞り込めるように対象に追加
      const text = [
        run.id,
        ...summarizeDiff(run.diff),
        otherDefault(run, commonDefault) ?? '',
        run.model ? (labelOfModel.get(modelKey(run.model)) ?? '') : '',
        note?.note ?? '',
        ...(note?.tags ?? []),
      ]
        .join(' ')
        .toLowerCase()
      return words.every((word) => text.includes(word))
    })
    return [...filtered].sort((a, b) =>
      compareValues(sortValue(a, sortKey), sortValue(b, sortKey), sortDesc),
    )
  })()

  // 今ある実験に書かれたタグの一覧と星の数 (消えた実験のメモは数えない)
  const { allTags, starredCount } = useMemo(() => {
    const present = all.flatMap((run) => {
      const note = notes.data?.[run.id]
      return note ? [note] : []
    })
    // タグは使った実験の数が多い順 (同じなら数字を数として並べる)
    const tagCounts = new Map<string, number>()
    for (const note of present) {
      for (const item of note.tags) tagCounts.set(item, (tagCounts.get(item) ?? 0) + 1)
    }
    return {
      allTags: [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja', { numeric: true }))
        .map(([item, count]) => ({ tag: item, count })),
      starredCount: present.filter((note) => note.starred).length,
    }
  }, [all, notes.data])
  // 絞り込み中のタグは, そのタグが無くなっても外せるように一覧に残す
  const [showAllTags, setShowAllTags] = useState(false)
  const TAG_LIMIT = 12
  const tagChips =
    tag && !allTags.some((item) => item.tag === tag) ? [...allTags, { tag, count: 0 }] : allTags
  const shownTags = showAllTags
    ? tagChips
    : tagChips.filter((item, index) => index < TAG_LIMIT || item.tag === tag)

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: all.length }
    for (const run of all) result[run.status] = (result[run.status] ?? 0) + 1
    return result
  }, [all])
  const guardCounts = useMemo(() => {
    const result: Partial<Record<GuardCheck['state'], number>> = {}
    for (const run of all) {
      const state = run.evaluations?.guard?.state
      if (state) result[state] = (result[state] ?? 0) + 1
    }
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

  const visibleIds = new Set(visible.map((run) => run.id))
  const hiddenSelected = selected.filter((id) => !visibleIds.has(id)).length

  const totalTime = all.reduce((sum, run) => sum + (run.duration_sec ?? 0), 0)
  const full = selected.length >= MAX_COMPARE

  // 評価の列は, 初めに押したときに良い順
  const onSort = (key: SortKey) =>
    setSort((previous) => ({
      key,
      desc: previous.key === key ? !previous.desc : initialDesc(findColumn(key)),
    }))

  const toggle = (id: string) =>
    setSelected(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : full
          ? selected
          : [...selected, id],
    )

  const compare = () => {
    // 選んだ評価の列も比較に引き継ぐ
    const next = new URLSearchParams()
    for (const id of selected) next.append('run', id)
    for (const key of requestedColumns) next.append('ev', key)
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
              to={`/projects/${projectId}/requirements`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
            >
              <PackageCheck className="size-4" aria-hidden />
              追加の依存
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

      <ReadinessCard projectId={projectId} />

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
            placeholder={
              (hasModel ? '名前, モデルの定義, ' : '名前, ') +
              (evaluationColumns.length > 0
                ? 'config の差分, 評価の値で絞り込む (例: lr=0.001, accuracy>=0.9)'
                : 'config の差分で絞り込む (例: lr=0.001)')
            }
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="状態で絞り込む">
          {/* 選んでいる状態は, 実験が無くなっても出す (何で絞り込んでいるか分かるように) */}
          {STATUS_FILTERS.filter(
            (item) => item.id === 'all' || counts[item.id] || item.id === status,
          ).map((item) => (
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
      {(hasGuard || guardFilter || evaluationColumns.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {(hasGuard || guardFilter) && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="守る指標で絞り込む">
              <span className="self-center text-xs text-ink-3">守る指標:</span>
              {GUARD_FILTERS.filter((item) => guardCounts[item] || item === guardFilter).map(
                (item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setGuardFilter(guardFilter === item ? null : item)}
                    aria-pressed={guardFilter === item}
                    className={clsx(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      guardFilter === item
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-line text-ink-2 hover:bg-surface-2',
                    )}
                  >
                    {GUARD_LABELS[item]} <span className="tabular">{guardCounts[item] ?? 0}</span>
                  </button>
                ),
              )}
            </div>
          )}
          {evaluationColumns.length > 0 && (
            <div className="ml-auto">
              <EvaluationColumnPicker
                columns={evaluationColumns}
                chosen={shownColumns}
                limit={MAX_LIST_COLUMNS}
                onChange={setShownColumns}
              />
            </div>
          )}
        </div>
      )}
      {unresolved.length > 0 && (
        <p className="mb-2 text-xs text-ink-3">
          {unresolved.join(', ')} の列が無いか, 2 つ以上の評価にあるので, 文字で絞り込んでいます.
          値で絞り込むには「評価の列」の名前 (評価の名前:列) で書いてください.
        </p>
      )}
      {noticed.length > 0 && (
        <details className="mb-2 text-xs text-ink-3">
          <summary className="cursor-pointer">
            評価の一部を出せない実験が {noticed.length} 件あります (開くと実験ごとの理由)
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {noticed.map((run) => (
              <li key={run.id} className="break-all">
                <span className="font-mono">{run.id}</span>: {run.evaluations?.notice}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(tagChips.length > 0 || starredCount > 0 || starredOnly) && (
        <div
          className="mb-3 flex flex-wrap items-center gap-1"
          role="group"
          aria-label="星とタグで絞り込む"
        >
          {(starredCount > 0 || starredOnly) && (
            <button
              type="button"
              onClick={() => setStarredOnly((value) => !value)}
              aria-pressed={starredOnly}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium',
                starredOnly
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line text-ink-2 hover:bg-surface-2',
              )}
            >
              <span aria-hidden>★ </span>星付き <span className="tabular">{starredCount}</span>
            </button>
          )}
          {shownTags.map(({ tag: item, count }) => (
            <button
              key={item}
              type="button"
              onClick={() => setTag((current) => (current === item ? null : item))}
              aria-pressed={tag === item}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs',
                tag === item
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line text-ink-2 hover:bg-surface-2',
              )}
            >
              <span aria-hidden># </span>
              <span className="inline-block max-w-40 truncate align-bottom" title={item}>
                {item}
              </span>{' '}
              <span className="tabular text-ink-3">{count}</span>
            </button>
          ))}
          {tagChips.length > TAG_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAllTags((value) => !value)}
              className="px-2 py-1 text-xs text-accent-text hover:underline"
            >
              {showAllTags ? 'たたむ' : `他 ${tagChips.length - shownTags.length} 個`}
            </button>
          )}
        </div>
      )}
      {hiddenSelected > 0 && (
        <p className="mb-2 text-xs text-ink-3">
          比較に選んだ実験のうち {hiddenSelected} 件は絞り込みで隠れています.
        </p>
      )}
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
          <table
            className="w-full text-sm"
            style={{
              minWidth:
                860 + shownColumns.length * 120 + (hasGuard ? 120 : 0) + (hasModel ? 140 : 0),
            }}
          >
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-ink-3">
              <tr>
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">比較に選ぶ</span>
                </th>
                <th className="w-8 py-2">
                  <span className="sr-only">星</span>
                </th>
                <th className="px-3 py-2 font-medium">状態</th>
                <SortHeader label="実験" id="started" sort={sort} onSort={onSort} />
                {hasModel && <th className="px-3 py-2 font-medium">モデルの定義</th>}
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
                {hasGuard && <th className="px-3 py-2 font-medium">守る指標</th>}
                {shownColumns.map((column) => (
                  <SortHeader
                    key={column.key}
                    label={<ColumnLabel column={column} />}
                    id={`${EVALUATION_SORT_PREFIX}${column.key}`}
                    sort={sort}
                    onSort={onSort}
                    className="text-right"
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  commonDefault={commonDefault}
                  note={notes.data?.[run.id]}
                  onSaveNote={(note) => saveNote.mutate({ runId: run.id, note })}
                  projectId={projectId}
                  checked={selected.includes(run.id)}
                  disabled={!selected.includes(run.id) && full}
                  isBest={
                    bestRun?.best != null &&
                    run.name === bestRun.name &&
                    run.best?.monitor === bestRun.best.monitor &&
                    run.best.value === bestRun.best.value
                  }
                  onToggle={() => toggle(run.id)}
                  hasGuard={hasGuard}
                  modelLabel={
                    hasModel
                      ? run.model
                        ? (labelOfModel.get(modelKey(run.model)) ?? '')
                        : ''
                      : null
                  }
                  columns={shownColumns}
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
  commonDefault,
  note,
  onSaveNote,
  projectId,
  checked,
  disabled,
  isBest,
  onToggle,
  hasGuard,
  modelLabel,
  columns,
}: {
  run: RunSummary
  /** 一覧で一番多い default (印を付けない場合は null) */
  commonDefault: string | null
  note: RunNote | undefined
  onSaveNote: (note: RunNote) => void
  projectId: string
  checked: boolean
  disabled: boolean
  isBest: boolean
  onToggle: () => void
  /** 守る指標の列を出すか */
  hasGuard: boolean
  /** モデルの定義の名前. 列を出さない場合は null, 記録の無い実験は空 */
  modelLabel: string | null
  /** 並べる評価の列 */
  columns: EvaluationColumn[]
}) {
  const diff = summarizeDiff(run.diff)
  // 一覧で一番多い default と違う default を元にした実験は, 差分の基準が
  // 違うことを示す
  const otherBase = otherDefault(run, commonDefault)
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
      <td className="py-2.5">
        <StarButton
          starred={note?.starred ?? false}
          onToggle={() =>
            onSaveNote({
              note: note?.note ?? '',
              tags: note?.tags ?? [],
              starred: !(note?.starred ?? false),
            })
          }
          label={`${run.id} に星を付ける`}
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
        {note && (note.tags.length > 0 || note.note) && (
          <div className="mt-0.5 flex max-w-72 flex-wrap items-center gap-1">
            {note.tags.slice(0, 3).map((item) => (
              <span
                key={item}
                className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent-text"
              >
                <span aria-hidden># </span>
                {item}
              </span>
            ))}
            {note.tags.length > 3 && (
              <span className="text-[11px] text-ink-3" title={note.tags.slice(3).join(', ')}>
                +{note.tags.length - 3}
              </span>
            )}
            {note.note && (
              <span className="truncate text-[11px] text-ink-3" title={note.note}>
                {note.note}
              </span>
            )}
          </div>
        )}
        {run.error && (
          <div className="max-w-72 truncate text-xs text-critical-text" title={run.error}>
            {run.error}
          </div>
        )}
      </td>
      {modelLabel !== null && (
        <td className="max-w-48 px-3 py-2.5">
          {modelLabel ? (
            <span
              className="font-mono text-xs break-all text-ink-2"
              title={run.model ? `定義: ${run.model.path}` : undefined}
            >
              {modelLabel}
            </span>
          ) : (
            <span className="text-xs text-ink-3">—</span>
          )}
        </td>
      )}
      <td className="max-w-80 px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          {otherBase && (
            <span
              className="max-w-full truncate rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3"
              title={`default: ${otherBase} からの差分`}
            >
              default: {otherBase.split('/').pop()}
            </span>
          )}
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
      <td className="tabular px-3 py-2.5 text-right whitespace-nowrap">
        {run.epochs}
        {run.planned_epochs != null && <span className="text-ink-3"> / {run.planned_epochs}</span>}
        {run.early_stopped_epoch != null && (
          <div className="text-[11px] text-ink-3">Early Stopping</div>
        )}
        {progress && (
          <div className="text-[11px] text-accent-text">エポック {progress.epoch} を学習中</div>
        )}
      </td>
      <td className="tabular px-3 py-2.5 text-right whitespace-nowrap">
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
      <td className="tabular px-3 py-2.5 text-right whitespace-nowrap text-ink-2">
        {formatDuration(run.duration_sec)}
      </td>
      {hasGuard && (
        <td className="px-3 py-2.5">
          <GuardBadge guard={run.evaluations?.guard} />
        </td>
      )}
      {columns.map((column) => (
        <td key={column.key} className="tabular px-3 py-2.5 text-right whitespace-nowrap">
          <EvaluationCell value={findValue(run.evaluations, column.key)} />
        </td>
      ))}
    </tr>
  )
}

/** パスの書き方をそろえる (区切りを / にし, 先頭の ./ を除く) */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
}

/** 実験の元にした default のうち一番多いもの (2 種類以上ある場合だけ) */
function mostCommonDefault(runs: RunSummary[]): string | null {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (!run.source?.default) continue
    const path = normalizePath(run.source.default)
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  if (counts.size < 2) return null
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
}

/** 一番多い default と違う default を元にした実験の, その default */
function otherDefault(run: RunSummary, common: string | null): string | null {
  if (!common || !run.source?.default) return null
  const path = normalizePath(run.source.default)
  return path !== common ? path : null
}
