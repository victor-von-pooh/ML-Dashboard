import type { RunParams } from '../api/client'
import { valueKey } from './evaluations'
import { guessDirection, metricLabel, type Direction } from './metrics'

export type ParamValue = RunParams['params'][string]

/** 実験によって値が違う config の項目 */
export interface VaryingParam {
  key: string
  /** 値のある実験が全て数値 */
  numeric: boolean
  /** 違う値の数 (項目が無い実験も 1 つの値として数える) */
  values: number
  /** 全ての実験にこの項目があるか (ML-Found の版の違いで増えた項目などは false) */
  complete: boolean
  /** 結果に関係しにくい記録や環境の設定 (乱数シード, デバイス, 進捗バーなど) */
  noise: boolean
}

// 結果に関係しにくい設定の項目 (分析の既定と順位の上位から外す)
const NOISE = [
  /^experiment\./,
  /(^|[._])seed/,
  /^trainer\.progress_bar/,
  /^trainer\.checkpoint\./,
  /^trainer\.log_/,
  /^trainer\.resume_from$/,
  /num_workers$/,
]

/** 結果に関係しにくい設定の項目か */
export function isNoise(key: string): boolean {
  return NOISE.some((pattern) => pattern.test(key))
}

/** 結果として選べる値 (ベストか, 最後のエポックの指標か, 一覧と比較の評価の値) */
export interface MetricOption {
  id: string
  label: string
}

export type { Direction }

// 項目が無い実験をまとめる値の鍵と表示
const MISSING = '__missing__'
export const MISSING_LABEL = '(項目なし)'

/** 値をまとめるための鍵. 型が違う同じ見た目の値 (1 と "1" など) は分ける */
export function paramKey(value: ParamValue | undefined): string {
  return value === undefined ? MISSING : JSON.stringify(value)
}

/** 値を表に出す文字列にする. 文字列は数値や null と見分けられるように引用符で囲む */
export function formatParam(value: ParamValue | undefined, quote = false): string {
  if (value === undefined) return MISSING_LABEL
  if (value === null) return 'null'
  if (typeof value === 'string' && quote) return JSON.stringify(value)
  return String(value)
}

/** 項目の値の中に, 見た目が同じで型が違う値があるか */
export function needsQuote(runs: RunParams[], key: string): boolean {
  const labels = new Map<string, string>()
  for (const run of runs) {
    const value = run.params[key]
    const label = formatParam(value)
    const exact = paramKey(value)
    if (labels.has(label) && labels.get(label) !== exact) return true
    labels.set(label, exact)
  }
  return false
}

/** 実験の間で値が違う項目を, 全ての実験にある項目から, 違う値の数が少ない順に並べる */
export function varyingParams(runs: RunParams[]): VaryingParam[] {
  const keys = new Set(runs.flatMap((run) => Object.keys(run.params)))
  const result: VaryingParam[] = []
  for (const key of keys) {
    const values = runs.map((run) => run.params[key])
    const distinct = new Set(values.map(paramKey))
    if (distinct.size < 2) continue
    const present = values.filter((value) => value !== undefined && value !== null)
    result.push({
      key,
      numeric: present.length > 0 && present.every((value) => typeof value === 'number'),
      values: distinct.size,
      complete: values.every((value) => value !== undefined),
      noise: isNoise(key),
    })
  }
  // 全ての実験にあり結果に関係しそうな項目を先に, 値の数が多い順
  const rank = (item: VaryingParam) => Number(item.noise) * 2 + Number(!item.complete)
  return result.sort(
    (a, b) => rank(a) - rank(b) || b.values - a.values || a.key.localeCompare(b.key),
  )
}

/** 評価の値の結果の id の頭 (後ろは <評価の名前>:<列>) */
const EVALUATION_PREFIX = 'eval:'

/** 結果として選べる値の一覧 (評価の値は, 一覧と比較と同じ <評価の名前>:<列> の名前) */
export function metricOptions(runs: RunParams[]): MetricOption[] {
  const finals = new Set(runs.flatMap((run) => Object.keys(run.final_metrics)))
  const monitor = runs.find((run) => run.best)?.best?.monitor
  const evaluations = new Set(
    runs.flatMap((run) => (run.evaluations ?? []).map((value) => valueKey(value))),
  )
  return [
    { id: 'best', label: monitor ? `ベスト (${monitor})` : 'ベスト' },
    // 学習率 (名前付きの複数の Optimizer の lr_<名前> も) は結果ではないので除外
    ...[...finals]
      .filter((key) => key !== 'lr' && !key.startsWith('lr_'))
      .sort()
      .map((key) => ({ id: `final:${key}`, label: `最終 ${key}` })),
    ...[...evaluations].sort().map((key) => {
      // 日本語の名前は一覧と比較と同じ (知らない列は名前のまま)
      // 評価の名前は : を含まないので, 最初の : で分ける (列は : を含みうる)
      const evaluation = key.slice(0, key.indexOf(':'))
      const column = key.slice(key.indexOf(':') + 1)
      const named = metricLabel(column, evaluation)?.label
      return {
        id: `${EVALUATION_PREFIX}${key}`,
        label: named ? `評価 ${key} (${named})` : `評価 ${key}`,
      }
    }),
  ]
}

/** 実験の評価の値を, 結果の id から引く (値の無い実験は undefined) */
function evaluationOf(run: RunParams, metric: string) {
  const key = metric.slice(EVALUATION_PREFIX.length)
  return (run.evaluations ?? []).find((value) => valueKey(value) === key)
}

/** 実験から選んだ結果の値を取り出す */
export function metricValue(run: RunParams, metric: string): number | null {
  if (metric === 'best') return run.best?.value ?? null
  if (metric.startsWith(EVALUATION_PREFIX)) return evaluationOf(run, metric)?.value ?? null
  return run.final_metrics[metric.replace(/^final:/, '')] ?? null
}

/**
 * 結果の値は大きいほど良いか小さいほど良いかを決める.
 * ベストと監視する指標は ML-Found の向き, 評価の値は評価の向き (一覧と比較と同じ. 実験の多い向き),
 * その他は指標の名前から推測する
 */
export function metricDirection(runs: RunParams[], metric: string): Direction {
  if (metric.startsWith(EVALUATION_PREFIX)) {
    let higher = 0
    let lower = 0
    for (const run of runs) {
      const better = evaluationOf(run, metric)?.better
      if (better === 'higher') higher += 1
      if (better === 'lower') lower += 1
    }
    if (higher !== lower) return higher > lower ? 'max' : 'min'
    const key = metric.slice(EVALUATION_PREFIX.length)
    const column = key.slice(key.indexOf(':') + 1)
    return guessDirection(column) ?? 'min'
  }
  // 実験の多い向きの監視する指標を基準にする
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (!run.best) continue
    const key = `${run.best.monitor}|${run.best.mode}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const [monitor, mode] = top ? top.split('|') : [undefined, undefined]
  const name = metric.replace(/^final:/, '')
  if (metric === 'best' || name === monitor) return mode === 'max' ? 'max' : 'min'
  return guessDirection(name) ?? 'min'
}

export interface GroupRow {
  key: string
  value: string
  count: number
  best: number
  mean: number
}

/** 項目の値ごとに, 結果の最良値と平均をまとめ, 良い順に並べる */
export function groupByParam(
  runs: RunParams[],
  key: string,
  metric: string,
  direction: Direction,
): GroupRow[] {
  const quote = needsQuote(runs, key)
  const groups = new Map<string, { label: string; values: number[] }>()
  for (const run of runs) {
    const value = metricValue(run, metric)
    if (value === null) continue
    const param = run.params[key]
    const group = groups.get(paramKey(param)) ?? { label: formatParam(param, quote), values: [] }
    group.values.push(value)
    groups.set(paramKey(param), group)
  }
  const higher = direction === 'max'
  return [...groups.entries()]
    .map(([groupKey, { label, values }]) => ({
      key: groupKey,
      value: label,
      count: values.length,
      best: higher ? Math.max(...values) : Math.min(...values),
      mean: values.reduce((sum, item) => sum + item, 0) / values.length,
    }))
    .sort((a, b) => (higher ? b.best - a.best : a.best - b.best) || a.value.localeCompare(b.value))
}

export interface Sensitivity {
  /** 同時に変えた項目をまとめた名前 */
  keys: string[]
  spread: number
  groups: number
  /** 実験が 1 つしか無い値があるか (偶然に左右されやすい) */
  single: boolean
  complete: boolean
  noise: boolean
}

/** 値を変えたときに結果の最良値がどれだけ動くかで, 項目を並べる.
 * いつも同時に変えた項目は区別できないのでまとめる */
export function sensitivity(
  runs: RunParams[],
  params: VaryingParam[],
  metric: string,
  direction: Direction,
): Sensitivity[] {
  // 実験の分け方が同じ項目をまとめる
  const merged = new Map<string, VaryingParam[]>()
  for (const param of params) {
    const signature = partition(runs, param.key)
    merged.set(signature, [...(merged.get(signature) ?? []), param])
  }
  return [...merged.values()]
    .map((group) => {
      const first = group[0]!
      const rows = groupByParam(runs, first.key, metric, direction)
      const bests = rows.map((row) => row.best)
      return {
        keys: group.map((param) => param.key),
        spread: bests.length > 1 ? Math.max(...bests) - Math.min(...bests) : 0,
        groups: rows.length,
        single: rows.some((row) => row.count === 1),
        complete: group.every((param) => param.complete),
        noise: group.every((param) => param.noise),
      }
    })
    .filter((item) => item.groups > 1)
    .sort(
      (a, b) =>
        Number(a.noise) - Number(b.noise) ||
        Number(b.complete) - Number(a.complete) ||
        b.spread - a.spread,
    )
}

/** 項目の値で実験をどう分けたかを, 値に関係なく比べられる形にする */
function partition(runs: RunParams[], key: string): string {
  const seen = new Map<string, number>()
  return runs
    .map((run) => {
      const value = paramKey(run.params[key])
      if (!seen.has(value)) seen.set(value, seen.size)
      return seen.get(value)
    })
    .join(',')
}
