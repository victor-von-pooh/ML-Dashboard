import clsx from 'clsx'
import { ChartScatter } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { encodeRunId } from '../../api/client'
import { useProject, useRunParams } from '../../api/hooks'
import { ScatterChart, type ScatterPoint } from '../../components/ScatterChart'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import {
  type Direction,
  formatParam,
  needsQuote,
  groupByParam,
  metricDirection,
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
  const [logXChoice, setLogX] = useState<{ key: string; on: boolean } | null>(null)
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
  // URL の値は, 今の実験に無い場合 (古いリンクなど) は既定に戻す
  const pick = (value: string | null, allowed: string[], fallback: string) =>
    value !== null && allowed.includes(value) ? value : fallback
  const name = pick(search.get('name'), names, names[0] ?? '')
  const runs = useMemo(() => all.filter((run) => run.name === name), [all, name])

  const varying = useMemo(() => varyingParams(runs), [runs])
  const metrics = useMemo(() => metricOptions(runs), [runs])
  const defaultX = varying.find((item) => item.complete && !item.noise)?.key
  const xKey = pick(
    search.get('x'),
    varying.map((item) => item.key),
    defaultX ?? varying[0]?.key ?? '',
  )
  const metric = pick(
    search.get('y'),
    metrics.map((item) => item.id),
    'best',
  )
  const inferred = metricDirection(runs, metric)
  const direction: Direction = pick(search.get('dir'), ['max', 'min'], inferred) as Direction
  const higherIsBetter = direction === 'max'
  const param = varying.find((item) => item.key === xKey)

  // 散布図の点と, 最良の実験. 数値の軸では数値の無い実験は数だけ表示
  const valued = runs.filter((run) => metricValue(run, metric) !== null)
  const quote = needsQuote(runs, xKey)
  const points: ScatterPoint[] = valued.flatMap((run): ScatterPoint[] => {
    const y = metricValue(run, metric) as number
    const x = run.params[xKey]
    if (param?.numeric) return typeof x === 'number' ? [{ id: run.id, x, y }] : []
    return [{ id: run.id, x: formatParam(x, quote), y }]
  })
  const unplotted = valued.length - points.length
  const noResult = runs.length - valued.length
  const bestPoint = points.reduce<ScatterPoint | null>(
    (best, point) =>
      !best || (higherIsBetter ? point.y > best.y : point.y < best.y) ? point : best,
    null,
  )

  // 値の名前の軸は, 表と同じく良い順に並べる
  const groups = xKey ? groupByParam(runs, xKey, metric, direction) : []
  const categories = param?.numeric ? null : groups.map((row) => row.value)

  // 20 倍以上の範囲に広がる正の数値 (学習率など) は, 既定で横軸を対数にする
  const xs = points.flatMap((point) => (typeof point.x === 'number' ? [point.x] : []))
  const autoLog = xs.length > 1 && Math.min(...xs) > 0 && Math.max(...xs) / Math.min(...xs) >= 20
  const logX = logXChoice?.key === xKey ? logXChoice.on : autoLog
  // 結果が変わらなかった項目は数だけ表示
  const allRanking = sensitivity(runs, varying, metric, direction)
  const ranking = allRanking.filter((item) => item.spread > 0)
  const flat = allRanking.length - ranking.length
  const barMax =
    Math.max(0, ...ranking.filter((item) => !item.noise).map((item) => item.spread)) ||
    Math.max(0, ...ranking.map((item) => item.spread)) ||
    1
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
      {names.length > 1 && (
        <div className="mb-4">
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
        </div>
      )}
      {varying.length === 0 ? (
        <EmptyState icon={ChartScatter} title="比べられる項目がありません">
          同じ名前の実験で config の値が違うものが 2 つ以上あると, 値と結果の関係を表示します.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="横軸: config の項目"
              value={xKey}
              onChange={(value) => update('x', value)}
              options={varying.map((item) => ({
                id: item.key,
                label: `${item.key} (${item.values} 通り${item.complete ? '' : ', 一部の実験だけ'}${item.noise ? ', 記録や環境' : ''})`,
              }))}
            />
            <Select
              label="縦軸: 結果"
              value={metric}
              onChange={(value) => {
                // 結果を変えたら, 良い向きは新しい結果から推測し直す
                const next = new URLSearchParams(search)
                next.set('y', value)
                next.delete('dir')
                setSearch(next, { replace: true })
              }}
              options={metrics}
            />
            <Select
              label="良い向き"
              value={direction}
              onChange={(value) => update('dir', value)}
              options={[
                { id: 'max', label: `大きいほど良い${inferred === 'max' ? ' (推測)' : ''}` },
                { id: 'min', label: `小さいほど良い${inferred === 'min' ? ' (推測)' : ''}` },
              ]}
            />
            <div className="flex gap-4 pb-2 text-xs text-ink-2">
              {param?.numeric && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={logX}
                    onChange={(event) => setLogX({ key: xKey, on: event.target.checked })}
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
              actions={
                <span className="text-xs text-ink-3">
                  {points.length} 実験
                  {unplotted > 0 && ` (値の無い ${unplotted} 実験は除外)`}
                  {noResult > 0 && ` (結果の無い ${noResult} 実験は除外)`}
                </span>
              }
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
                    <th className="px-4 py-2 text-right font-medium whitespace-nowrap">
                      最良 {higherIsBetter ? '(↑)' : '(↓)'}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">平均</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((row, index) => (
                    <tr key={row.key} className="border-b border-line last:border-b-0">
                      <td className="px-3 py-1.5 font-mono text-xs [overflow-wrap:anywhere] sm:px-4">
                        {row.value}
                      </td>
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
              値ごとの最良の {metricLabel} の差が大きい順. 他の項目も同時に変えた実験が混ざり, 1
              つの実験で決まる値もあるので, 目安として見てください. いつも一緒に変えた項目は 1
              行にまとめ, 乱数シードや記録の設定は後ろに並べます.
            </p>
            {ranking.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-3">
                値を変えて結果が変わった項目はありません.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-2 w-full min-w-[480px] text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr className="border-b border-line">
                      <th scope="col" className="px-4 py-2 font-medium">
                        項目
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-2 text-right font-medium whitespace-nowrap"
                      >
                        値の数
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                        最良の差
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((item) => {
                      // 記録の設定の行で棒の長さが決まらないように, 結果に関係しそうな行で揃える
                      const max = barMax
                      const key = item.keys[0] ?? ''
                      return (
                        <tr
                          key={item.keys.join('|')}
                          className={clsx(
                            'border-b border-line last:border-b-0',
                            item.noise && 'text-ink-3',
                          )}
                        >
                          <td className="px-4 py-1.5">
                            <button
                              type="button"
                              onClick={() => update('x', key)}
                              className={clsx(
                                'text-left font-mono text-xs break-all hover:text-accent-text',
                                item.keys.includes(xKey) && 'font-semibold text-accent-text',
                              )}
                            >
                              {item.keys.join(' / ')}
                            </button>
                            <div className="text-[11px] text-ink-3">
                              {[
                                item.keys.length > 1 && 'いつも同時に変更',
                                item.single && '1 つの実験だけの値あり',
                                !item.complete && '一部の実験だけの項目',
                                item.noise && '記録や環境の設定',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </td>
                          <td className="tabular px-4 py-1.5 text-right text-ink-2">
                            {item.groups}
                          </td>
                          <td className="px-4 py-1.5">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2 sm:w-40">
                                <div
                                  className="h-full rounded-full bg-accent"
                                  style={{ width: `${Math.min(1, item.spread / max) * 100}%` }}
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
              </div>
            )}
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
