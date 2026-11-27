import clsx from 'clsx'
import { Info, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'

import { useApi, type Evaluation, type RunFile } from '../../api/client'
import { LineChart, type ChartSeries } from '../../components/LineChart'
import { Card } from '../../components/ui'
import { seriesVar } from '../../lib/colors'
import { diffValue } from '../../lib/evaluations'
import {
  curveColumns,
  evaluationTitle,
  isAnomalyEvaluation,
  isDemandEvaluation,
  isPriceEvaluation,
  isUpliftEvaluation,
  metricLabel,
} from '../../lib/metrics'
import { curveSeries, formatCell, formatPercent, numericColumns } from '../../lib/results'
import { EvaluationCell } from '../runs/EvaluationColumns'
import { CsvSample } from './CsvSample'

// 1 つの曲線に重ねる列の上限 (系列の色の数)
const MAX_CURVE_SERIES = 8

/**
 * % で書く評価の列の書き方. 効果を見積もるの上位の割合 K (0.3 は上位 30 %) と, 値段を
 * 変える判断の見込みの利益の比 (1.0342 は 103.42 %. 1 に近い値の違いが見えるように小数
 * 第 2 位まで) と変える幅の上限 (0.1 は 10 %), 時間をまたぐ量の判断の発注の数の損の比
 * (0.8215 は 82.15 %. 利益の比と同じ桁). 他の列は null
 */
function percentFormat(evaluation: string, column: string): ((value: number) => string) | null {
  if (isUpliftEvaluation(evaluation) && column === 'k') {
    return (value) => `上位 ${formatPercent(value)}`
  }
  if (isPriceEvaluation(evaluation) && column === 'profit_ratio') {
    return (value) => formatPercent(value, { digits: 2 })
  }
  if (isPriceEvaluation(evaluation) && column === 'max_change') {
    return (value) => formatPercent(value)
  }
  if (isDemandEvaluation(evaluation) && column === 'order_cost_ratio') {
    return (value) => formatPercent(value, { digits: 2 })
  }
  return null
}

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
                const percent = percentFormat(evaluation.name, column)
                return (
                  <td
                    key={column}
                    className={clsx(
                      'px-3 py-1 whitespace-nowrap',
                      numeric.has(column) ? 'tabular text-right' : 'text-ink',
                      value == null && 'text-ink-3',
                    )}
                  >
                    {diff ? (
                      <EvaluationCell value={diff} format={formatCell} />
                    ) : percent && typeof value === 'number' ? (
                      percent(value)
                    ) : (
                      formatCell(value)
                    )}
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

// でたらめに配る場合のような, 比べる基準の線の列 (破線で描く)
const REFERENCE_COLUMNS = new Set(['random'])

/**
 * 評価の曲線. x の列を横軸に, 他の数の列を 1 つの縦軸に重ねる (凡例で列を選べる).
 * 名前の分かる評価は描く列を絞り (Qini の曲線の上位の行の数のような目盛りの違う列を
 * 除くため), 系列の名前に日本語の名前を添え, 基準の線を破線にする
 */
function EvaluationCurve({ evaluation }: { evaluation: Evaluation }) {
  const all = useMemo(() => {
    const columns = curveColumns(evaluation.name)
    const found = curveSeries(evaluation)
    return columns
      ? columns.flatMap((column) => found.filter((item) => item.column === column))
      : found
  }, [evaluation])
  const series = useMemo<ChartSeries[]>(
    () =>
      all.slice(0, MAX_CURVE_SERIES).map((item, index) => {
        const name = curveColumns(evaluation.name)
          ? metricLabel(item.column, evaluation.name)
          : null
        return {
          name: name ? `${name.label} (${item.column})` : item.column,
          color: seriesVar(index),
          points: item.points,
          dashed: REFERENCE_COLUMNS.has(item.column) && name != null,
        }
      }),
    [all, evaluation.name],
  )
  if (series.length === 0) return <EvaluationTable evaluation={evaluation} />
  return (
    <div className="space-y-2">
      <LineChart
        series={series}
        xLabel={evaluation.x ?? undefined}
        integerX={false}
        label={`${evaluation.name} の曲線 (横軸 ${evaluation.x ?? ''}. 系列: ${series
          .map((item) => item.name)
          .join(', ')})`}
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

/** config の uplift の項目 (ML-Quest の効果の見積もりの骨組みの k, budget) */
function upliftSettings(config: Record<string, unknown> | null | undefined): {
  k: number | null
  budget: number | null
} {
  const section = config?.uplift
  const values =
    section && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {}
  const k = typeof values.k === 'number' && values.k > 0 && values.k <= 1 ? values.k : null
  const budget =
    typeof values.budget === 'number' && Number.isInteger(values.budget) && values.budget > 0
      ? values.budget
      : null
  return { k, budget }
}

/**
 * 効果を見積もるの評価の読み方と, 上位の割合 K と配る数の上限 (config の uplift.
 * 書いていない項目は出さない)
 */
function UpliftNote({ config }: { config: Record<string, unknown> | null | undefined }) {
  const { k, budget } = upliftSettings(config)
  const top = k != null ? `上位 ${formatPercent(k)}` : null
  // 上位 K 割の効果の差の呼び方 (K が分かれば % で)
  const lift = top ? `${top} の効果の差` : '上位 K 割の効果の差'
  const items: [string, string][] = []
  if (top) items.push(['上位の割合 K', top])
  if (budget != null) items.push(['配る数の上限', `${budget.toLocaleString()} 件`])
  return (
    <section
      aria-label="効果の見積もりの評価の読み方"
      className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm"
    >
      <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
        <Info className="size-4 text-ink-3" aria-hidden />
        効果の見積もりの評価
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
          効果 (uplift) は顧客ごとの, 処置したとき (クーポンを配ったときなど) の結果から,
          しないときの結果を引いた値の見積もりです. 処置の群は処置した行,
          対照の群は処置しなかった行です.
        </li>
        <li>
          1 人の顧客には処置したかしないかの片方の結果しか無いので,
          正解の効果は顧客ごとには見えません. 評価は, 効果の見積もりの高い順に並べた上位の行の中で,
          処置の群と対照の群の結果の平均の差を数えた値です.
        </li>
        <li>
          Qini の曲線 (qini_curve_&lt;分割&gt;) は, 横軸が効果の見積もりの高い順の上位の行の割合,
          縦軸が上位の行で処置によって増えた結果です. 破線のでたらめに配る線より上にあるほど,
          効果の高い顧客を上に並べられています.
        </li>
        <li>
          Qini の係数 (qini) は, 曲線とでたらめに配る線の間の面積を理想の並びの面積で割った値で,
          大きいほど良く, 1 は理想の並び, 0 はでたらめに配るのと同じです. {`${lift} (uplift_at_k)`}{' '}
          も大きいほど良く, 全体の効果の差 (effect) より大きければ,
          効果の高い順に選んで配る意味があります.
        </li>
        <li>
          推論の段階では, 効果の高い順に配る数の上限まで配ります.
          効果は無作為に配った記録を前提にした見積もりなので, 配った後の効果は,
          配る相手と配らない相手を無作為に分けて比べると確かめられます.
        </li>
      </ul>
    </section>
  )
}

/** config の price の項目 (ML-Quest の値段を変える判断の骨組みの candidates, max_change) */
function priceSettings(config: Record<string, unknown> | null | undefined): {
  candidates: number[] | null
  maxChange: number | null
} {
  const section = config?.price
  const values =
    section && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : {}
  // 候補は -1 より大きい有限の数の並びで, 今の値段の 0 を含む (骨組みと ML-Found の
  // profit_lift の決まり)
  const list = values.candidates
  const candidates =
    Array.isArray(list) &&
    list.includes(0) &&
    list.every((value) => typeof value === 'number' && Number.isFinite(value) && value > -1)
      ? (list as number[])
      : null
  const limit = values.max_change
  const maxChange = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? limit : null
  return { candidates, maxChange }
}

/**
 * 値段を変える判断の評価の読み方と, 変える割合の候補と値段を変える幅の上限 (config の
 * price. 書いていない項目と読めない項目は出さない)
 */
function PriceNote({ config }: { config: Record<string, unknown> | null | undefined }) {
  const { candidates, maxChange } = priceSettings(config)
  const items: [string, string][] = []
  if (candidates) {
    items.push([
      '変える割合の候補',
      candidates.map((value) => formatPercent(value, { signed: true })).join(', '),
    ])
  }
  if (maxChange != null) items.push(['値段を変える幅の上限 (守る指標)', formatPercent(maxChange)])
  return (
    <section
      aria-label="値段を変える判断の評価の読み方"
      className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm"
    >
      <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
        <Info className="size-4 text-ink-3" aria-hidden />
        値段を変える判断の評価
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
          試しに値段を変えた売れ行きの記録から, 値段を入力に入れて売れた数 (1 行の記録で売れた数)
          を予測し, 商品ごとに見込みの利益が最も大きい値段を選びます. 今の値段は,
          商品ごとの記録の値段の中央値 (商品の id の列が無ければ行の値段) です.
        </li>
        <li>
          売れた数の予測の誤差 (mae, rmse) は, 記録の値段での予測と記録の売れた数の差で,
          売れた数の単位です. どちらも小さいほど良く, rmse は大きく外れた予測を重く数えます.
        </li>
        <li>
          値段の弾力性 (elasticity) は, 今の値段を 1 % 上げたときに予測した売れた数が何 %
          変わるかの商品の平均です. -2 なら 2 % 減ります. 売れ行きの性質を読む値で,
          良し悪しの向きはありません.
        </li>
        <li>
          変える割合の候補は今の値段に対する割合で, +5 % は今の値段の 5 % 上げた値段です.
          値段を変える幅の上限 (守る指標) を超える候補は選びません. 今の値段 (0 %)
          はいつも選べるので, 選んだ値段の見込みの利益は今の値段より小さくなりません.
          値段を変える商品の数 (changed) は, 0 % でない割合を選んだ商品の数です.
        </li>
        <li>
          利益は (値段 − 原価) × 売れた数で, 原価の列が無ければ売上です. 見込みの利益 (profit,
          current_profit) は記録の売れた数でなく予測した売れた数から数えた見込みで, 商品ごとの 1
          行あたりの利益の和です. 選んだ値段と今の値段の見込みの利益の差 (profit_gain) と比
          (profit_ratio. 100 % は変わらない) は大きいほど良く, 予測が外れれば見込みも外れるので,
          売れた数の予測の誤差と一緒に読みます.
        </li>
        <li>
          推論の段階では, 新しい行の値段を今の値段として, 同じ候補と上限で値段を選びます.
          見込みは試しに値段を変えた記録を前提にするので, 値段を変えた後の利益は,
          値段を変える商品と変えない商品を無作為に分けて比べると確かめられます.
        </li>
      </ul>
    </section>
  )
}

/** 有限の正の数か (骨組みの品切れの損と売れ残りの損の決まり) */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * config の demand と order の項目 (ML-Quest の時間をまたぐ量の判断の骨組みの
 * demand.levels, order.shortage_cost, order.holding_cost, order.max_order). 読めない
 * 項目は null
 */
function demandSettings(config: Record<string, unknown> | null | undefined): {
  levels: number[] | null
  shortage: number | null
  holding: number | null
  maxOrder: number | null
} {
  const section = (name: string) => {
    const value = config?.[name]
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
  const demand = section('demand')
  const order = section('order')
  // 水準は 0 より大きく 1 より小さい数の小さい順の並び (骨組みの決まり)
  const list = demand.levels
  const levels =
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((value) => typeof value === 'number' && value > 0 && value < 1) &&
    list.every((value, index) => index === 0 || (list[index - 1] as number) < (value as number))
      ? (list as number[])
      : null
  const limit = order.max_order
  return {
    levels,
    shortage: isPositive(order.shortage_cost) ? order.shortage_cost : null,
    holding: isPositive(order.holding_cost) ? order.holding_cost : null,
    maxOrder: typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? limit : null,
  }
}

/**
 * 時間をまたぐ量の判断の評価の読み方と, 学んだ水準, 発注に使う水準 τ, 2 つの損と発注の
 * 数の上限 (config の demand と order. 書いていない項目と読めない項目は出さない)
 */
function DemandNote({ config }: { config: Record<string, unknown> | null | undefined }) {
  const { levels, shortage, holding, maxOrder } = demandSettings(config)
  const items: [string, string][] = []
  if (levels) items.push(['学んだ水準', levels.join(', ')])
  if (shortage != null && holding != null) {
    // 骨組みと同じ τ = 品切れの損 / (品切れの損 + 売れ残りの損). 2 進の丸めの端数は
    // 出さない
    const tau = Number((shortage / (shortage + holding)).toPrecision(10))
    items.push(['発注に使う水準 τ', String(tau)])
  }
  if (shortage != null) items.push(['品切れの損 (1 つ足りないとき)', String(shortage)])
  if (holding != null) items.push(['売れ残りの損 (1 つ余ったとき)', String(holding)])
  if (maxOrder != null) items.push(['発注の数の上限 (守る指標)', String(maxOrder)])
  return (
    <section
      aria-label="時間をまたぐ量の判断の評価の読み方"
      className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm"
    >
      <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
        <Info className="size-4 text-ink-3" aria-hidden />
        時間をまたぐ量の判断の評価
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
          商品と発注を決める日の行ごとに, 先の期間の需要 (売れる数の合計) の分位点を学んだ水準ごとに
          予測し, 水準 τ の分位点から在庫の数を引いた数を発注の数にします.
        </li>
        <li>
          需要の平均絶対誤差 (mae) は 0.5 の分位点の予測と実際の需要の差で, 需要の単位です.
          分位点の損失 (pinball_loss) は学んだ全ての水準の平均で,
          水準ごとの値は「水準ごとの分位点の損失」 の表に並びます. どちらも小さいほど良い値です.
        </li>
        <li>
          発注の数の損 (order_cost) は, 売れる数を在庫の数 + 発注の数として, 品切れの損 × 足りない数
          + 売れ残りの損 × 余った数を実際の需要で数えた和です. 前の期間と同じ数の発注での損
          (baseline_cost) と比べた差 (order_cost_saving) は大きいほど, 比 (order_cost_ratio. 100 %
          は変わらない) は小さいほど良い値です.
        </li>
        <li>
          発注の数は 0 から発注の数の上限 (守る指標) の間の整数で, 上限を超える数は上限で切ります.
          上限に当たった行の数 (capped) が多ければ, 上限が需要に対して小さい見込みです.
        </li>
        <li>
          商品ごとの発注の数の表 (demand_orders.csv) は, 分割ごとの発注を決める日の行の在庫の数, τ
          の分位点, 発注の数, 前の期間と先の期間の需要の合計です.
          推論の段階でも同じ決め方で発注の数を 決めます.
        </li>
      </ul>
    </section>
  )
}

// 時間をまたぐ量の判断の骨組みが実験のディレクトリに書く, 商品ごとの発注の数の表
const DEMAND_ORDERS_FILE = 'demand_orders.csv'

/** 商品ごとの発注の数の表 (実験の demand_orders.csv. 見本の CSV と同じく先頭の行を表にする) */
function DemandOrders({ url, file }: { url: string; file: RunFile }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{DEMAND_ORDERS_FILE}</span>
          <span className="text-sm font-normal text-ink-2">商品ごとの発注の数</span>
        </span>
      }
    >
      <CsvSample
        url={url}
        sample={{
          name: 'demand_orders',
          kind: 'file',
          path: file.path,
          size: file.size,
          newer_version: false,
        }}
        label="商品ごとの発注の数"
      />
    </Card>
  )
}

/**
 * データ全体の評価 (ML-Found の evaluations/). 守る指標を先頭に (並びはバックエンド).
 * 異常の検知, 効果を見積もる, 値段を変える判断, 時間をまたぐ量の判断の評価を持つ実験は,
 * 先頭に読み方と, config の K, 件数の上限, 値段の候補と上限, 水準と損と発注の数の上限を
 * 出す. 時間をまたぐ量の判断の実験は, 最後に商品ごとの発注の数の表 (files に
 * demand_orders.csv があれば) を出す
 */
export function EvaluationsTab({
  evaluations,
  config,
  files = [],
  projectId = '',
  runId = '',
}: {
  evaluations: Evaluation[]
  config?: Record<string, unknown> | null
  files?: RunFile[]
  projectId?: string
  runId?: string
}) {
  const { runFileUrl } = useApi()
  const anomaly = evaluations.some((evaluation) => isAnomalyEvaluation(evaluation.name))
  const uplift = evaluations.some((evaluation) => isUpliftEvaluation(evaluation.name))
  const price = evaluations.some((evaluation) => isPriceEvaluation(evaluation.name))
  const demand = evaluations.some((evaluation) => isDemandEvaluation(evaluation.name))
  const orders = demand ? files.find((file) => file.path === DEMAND_ORDERS_FILE) : undefined
  return (
    <div className="space-y-4">
      {anomaly && <AnomalyNote config={config} />}
      {uplift && <UpliftNote config={config} />}
      {price && <PriceNote config={config} />}
      {demand && <DemandNote config={config} />}
      {evaluations.map((evaluation) => (
        <Card
          key={evaluation.name}
          landmark={false}
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
      {orders && <DemandOrders url={runFileUrl(projectId, runId, orders.path)} file={orders} />}
    </div>
  )
}
