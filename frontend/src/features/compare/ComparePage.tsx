import clsx from 'clsx'
import { ArrowDown, ArrowUp, GitCompareArrows, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { encodeRunId, type History, type RunDetail } from '../../api/client'
import { keys, useHistories, useProject, useRunDetails } from '../../api/hooks'
import { LineChart } from '../../components/LineChart'
import {
  Card,
  DirectionBadge,
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../../components/ui'
import { seriesVar } from '../../lib/colors'
import {
  MAX_COMPARE_COLUMNS,
  NO_COLUMNS,
  chooseColumns,
  collectColumns,
  findValue,
  initialDesc,
  readEvaluationSort,
  writeEvaluationSort,
  type EvaluationColumn,
  type EvaluationSort,
} from '../../lib/evaluations'
import {
  compareLabeler,
  formatDateTime,
  formatAxis,
  formatDuration,
  formatMetric,
  formatValue,
} from '../../lib/format'
import { groupImageSeries, sharedImageSeries } from '../../lib/images'
import { groupByModel } from '../../lib/modelGroups'
import { compareCharts, withoutAxis } from '../../lib/compareCharts'
import {
  EPOCH_AXIS,
  MAX_COMPARE,
  axisLabel,
  axisOptions,
  axisStart,
  diffConfigs,
  flattenConfig,
  hasAxis,
  integerAxis,
} from '../../lib/metrics'
import {
  ColumnLabel,
  EvaluationCell,
  EvaluationColumnPicker,
  GuardBadge,
} from '../runs/EvaluationColumns'
import { ImageCompare } from './ImageCompare'

interface Slot {
  id: string
  color: string
  run?: RunDetail
  history?: History
  error?: unknown
}

export function ComparePage() {
  const { projectId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [showTrain, setShowTrain] = useState(false)
  const [logScale, setLogScale] = useState(false)
  // 長さの違う実験を比べるときに, 横軸を一番短い実験の最後のエポックに合わせる
  const [fitShortest, setFitShortest] = useState(false)
  // 横軸の列 (エポックか, 環境のステップ数などのエポックごとに増え続ける列)
  const [chosenAxis, setAxis] = useState(EPOCH_AXIS)
  const project = useProject(projectId)

  // 同じ実験の重複を除き, 色の数までに制限
  const runIds = useMemo(
    () => [...new Set(params.getAll('run').filter(Boolean))].slice(0, MAX_COMPARE),
    [params],
  )
  const shortLabel = useMemo(() => compareLabeler(runIds), [runIds])

  // 一覧に戻るときに, 比較している実験と評価の列を選んだままにする
  const requestedColumns = params.getAll('ev')
  const backParams = new URLSearchParams()
  for (const id of runIds) backParams.append('sel', id)
  for (const key of requestedColumns) backParams.append('ev', key)
  const backUrl = `/projects/${projectId}?${backParams.toString()}`
  const details = useRunDetails(projectId, runIds)
  // 学習中の実験は, 曲線と画像を一定の間隔で読み直す
  const liveIds = new Set(runIds.filter((_, index) => details[index]?.data?.status === 'running'))
  const histories = useHistories(projectId, runIds, liveIds)

  // 学習が終わった実験は, 最後のエポックの記録を読むためにもう一度読み直す
  const queryClient = useQueryClient()
  const liveKey = [...liveIds].sort().join('\n')
  const wasLive = useRef<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set(liveKey ? liveKey.split('\n') : [])
    for (const id of wasLive.current) {
      if (!now.has(id))
        void queryClient.invalidateQueries({ queryKey: keys.history(projectId, id) })
    }
    wasLive.current = now
  }, [liveKey, projectId, queryClient])

  // 実験ごとに, 色と読み込んだ結果をまとめる (色は選んだ順で固定)
  const slots: Slot[] = runIds.map((id, index) => ({
    id,
    color: seriesVar(index),
    run: details[index]?.data,
    history: histories[index]?.data,
    error: details[index]?.error ?? histories[index]?.error ?? undefined,
  }))
  const loading = slots.some((slot) => !slot.error && (!slot.run || !slot.history))

  // 2 種類以上のモデルの定義を使う場合は, 定義で分けて並べ, 実験の名前にも定義を添える
  // (読み込み中は定義が分からないので分けない)
  // 読めなかった実験は組に入れず, 組の外の最後に並べる
  const loaded = slots.filter((slot) => slot.run)
  const unread = slots.filter((slot) => !slot.run)
  const modelGroups = loading ? [] : groupByModel(loaded, (slot) => slot.run?.model)
  const grouped = modelGroups.length >= 2
  const modelOf = new Map(
    modelGroups.flatMap((group) => group.items.map((slot) => [slot.id, group.label] as const)),
  )
  const label = (runId: string) =>
    grouped ? `${shortLabel(runId)} · ${modelOf.get(runId) ?? ''}` : shortLabel(runId)
  const ordered = grouped ? [...modelGroups.flatMap((group) => group.items), ...unread] : slots
  // 実験の表の組 (定義ごとの見出しと, 見出しの無い読めなかった実験)
  const tableGroups: { key: string; label: string | null; items: Slot[] }[] = grouped
    ? [
        ...modelGroups.map((group) => ({ key: group.key, label: group.label, items: group.items })),
        ...(unread.length > 0 ? [{ key: 'unread', label: null, items: unread }] : []),
      ]
    : [{ key: 'all', label: null, items: slots }]
  const position = new Map(ordered.map((slot, index) => [slot.id, index]))
  const ready = slots.filter((slot): slot is Required<Omit<Slot, 'error'>> & Slot =>
    Boolean(slot.run && slot.history),
  )
  // 評価の表は, 定義で分ける場合は定義の順に並べる
  const readyOrdered = [...ready].sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  )
  // 横軸の候補は, どれかの実験で使える列. 候補から消えた列はエポックに戻す
  const axes = axisOptions(ready.map((slot) => slot.history))
  const axis = axes.includes(chosenAxis) ? chosenAxis : EPOCH_AXIS
  const byEpoch = axis === EPOCH_AXIS
  // 全ての実験の列を, 指標の順にそろえて並べる
  // 検証用がある指標の学習用は, 指定した場合だけ表示
  // 描き直してもグラフの拡大と凡例の選択は残るので, 描画ごとに作り直す
  const entries = ready.map((slot) => ({
    label: label(slot.id),
    color: slot.color,
    history: slot.history,
    config: slot.run.config,
    best: slot.run.best,
  }))
  const charts = compareCharts(entries, showTrain, axis)
  const noAxis = withoutAxis(entries, axis)
  const axisHistories = ready.map((slot) => slot.history).filter((item) => hasAxis(item, axis))
  // 横軸の目盛りと左端は全てのグラフで同じなので, 1 回だけ求める
  const integerX = integerAxis(axisHistories, axis)
  const xMin = axisStart(axisHistories, axis)

  // 実験ごとの横軸の最後の値 (長さの違う実験を比べる横軸のため)
  const lengths = axisHistories
    .map((history) =>
      Math.max(0, ...history.rows.map((row) => Number((byEpoch ? row.epoch : row[axis]) ?? 0))),
    )
    .filter((value) => value > 0)
  const shortest = Math.min(...lengths)
  const longest = Math.max(...lengths)

  // 2 つ以上の実験にある番号付きの画像の並び (同じエポックの生成画像などを並べて比べる)
  const sharedImages = sharedImageSeries(ready.map((slot) => groupImageSeries(slot.run.files, 1)))

  const configKeys = diffConfigs(ready.map((slot) => slot.run.config))
  const flatConfigs = ready.map((slot) => flattenConfig(slot.run.config))

  const remove = (runId: string) => {
    // 評価の列と並べ替えは残す
    const next = new URLSearchParams(params)
    next.delete('run')
    for (const id of runIds.filter((item) => item !== runId)) next.append('run', id)
    setParams(next)
  }
  // 評価の並べ替えは URL に残す (再読み込みと共有で同じ並びにするため)
  const evaluationSort = readEvaluationSort(params)
  const setEvaluationSort = (sort: EvaluationSort) =>
    setParams(writeEvaluationSort(params, sort), { replace: true })
  const clearEvaluationSort = () => {
    const next = new URLSearchParams(params)
    next.delete('sort')
    next.delete('desc')
    setParams(next, { replace: true })
  }
  const setShownColumns = (keys: string[]) => {
    const next = new URLSearchParams(params)
    next.delete('ev')
    // 全て外した場合は, 並べない印を残す (先頭の列に戻さないため)
    for (const key of keys.length > 0 ? keys : [NO_COLUMNS]) next.append('ev', key)
    setParams(next, { replace: true })
  }

  const header = (
    <PageHeader
      breadcrumb={
        <>
          <Link to="/" className="hover:text-ink">
            プロジェクト
          </Link>
          {' / '}
          <Link to={backUrl} className="hover:text-ink">
            {project.data?.name ?? projectId}
          </Link>
        </>
      }
      title="実験の比較"
      subtitle={`${runIds.length} 件の実験${ready.length < runIds.length && !loading ? ` (表示できたのは ${ready.length} 件)` : ''}`}
    />
  )

  if (runIds.length < 2) {
    return (
      <>
        {header}
        <EmptyState icon={GitCompareArrows} title="比べる実験を選んでください">
          <Link to={backUrl} className="text-accent-text hover:underline">
            実験の一覧
          </Link>
          で 2 つ以上の実験にチェックを入れて「比較」を押します.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      {header}
      <div className="space-y-6">
        {/* 実験ごとの色の凡例と主な結果. 読めなかった実験も外せるように行を残す */}
        <Card title="実験" padded={false}>
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">実験</th>
                  <th className="px-4 py-2 font-medium">状態</th>
                  <th className="px-4 py-2 text-right font-medium">ベスト</th>
                  <th className="px-4 py-2 text-right font-medium">エポック</th>
                  <th className="px-4 py-2 text-right font-medium">学習時間</th>
                  <th className="w-10">
                    <span className="sr-only">比較から外す</span>
                  </th>
                </tr>
              </thead>
              {tableGroups.map((group) => (
                <tbody key={group.key}>
                  {group.label && (
                    <tr className="border-b border-line bg-surface-2/50">
                      <th
                        colSpan={6}
                        scope="rowgroup"
                        className="px-4 py-1.5 text-left text-xs font-semibold text-ink-2"
                      >
                        モデルの定義: <span className="font-mono">{group.label}</span>
                      </th>
                    </tr>
                  )}
                  {group.items.map((slot) => (
                    <tr key={slot.id} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-1 w-4 shrink-0 rounded-full"
                            style={{ background: `var(${slot.color})` }}
                            aria-hidden
                          />
                          <Link
                            to={`/projects/${projectId}/runs/${encodeRunId(slot.id)}`}
                            className="font-medium hover:text-accent-text"
                          >
                            {shortLabel(slot.id)}
                          </Link>
                        </div>
                        {slot.run && (
                          <div className="pl-6 text-xs text-ink-3">
                            {formatDateTime(slot.run.started_at)}
                          </div>
                        )}
                      </td>
                      {slot.error ? (
                        <td colSpan={4} className="px-4 py-2">
                          <ErrorBox error={slot.error} live={false} />
                        </td>
                      ) : !slot.run ? (
                        <td colSpan={4} className="px-4 py-2 text-xs text-ink-3">
                          読み込み中
                        </td>
                      ) : (
                        <>
                          <td className="px-4 py-2">
                            <StatusBadge status={slot.run.status} />
                          </td>
                          <td className="tabular px-4 py-2 text-right">
                            {slot.run.best ? (
                              <>
                                {formatMetric(slot.run.best.value)}
                                <div className="text-[11px] text-ink-3">
                                  {slot.run.best.monitor} @ {slot.run.best.epoch}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="tabular px-4 py-2 text-right">{slot.run.epochs}</td>
                          <td className="tabular px-4 py-2 text-right text-ink-2">
                            {formatDuration(slot.run.duration_sec)}
                          </td>
                        </>
                      )}
                      <td className="px-2">
                        <button
                          type="button"
                          onClick={() => remove(slot.id)}
                          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                          aria-label={`${slot.id} を比較から外す`}
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </Card>

        {grouped && (
          <p className="-mt-4 text-xs text-ink-3">
            {modelGroups.length} 種類のモデルの定義で分けて並べています. 選んだ実験は,
            名前から詳細を開き, その実験 (重みと写した定義 model_spec.yaml) を推論の段階で使います.
            プロジェクトの default の model.spec は変わりません.
          </p>
        )}

        <EvaluationCompare
          slots={readyOrdered}
          label={label}
          groupOf={grouped ? (runId) => modelOf.get(runId) : undefined}
          requested={requestedColumns}
          onChange={setShownColumns}
          sort={evaluationSort}
          onSortChange={setEvaluationSort}
          onSortClear={clearEvaluationSort}
          loading={loading}
        />

        {loading && <Spinner />}

        {/* 指標ごとに実験を重ねたグラフ */}
        {!loading && ready.length > 0 && (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">学習曲線</h2>
              <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
                {axes.length > 1 && (
                  <label className="flex items-center gap-2">
                    横軸
                    <select
                      value={axis}
                      onChange={(event) => setAxis(event.target.value)}
                      className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
                    >
                      {axes.map((option) => (
                        <option key={option} value={option}>
                          {axisLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showTrain}
                    onChange={(event) => setShowTrain(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  検証用がある指標も学習用を表示する
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={logScale}
                    onChange={(event) => setLogScale(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  縦軸を対数にする
                </label>
                {lengths.length > 1 && shortest !== longest && (
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={fitShortest}
                      onChange={(event) => setFitShortest(event.target.checked)}
                      className="accent-[var(--accent)]"
                    />
                    横軸を一番短い実験 (
                    {byEpoch ? `${shortest} エポック` : `${axis} = ${formatAxis(shortest)}`})
                    に合わせる
                  </label>
                )}
              </div>
            </div>
            {noAxis.length > 0 && (
              <p className="mb-3 text-xs text-ink-3">
                横軸の {axis} が無い (かエポックごとに増え続けない) ので, 出していない実験:{' '}
                {noAxis.join(', ')}
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {charts.map(({ column, series, missing, identical, sparse, direction }) => (
                <Card
                  key={column}
                  title={<span className="font-mono">{column}</span>}
                  actions={direction ? <DirectionBadge value={direction} /> : undefined}
                >
                  <LineChart
                    series={series}
                    logScale={logScale}
                    xMax={fitShortest ? shortest : undefined}
                    xLabel={axis}
                    integerX={integerX}
                    xMin={xMin}
                    label={
                      byEpoch
                        ? `${column} の実験ごとの推移`
                        : `${column} の実験ごとの ${axis} に対する推移`
                    }
                  />
                  {missing.length > 0 && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      この指標が無い実験: {missing.join(', ')}
                    </p>
                  )}
                  {sparse.length > 0 && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      検証したエポックだけを点で示し, 間を線でつないだ実験: {sparse.join(', ')}
                    </p>
                  )}
                  {identical.map((names) => (
                    <p key={names.join()} className="mt-1 text-[11px] text-ink-3">
                      線が重なっている実験: {names.join(', ')} (全ての点で同じ値)
                    </p>
                  ))}
                </Card>
              ))}
            </div>
          </div>
        )}

        {!loading && sharedImages.length > 0 && (
          <ImageCompare
            series={sharedImages}
            runs={ready.map((slot) => ({
              id: slot.id,
              label: label(slot.id),
              color: slot.color,
            }))}
            projectId={projectId}
          />
        )}

        {/* config の違う項目 */}
        {!loading && ready.length > 1 && (
          <Card title={`config の違い (${configKeys.length})`} padded={false}>
            {configKeys.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-3">全ての実験で config が同じです.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">項目</th>
                      {ready.map((slot) => (
                        <th key={slot.id} className="px-4 py-2 font-medium">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="h-1 w-3 rounded-full"
                              style={{ background: `var(${slot.color})` }}
                              aria-hidden
                            />
                            {label(slot.id)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {configKeys.map((key) => (
                      <tr key={key} className="border-b border-line last:border-b-0">
                        <td className="px-4 py-1.5 font-mono text-xs text-ink-2">{key}</td>
                        {flatConfigs.map((config, index) => (
                          <td
                            key={ready[index]?.id}
                            className={clsx(
                              'px-4 py-1.5 font-mono text-xs break-all',
                              config[key] === undefined && 'text-ink-3',
                            )}
                          >
                            {config[key] === undefined ? '—' : formatValue(config[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

/** テスト用の評価の値と守る指標の印を実験ごとに並べる. 列の見出しで並べ替える */
function EvaluationCompare({
  slots,
  label,
  requested,
  onChange,
  sort,
  onSortChange,
  onSortClear,
  loading,
  groupOf,
}: {
  slots: (Slot & { run: RunDetail })[]
  label: (runId: string) => string
  /** 定義で分ける場合の, 実験の組の名前 (分けない場合は undefined) */
  groupOf?: (runId: string) => string | undefined
  requested: string[]
  onChange: (keys: string[]) => void
  sort: EvaluationSort | null
  onSortChange: (sort: EvaluationSort) => void
  onSortClear: () => void
  /** 読み込み中の実験があるか (読み終わるまで並べ替えを捨てない) */
  loading: boolean
}) {
  const columns = useMemo(() => collectColumns(slots.map((slot) => slot.run.evaluations)), [slots])
  const shown = chooseColumns(columns, requested, MAX_COMPARE_COLUMNS)
  // 並べていない列での並べ替えは URL から捨てる (一覧とそろえる)
  const stale = !loading && sort !== null && !shown.some((column) => column.key === sort.key)
  useEffect(() => {
    if (stale) onSortClear()
  }, [stale, onSortClear])
  const hasGuard = slots.some((slot) => slot.run.evaluations?.guard)
  const noticed = slots.filter((slot) => slot.run.evaluations?.notice)
  if (columns.length === 0 && !hasGuard && noticed.length === 0) return null

  // 値の無い実験は末尾. 並べ替えない場合は選んだ順
  const active = sort && shown.some((column) => column.key === sort.key) ? sort : null
  const sortedRows = active
    ? [...slots].sort((a, b) => {
        const x = findValue(a.run.evaluations, active.key)?.value
        const y = findValue(b.run.evaluations, active.key)?.value
        if (x == null && y == null) return 0
        if (x == null) return 1
        if (y == null) return -1
        return active.desc ? y - x : x - y
      })
    : slots
  // 定義で分ける場合は, 組の中で並べ替え, 組ごとに見出しを付ける
  const groupNames = [...new Set(slots.map((slot) => groupOf?.(slot.id) ?? ''))]
  const rowGroups = groupNames.map((name) => ({
    name,
    rows: sortedRows.filter((slot) => (groupOf?.(slot.id) ?? '') === name),
  }))
  const onSort = (column: EvaluationColumn) =>
    onSortChange({
      key: column.key,
      desc: active?.key === column.key ? !active.desc : initialDesc(column),
    })

  return (
    <Card
      title="テスト用の評価"
      padded={false}
      actions={
        columns.length > 0 ? (
          <EvaluationColumnPicker
            columns={columns}
            chosen={shown}
            limit={MAX_COMPARE_COLUMNS}
            onChange={onChange}
          />
        ) : undefined
      }
    >
      {noticed.map((slot) => (
        <p key={slot.id} className="px-4 pt-3 text-xs text-ink-3">
          {label(slot.id)}: {slot.run.evaluations?.notice}
        </p>
      ))}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-3">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">実験</th>
              {hasGuard && <th className="px-4 py-2 font-medium">守る指標</th>}
              {shown.map((column) => {
                const sorted = active?.key === column.key
                const Icon = active?.desc ? ArrowDown : ArrowUp
                return (
                  <th
                    key={column.key}
                    className="px-4 py-2 text-right font-medium"
                    aria-sort={sorted ? (active.desc ? 'descending' : 'ascending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(column)}
                      className={clsx(
                        'inline-flex items-center gap-1 hover:text-ink',
                        sorted && 'text-ink',
                      )}
                    >
                      <ColumnLabel column={column} />
                      {sorted && <Icon className="size-3" aria-hidden />}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          {rowGroups.map((group) => (
            <tbody key={group.name}>
              {groupOf && group.name && (
                <tr className="border-b border-line bg-surface-2/50">
                  <th
                    colSpan={1 + (hasGuard ? 1 : 0) + shown.length}
                    scope="rowgroup"
                    className="px-4 py-1.5 text-left text-xs font-semibold text-ink-2"
                  >
                    モデルの定義: <span className="font-mono">{group.name}</span>
                  </th>
                </tr>
              )}
              {group.rows.map((slot) => (
                <tr key={slot.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className="h-1 w-4 shrink-0 rounded-full"
                        style={{ background: `var(${slot.color})` }}
                        aria-hidden
                      />
                      {label(slot.id)}
                    </span>
                  </td>
                  {hasGuard && (
                    <td className="px-4 py-2">
                      <GuardBadge guard={slot.run.evaluations?.guard} />
                    </td>
                  )}
                  {shown.map((column) => (
                    <td key={column.key} className="tabular px-4 py-2 text-right whitespace-nowrap">
                      <EvaluationCell value={findValue(slot.run.evaluations, column.key)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </Card>
  )
}
