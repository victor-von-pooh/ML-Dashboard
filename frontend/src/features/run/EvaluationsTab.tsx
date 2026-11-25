import clsx from 'clsx'
import { Info, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'

import type { Evaluation } from '../../api/client'
import { LineChart, type ChartSeries } from '../../components/LineChart'
import { Card } from '../../components/ui'
import { seriesVar } from '../../lib/colors'
import { diffValue } from '../../lib/evaluations'
import { evaluationTitle, isAnomalyEvaluation, metricLabel } from '../../lib/metrics'
import { curveSeries, formatCell, numericColumns } from '../../lib/results'
import { EvaluationCell } from '../runs/EvaluationColumns'

// 1 つの曲線に重ねる列の上限 (系列の色の数)
const MAX_CURVE_SERIES = 8

/**
 * 評価の表. 列は評価の順のまま. 向き (better) のある列は見出しに添え, 名前の分かる列は
 * 日本語の名前を主にして英字の名前を小さく添える. 比べる相手との差の列は, 一覧と同じく
 * 良し悪しを色とアイコンと文字で出す
 */
function EvaluationTable({ evaluation }: { evaluation: Evaluation }) {
  const numeric = useMemo(() => numericColumns(evaluation), [evaluation])
  return (
    <div className="max-h-[480px] overflow-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-2 text-left text-xs text-ink-2">
          <tr>
            {evaluation.columns.map((column) => {
              const name = metricLabel(column, evaluation.name)
              const better = evaluation.better[column]
              const direction = better && (better === 'lower' ? '小さいほど良い' : '大きいほど良い')
              return (
                <th
                  key={column}
                  scope="col"
                  className={clsx(
                    'px-3 py-1.5 align-bottom font-medium whitespace-nowrap',
                    numeric.has(column) && 'text-right',
                  )}
                  title={name?.note ?? undefined}
                >
                  {name ? (
                    <>
                      <span className="block">{name.label}</span>
                      <span className="block text-[10px] font-normal text-ink-3">
                        <span className="font-mono">{column}</span>
                        {direction && ` (${direction})`}
                      </span>
                    </>
                  ) : (
                    <>
                      {column}
                      {direction && (
                        <span className="ml-1 font-normal text-ink-3">({direction})</span>
                      )}
                    </>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {evaluation.rows.map((row, index) => (
            <tr key={index} className="border-t border-line">
              {evaluation.columns.map((column) => {
                const value = row[column]
                const diff = diffValue(evaluation, column, value)
                return (
                  <td
                    key={column}
                    className={clsx(
                      'px-3 py-1 whitespace-nowrap',
                      numeric.has(column) ? 'tabular text-right' : 'text-ink',
                      value == null && 'text-ink-3',
                    )}
                  >
                    {diff ? <EvaluationCell value={diff} format={formatCell} /> : formatCell(value)}
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

// 異常の検知の度合いの決め方 (config の anomaly.score) の日本語の名前
const ANOMALY_SCORES: Record<string, string> = {
  autoencoder: '自己符号化器の再構成の誤差',
  distance: '学習用の正常の行の中心からの距離',
}

/** config の anomaly の項目 (ML-Quest の異常の検知の骨組みの score, k, capacity) */
function anomalySettings(config: Record<string, unknown> | null | undefined): {
  score: string | null
  k: number | null
  capacity: number | null
} {
  const section = config?.anomaly
  const values =
    section && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {}
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
  const score = typeof values.score === 'string' ? values.score : null
  return {
    score: score ? (ANOMALY_SCORES[score] ?? score) : null,
    k: count(values.k),
    capacity: count(values.capacity),
  }
}

/**
 * 異常の検知の評価の読み方と, 度合いの決め方, K, 人が 1 回に確かめる件数の上限 (config
 * の anomaly. 書いていない項目は出さない)
 */
function AnomalyNote({ config }: { config: Record<string, unknown> | null | undefined }) {
  const { score, k, capacity } = anomalySettings(config)
  const items: [string, string][] = [
    ...(score ? [['度合いの決め方', score] as [string, string]] : []),
    ...(k != null ? [['上位の件数 K', `${k} 件`] as [string, string]] : []),
    ...(capacity != null
      ? [['人が 1 回に確かめる件数の上限', `${capacity} 件`] as [string, string]]
      : []),
  ]
  return (
    <section
      aria-label="異常の検知の評価の読み方"
      className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm"
    >
      <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
        <Info className="size-4 text-ink-3" aria-hidden />
        異常の検知の評価
      </h3>
      {items.length > 0 && (
        <dl className="mb-2 flex flex-wrap gap-x-6 gap-y-1">
          {items.map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="text-ink-3">{label}</dt>
              <dd className="tabular text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
        <li>
          度合い (異常の度合い) は行ごとの異常らしさで, 大きいほど学習用の正常の行から外れています.
          確率ではありません.
        </li>
        <li>
          異常の行のある分割 (anomaly_&lt;分割&gt;) は, 度合いの高い K 行のうち異常の行の割合 (上位
          K 件の適合率) と, 度合いの順の並びの良さ (PR-AUC) を出します. どちらも大きいほど良く,
          異常の割合が小さいと上位 K 件の適合率は低く出ます.
        </li>
        <li>
          異常の正解の無い分割は, 度合いの分布 (anomaly_scores_&lt;分割&gt;. 横軸は分位) と,
          度合いの高い順の上位 K 行の要約 (anomaly_top_&lt;分割&gt;. 最も外れた列とその割合)
          を出します. 一覧と比較の列にはならないので, ここで見ます.
        </li>
        <li>
          推論の段階では, 度合いの高い順に人が 1 回に確かめる件数の上限まで人の確認に回します.
        </li>
      </ul>
    </section>
  )
}

/**
 * データ全体の評価 (ML-Found の evaluations/). 守る指標を先頭に (並びはバックエンド).
 * 異常の検知の評価を持つ実験は, 先頭に読み方と K と人が確かめる件数の上限を出す
 */
export function EvaluationsTab({
  evaluations,
  config,
}: {
  evaluations: Evaluation[]
  config?: Record<string, unknown> | null
}) {
  const anomaly = evaluations.some((evaluation) => isAnomalyEvaluation(evaluation.name))
  return (
    <div className="space-y-4">
      {anomaly && <AnomalyNote config={config} />}
      {evaluations.map((evaluation) => (
        <Card
          key={evaluation.name}
          className={clsx(evaluation.guard && 'border-2 border-accent!')}
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono">{evaluation.name}</span>
              {evaluationTitle(evaluation.name) && (
                <span className="text-sm font-normal text-ink-2">
                  {evaluationTitle(evaluation.name)}
                </span>
              )}
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
