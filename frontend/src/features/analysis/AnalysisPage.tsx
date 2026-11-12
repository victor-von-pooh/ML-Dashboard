import clsx from 'clsx'
import { ChartScatter } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { encodeRunId } from '../../api/client'
import { useProject, useRunParams } from '../../api/hooks'
import { ScatterChart, type ScatterPoint } from '../../components/ScatterChart'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import {
  formatParam,
  groupByParam,
  metricOptions,
  metricValue,
  sensitivity,
  varyingParams,
} from '../../lib/analysis'
import { formatMetric } from '../../lib/format'

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { id: string; label: string }[]
}) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-2">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full min-w-48 rounded-lg border border-line bg-surface px-2 font-mono text-xs"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** config の項目と結果の関係を調べる画面 */
export function AnalysisPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  const params = useRunParams(projectId)
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const [logX, setLogX] = useState(false)
  const [logY, setLogY] = useState(false)

  // 選んだ内容は URL に保存し, 共有や再読み込みで同じ画面を開けるようにする
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search)
    next.set(key, value)
    setSearch(next, { replace: true })
  }

  const all = useMemo(() => params.data ?? [], [params.data])

  // 実験の名前で絞る (違う名前の実験は別の問題のことが多い). 既定は実験の多い名前
  const names = useMemo(() => {
    const counts = new Map<string, number>()
    for (const run of all) counts.set(run.name, (counts.get(run.name) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  }, [all])
  const name = search.get('name') ?? names[0] ?? ''
  const runs = useMemo(() => all.filter((run) => run.name === name), [all, name])

  const varying = useMemo(() => varyingParams(runs), [runs])
  const metrics = useMemo(() => metricOptions(runs), [runs])
  const xKey = search.get('x') ?? varying.find((item) => item.key !== 'experiment.seed')?.key ?? ''
  const metric = search.get('y') ?? 'best'
  const higherIsBetter = runs.find((run) => run.best)?.best?.mode === 'max'
  const param = varying.find((item) => item.key === xKey)

  // 散布図の点と, 最良の実験
  const points: ScatterPoint[] = runs.flatMap((run) => {
    const y = metricValue(run, metric)
    const x = run.params[xKey]
    if (y === null || x === undefined) return []
    return [{ id: run.id, x: param?.numeric && typeof x === 'number' ? x : formatParam(x), y }]
  })
  const categories = param?.numeric
    ? null
    : [...new Set(points.map((point) => String(point.x)))].sort()
  const bestPoint = points.reduce<ScatterPoint | null>(
    (best, point) =>
      !best || (higherIsBetter ? point.y > best.y : point.y < best.y) ? point : best,
    null,
  )

  const groups = xKey ? groupByParam(runs, xKey, metric, higherIsBetter) : []
  // 結果が変わらなかった項目は数だけ表示
  const allRanking = sensitivity(runs, varying, metric, higherIsBetter)
  const ranking = allRanking.filter((item) => item.spread > 0)
  const flat = allRanking.length - ranking.length
  const metricLabel = metrics.find((item) => item.id === metric)?.label ?? metric

  const header = (
    <PageHeader
      breadcrumb={
        <>
          <Link to="/" className="hover:text-ink">
            プロジェクト
          </Link>
          {' / '}
          <Link to={`/projects/${projectId}`} className="hover:text-ink">
            {project.data?.name ?? projectId}
          </Link>
        </>
      }
      title="ハイパーパラメータの分析"
      subtitle="config の項目を変えたときに結果がどう変わったかを, 実験をまたいで見ます"
    />
  )

  if (params.isPending) return <Spinner />
  if (params.error) {
    return (
      <>
        {header}
        <ErrorBox error={params.error} />
      </>
    )
  }

  return (
    <>
      {header}
      {varying.length === 0 ? (
        <EmptyState icon={ChartScatter} title="比べられる項目がありません">
          同じ名前の実験で config の値が違うものが 2 つ以上あると, 値と結果の関係を表示します.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            {names.length > 1 && (
              <Select
                label="実験の名前"
                value={name}
                onChange={(value) => {
                  const next = new URLSearchParams()
                  next.set('name', value)
                  setSearch(next, { replace: true })
                }}
                options={names.map((item) => ({ id: item, label: item }))}
              />
            )}
            <Select
              label="横軸: config の項目"
              value={xKey}
              onChange={(value) => update('x', value)}
              options={varying.map((item) => ({
                id: item.key,
                label: `${item.key} (${item.values} 通り)`,
              }))}
            />
            <Select
              label="縦軸: 結果"
              value={metric}
              onChange={(value) => update('y', value)}
              options={metrics}
            />
            <div className="flex gap-4 pb-2 text-xs text-ink-2">
              {param?.numeric && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={logX}
                    onChange={(event) => setLogX(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  横軸を対数
                </label>
              )}
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={logY}
                  onChange={(event) => setLogY(event.target.checked)}
                  className="accent-[var(--accent)]"
                />
                縦軸を対数
              </label>
            </div>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card
              title={
                <span className="font-mono text-xs">
                  {xKey} と {metricLabel}
                </span>
              }
              actions={<span className="text-xs text-ink-3">{points.length} 実験</span>}
            >
              <ScatterChart
                points={points}
                categories={categories}
                xLabel={xKey}
                yLabel={metricLabel}
                logX={logX}
                logY={logY}
                highlight={bestPoint?.id ?? null}
                onSelect={(id) => navigate(`/projects/${projectId}/runs/${encodeRunId(id)}`)}
                label={`${xKey} と ${metricLabel} の散布図`}
              />
              <p className="mt-2 text-[11px] text-ink-3">
                点を押すとその実験を開きます. 最も良い実験は色を変えています (
                {higherIsBetter ? '大きいほど良い' : '小さいほど良い'}).
              </p>
            </Card>

            <Card title="値ごとの結果" padded={false}>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-3">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">値</th>
                    <th className="px-4 py-2 text-right font-medium">実験</th>
                    <th className="px-4 py-2 text-right font-medium">最良</th>
                    <th className="px-4 py-2 text-right font-medium">平均</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((row, index) => (
                    <tr key={row.value} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-1.5 font-mono text-xs break-all">{row.value}</td>
                      <td className="tabular px-4 py-1.5 text-right text-ink-2">{row.count}</td>
                      <td
                        className={clsx(
                          'tabular px-4 py-1.5 text-right',
                          index === 0 && 'font-semibold',
                        )}
                      >
                        {formatMetric(row.best)}
                      </td>
                      <td className="tabular px-4 py-1.5 text-right text-ink-2">
                        {formatMetric(row.mean)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <Card title="結果への影響が大きい項目" padded={false}>
            <p className="px-4 pt-3 text-xs text-ink-3">
              値ごとの最良の {metricLabel} の差が大きい順. 他の項目も同時に変えた実験が混ざるので,
              目安として見てください.
            </p>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">項目</th>
                  <th className="px-4 py-2 text-right font-medium">値の数</th>
                  <th className="px-4 py-2 font-medium">最良の差</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((item) => {
                  const max = ranking[0]?.spread || 1
                  return (
                    <tr key={item.key} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-1.5">
                        <button
                          type="button"
                          onClick={() => update('x', item.key)}
                          className={clsx(
                            'font-mono text-xs hover:text-accent-text',
                            item.key === xKey && 'font-semibold text-accent-text',
                          )}
                        >
                          {item.key}
                        </button>
                      </td>
                      <td className="tabular px-4 py-1.5 text-right text-ink-2">{item.groups}</td>
                      <td className="px-4 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-2">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{ width: `${(item.spread / max) * 100}%` }}
                            />
                          </div>
                          <span className="tabular text-xs text-ink-2">
                            {formatMetric(item.spread)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {flat > 0 && (
              <p className="border-t border-line px-4 py-2 text-xs text-ink-3">
                値を変えても最良の {metricLabel} が変わらなかった項目: {flat} 個
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
