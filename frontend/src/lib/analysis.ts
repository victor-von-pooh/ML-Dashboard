import type { RunParams } from '../api/client'

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

/** 結果として選べる値 (ベストか, 最後のエポックの指標) */
export interface MetricOption {
  id: string
  label: string
}

export type Direction = 'max' | 'min'

// 項目が無い実験をまとめる値の鍵と表示
const MISSING = '__missing__'
export const MISSING_LABEL = '(項目なし)'

/** 値をまとめるための鍵. 型が違う同じ見た目の値 (1 と "1" など) は分ける */
export function paramKey(value: ParamValue | undefined): string {
  return value === undefined ? MISSING : JSON.stringify(value)
}

/** 値を表に出す文字列にする */
export function formatParam(value: ParamValue | undefined): string {
  if (value === undefined) return MISSING_LABEL
  if (value === null) return 'null'
  return String(value)
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

/** 結果として選べる値の一覧 */
export function metricOptions(runs: RunParams[]): MetricOption[] {
  const finals = new Set(runs.flatMap((run) => Object.keys(run.final_metrics)))
  const monitor = runs.find((run) => run.best)?.best?.monitor
  return [
    { id: 'best', label: monitor ? `ベスト (${monitor})` : 'ベスト' },
    // 学習率は結果ではないので除外
    ...[...finals]
      .filter((key) => key !== 'lr')
      .sort()
      .map((key) => ({ id: `final:${key}`, label: `最終 ${key}` })),
  ]
}

/** 実験から選んだ結果の値を取り出す */
export function metricValue(run: RunParams, metric: string): number | null {
  if (metric === 'best') return run.best?.value ?? null
  return run.final_metrics[metric.replace(/^final:/, '')] ?? null
}

// 名前から向きを推測する指標 (小さいほど良いものを先に判定)
const LOWER_IS_BETTER = /loss|err|mae|mse|rmse|nelbo|kl|recon|residual|boundary|perplexity|time/i
const HIGHER_IS_BETTER = /acc|auc|^ap$|\/ap$|f1|precision|recall|r2|score|iou|psnr|ssim/i

/**
 * 結果の値は大きいほど良いか小さいほど良いかを決める.
 * ベストと監視する指標は ML-Found の向き, その他は指標の名前から推測する
 */
export function metricDirection(runs: RunParams[], metric: string): Direction {
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
  if (LOWER_IS_BETTER.test(name)) return 'min'
  if (HIGHER_IS_BETTER.test(name)) return 'max'
  return 'min'
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
  const groups = new Map<string, { label: string; values: number[] }>()
  for (const run of runs) {
    const value = metricValue(run, metric)
    if (value === null) continue
    const param = run.params[key]
    const group = groups.get(paramKey(param)) ?? { label: formatParam(param), values: [] }
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
