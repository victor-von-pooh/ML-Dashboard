import type { RunParams } from '../api/client'

export type ParamValue = RunParams['params'][string]

/** 実験によって値が違う config の項目. 数値だけの項目かどうかも返す */
export interface VaryingParam {
  key: string
  numeric: boolean
  values: number
}

/** 結果として選べる値 (ベストか, 最後のエポックの指標) */
export interface MetricOption {
  id: string
  label: string
}

/** 実験の間で値が違う項目を, 違う値の数が少ない順に並べる */
export function varyingParams(runs: RunParams[]): VaryingParam[] {
  const keys = new Set(runs.flatMap((run) => Object.keys(run.params)))
  const result: VaryingParam[] = []
  for (const key of keys) {
    const values = runs.map((run) => run.params[key] ?? null)
    const distinct = new Set(values.map((value) => JSON.stringify(value)))
    if (distinct.size < 2) continue
    const numeric = values.every((value) => value === null || typeof value === 'number')
    result.push({ key, numeric, values: distinct.size })
  }
  return result.sort((a, b) => a.values - b.values || a.key.localeCompare(b.key))
}

/** 結果として選べる値の一覧 */
export function metricOptions(runs: RunParams[]): MetricOption[] {
  const finals = new Set(runs.flatMap((run) => Object.keys(run.final_metrics)))
  const monitor = runs.find((run) => run.best)?.best?.monitor
  return [
    { id: 'best', label: monitor ? `ベスト (${monitor})` : 'ベスト' },
    ...[...finals].sort().map((key) => ({ id: `final:${key}`, label: `最終 ${key}` })),
  ]
}

/** 実験から選んだ結果の値を取り出す */
export function metricValue(run: RunParams, metric: string): number | null {
  if (metric === 'best') return run.best?.value ?? null
  return run.final_metrics[metric.replace(/^final:/, '')] ?? null
}

/** 値を表に出す文字列にする */
export function formatParam(value: ParamValue | undefined): string {
  if (value === undefined || value === null) return 'null'
  return String(value)
}

export interface GroupRow {
  value: string
  count: number
  best: number
  mean: number
}

/** 項目の値ごとに, 結果の最良値と平均をまとめる */
export function groupByParam(
  runs: RunParams[],
  key: string,
  metric: string,
  higherIsBetter: boolean,
): GroupRow[] {
  const groups = new Map<string, number[]>()
  for (const run of runs) {
    const value = metricValue(run, metric)
    if (value === null) continue
    const label = formatParam(run.params[key])
    groups.set(label, [...(groups.get(label) ?? []), value])
  }
  return [...groups.entries()]
    .map(([value, values]) => ({
      value,
      count: values.length,
      best: higherIsBetter ? Math.max(...values) : Math.min(...values),
      mean: values.reduce((sum, item) => sum + item, 0) / values.length,
    }))
    .sort((a, b) => (higherIsBetter ? b.best - a.best : a.best - b.best))
}

export interface Sensitivity {
  key: string
  spread: number
  groups: number
}

/** 値を変えたときに結果の最良値がどれだけ動くかで, 項目を並べる */
export function sensitivity(
  runs: RunParams[],
  params: VaryingParam[],
  metric: string,
  higherIsBetter: boolean,
): Sensitivity[] {
  return params
    .map((param) => {
      const rows = groupByParam(runs, param.key, metric, higherIsBetter)
      const bests = rows.map((row) => row.best)
      return {
        key: param.key,
        spread: bests.length > 1 ? Math.max(...bests) - Math.min(...bests) : 0,
        groups: rows.length,
      }
    })
    .filter((item) => item.groups > 1)
    .sort((a, b) => b.spread - a.spread)
}
