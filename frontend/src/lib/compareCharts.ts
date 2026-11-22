import type { BestValue, History, RunDetail } from '../api/client'
import type { ChartSeries } from '../components/LineChart'
import {
  EPOCH_AXIS,
  TRAIN_PREFIXES,
  columnDirection,
  groupMetrics,
  hasAxis,
  identicalSeries,
  judgedOnly,
  toPoints,
  validInterval,
  type ColumnDirection,
} from './metrics'

/** 比べる 1 つの実験 (表示の名前, 系列の色, 指標の推移, config, ベスト) */
export interface CompareEntry {
  label: string
  color: string
  history: History
  config: RunDetail['config']
  best?: BestValue | null
}

/** 比べの 1 つの指標のグラフ */
export interface CompareChart {
  column: string
  series: ChartSeries[]
  /** 検証の間隔を空けた実験 (検証したエポックだけを点で示してつなぐ) */
  sparse: string[]
  /** この指標が無い実験 */
  missing: string[]
  /** 線が重なっている実験の組 */
  identical: string[][]
  /** 良い向き (監視する指標は実験の向き, 他は指標の名前から推測) */
  direction: ColumnDirection | null
}

/** 選んだ横軸の列が無い (か, 増え続けない) ので, グラフに出さない実験の名前 */
export function withoutAxis(entries: CompareEntry[], x: string): string[] {
  return entries.filter((entry) => !hasAxis(entry.history, x)).map((entry) => entry.label)
}

/**
 * 全ての実験の列を, 指標の順にそろえて 1 つの指標ごとのグラフにする.
 * 検証用がある指標の学習用は, showTrain の場合だけ出す. 横軸 x にエポック以外の列を
 * 選んだ場合は, その列を横軸に使える実験だけを描き, 横軸の列そのもののグラフは出さない
 */
export function compareCharts(
  entries: CompareEntry[],
  showTrain: boolean,
  x: string = EPOCH_AXIS,
): CompareChart[] {
  const drawn = entries.filter((entry) => hasAxis(entry.history, x))
  const allColumns = [...new Set(drawn.flatMap((entry) => entry.history.columns))]
  return groupMetrics(allColumns)
    .flatMap((group) => group.keys)
    .filter((key) => {
      if (x !== EPOCH_AXIS && key === x) return false
      const prefix = TRAIN_PREFIXES.find((item) => key.startsWith(item))
      return showTrain || !prefix || !allColumns.includes(key.replace(prefix, 'valid/'))
    })
    .map((column) => {
      const having = drawn.filter((entry) => entry.history.columns.includes(column))
      const missing = drawn.filter((entry) => !entry.history.columns.includes(column))
      const judged = (entry: CompareEntry) => judgedOnly(column, validInterval(entry.config))
      const series: ChartSeries[] = having.map((entry) => ({
        name: entry.label,
        color: entry.color,
        points: toPoints(entry.history, column, x),
        sparse: judged(entry) || undefined,
      }))
      return {
        column,
        series,
        sparse: having.filter(judged).map((entry) => entry.label),
        missing: missing.map((entry) => entry.label),
        identical: identicalSeries(series),
        direction: columnDirection(
          column,
          having.map((entry) => entry.best),
        ),
      }
    })
}
