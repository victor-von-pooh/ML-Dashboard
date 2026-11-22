import type { BestValue, History, RunDetail } from '../api/client'
import type { ChartSeries } from '../components/LineChart'
import {
  TRAIN_PREFIXES,
  columnDirection,
  groupMetrics,
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

/**
 * 全ての実験の列を, 指標の順にそろえて 1 つの指標ごとのグラフにする.
 * 検証用がある指標の学習用は, showTrain の場合だけ出す
 */
export function compareCharts(entries: CompareEntry[], showTrain: boolean): CompareChart[] {
  const allColumns = [...new Set(entries.flatMap((entry) => entry.history.columns))]
  return groupMetrics(allColumns)
    .flatMap((group) => group.keys)
    .filter((key) => {
      const prefix = TRAIN_PREFIXES.find((item) => key.startsWith(item))
      return showTrain || !prefix || !allColumns.includes(key.replace(prefix, 'valid/'))
    })
    .map((column) => {
      const having = entries.filter((entry) => entry.history.columns.includes(column))
      const missing = entries.filter((entry) => !entry.history.columns.includes(column))
      const judged = (entry: CompareEntry) => judgedOnly(column, validInterval(entry.config))
      const series: ChartSeries[] = having.map((entry) => ({
        name: entry.label,
        color: entry.color,
        points: toPoints(entry.history, column),
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
