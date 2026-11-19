import clsx from 'clsx'
import { ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'

import type { Evaluation } from '../../api/client'
import { LineChart, type ChartSeries } from '../../components/LineChart'
import { Card } from '../../components/ui'
import { seriesVar } from '../../lib/colors'
import { curveSeries, formatCell, numericColumns } from '../../lib/results'

// 1 つの曲線に重ねる列の上限 (系列の色の数)
const MAX_CURVE_SERIES = 8

/** 評価の表. 列は評価の順のまま */
function EvaluationTable({ evaluation }: { evaluation: Evaluation }) {
  const numeric = useMemo(() => numericColumns(evaluation), [evaluation])
  return (
    <div className="max-h-[480px] overflow-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-2 text-left text-xs text-ink-2">
          <tr>
            {evaluation.columns.map((column) => (
              <th
                key={column}
                scope="col"
                className={clsx(
                  'px-3 py-1.5 font-medium whitespace-nowrap',
                  numeric.has(column) && 'text-right',
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {evaluation.rows.map((row, index) => (
            <tr key={index} className="border-t border-line">
              {evaluation.columns.map((column) => {
                const value = row[column]
                return (
                  <td
                    key={column}
                    className={clsx(
                      'px-3 py-1 whitespace-nowrap',
                      numeric.has(column) ? 'tabular text-right' : 'text-ink',
                      value == null && 'text-ink-3',
                    )}
                  >
                    {formatCell(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 評価の曲線. x の列を横軸に, 他の数の列を 1 つの縦軸に重ねる (凡例で列を選べる) */
function EvaluationCurve({ evaluation }: { evaluation: Evaluation }) {
  const all = useMemo(() => curveSeries(evaluation), [evaluation])
  const series = useMemo<ChartSeries[]>(
    () =>
      all.slice(0, MAX_CURVE_SERIES).map((item, index) => ({
        name: item.column,
        color: seriesVar(index),
        points: item.points,
      })),
    [all],
  )
  if (series.length === 0) return <EvaluationTable evaluation={evaluation} />
  return (
    <div className="space-y-2">
      <LineChart
        series={series}
        xLabel={evaluation.x ?? undefined}
        integerX={false}
        label={`${evaluation.name} の曲線 (横軸 ${evaluation.x ?? ''})`}
      />
      {all.length > MAX_CURVE_SERIES && (
        <p className="text-xs text-ink-3">
          列が多いので, 先頭の {MAX_CURVE_SERIES} 列だけを描いています. 全ての列は下の表にあります.
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-ink-2">表で見る</summary>
        <div className="mt-2">
          <EvaluationTable evaluation={evaluation} />
        </div>
      </details>
    </div>
  )
}

/** 評価の分割, 説明, 比べる相手, エポック */
function Captions({ evaluation }: { evaluation: Evaluation }) {
  return (
    <dl className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      <div className="flex gap-1">
        <dt className="text-ink-3">分割</dt>
        <dd className="font-mono">{evaluation.split ?? '—'}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-ink-3">エポック</dt>
        <dd className="tabular">{evaluation.epoch ?? '分からない'}</dd>
      </div>
      {evaluation.baseline && (
        <div className="flex gap-1">
          <dt className="text-ink-3">比べる相手</dt>
          <dd>{evaluation.baseline}</dd>
        </div>
      )}
      {evaluation.description && (
        <div className="flex basis-full gap-1">
          <dt className="sr-only">説明</dt>
          <dd className="text-ink">{evaluation.description}</dd>
        </div>
      )}
    </dl>
  )
}

/** データ全体の評価 (ML-Found の evaluations/). 守る指標を先頭に (並びはバックエンド) */
export function EvaluationsTab({ evaluations }: { evaluations: Evaluation[] }) {
  return (
    <div className="space-y-4">
      {evaluations.map((evaluation) => (
        <Card
          key={evaluation.name}
          className={clsx(evaluation.guard && 'border-2 border-accent!')}
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono">{evaluation.name}</span>
              <span className="text-xs font-normal text-ink-3">
                {evaluation.kind === 'curve' ? '曲線' : '表'}
              </span>
            </span>
          }
          actions={
            evaluation.guard ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text">
                <ShieldCheck className="size-3.5" aria-hidden />
                守る指標
              </span>
            ) : undefined
          }
        >
          <Captions evaluation={evaluation} />
          {evaluation.kind === 'curve' ? (
            <EvaluationCurve evaluation={evaluation} />
          ) : (
            <EvaluationTable evaluation={evaluation} />
          )}
          {evaluation.total_rows > evaluation.rows.length && (
            <p className="mt-2 text-xs text-ink-3">
              {evaluation.total_rows.toLocaleString()} 行のうち, 先頭の{' '}
              {evaluation.rows.length.toLocaleString()} 行を出しています
            </p>
          )}
        </Card>
      ))}
    </div>
  )
}
