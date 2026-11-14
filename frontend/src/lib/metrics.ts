import type { History } from '../api/client'

/** 比べられる実験の数の上限 (グラフの系列の色の数) */
export const MAX_COMPARE = 8

/** 1 つのグラフにまとめる指標 (例: train/loss, train_eval/loss, valid/loss を loss に) */
export interface MetricGroup {
  name: string
  keys: string[]
}

// train_eval は, 学習用データを推論モードで評価し直した値 (ML-Found の trainer.eval_train)
const PHASES = ['train', 'train_eval', 'valid']

/** 学習用データの指標 (学習中の値と, 推論モードで評価し直した値) の接頭辞 */
export const TRAIN_PREFIXES = ['train/', 'train_eval/']

/** history.csv の列を, 学習用と検証用を重ねる指標ごとにまとめる */
export function groupMetrics(columns: string[]): MetricGroup[] {
  const groups = new Map<string, string[]>()
  for (const column of columns) {
    if (column === 'epoch') continue
    const [phase, ...rest] = column.split('/')
    const name = phase && PHASES.includes(phase) && rest.length > 0 ? rest.join('/') : column
    groups.set(name, [...(groups.get(name) ?? []), column])
  }

  // 損失を先頭に, 学習率などの学習用と検証用に分かれない値を末尾に
  const entries = [...groups.entries()].map(([name, keys]) => ({ name, keys }))
  const rank = (group: MetricGroup) => {
    if (group.name === 'loss') return 0
    if (group.keys.every((key) => !key.includes('/'))) return 2
    return 1
  }
  return entries.sort((a, b) => rank(a) - rank(b))
}

/** 入れ子の config を「trainer.epochs」の形の平らな辞書にする */
export function flattenConfig(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {}
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return prefix ? { [prefix]: {} } : {}
  return Object.assign(
    {},
    ...entries.map(([key, child]) => flattenConfig(child, prefix ? `${prefix}.${key}` : key)),
  ) as Record<string, unknown>
}

/** 複数の config で値が違う項目を取り出す */
export function diffConfigs(configs: Record<string, unknown>[]): string[] {
  const flat = configs.map((config) => flattenConfig(config))
  const keys = new Set(flat.flatMap((item) => Object.keys(item)))
  return [...keys]
    .filter((key) => {
      const values = flat.map((item) => JSON.stringify(item[key] ?? null))
      return new Set(values).size > 1
    })
    .sort()
}

/** 実験の config の差分を「trainer.epochs=10」の短い文字列の一覧にする */
export function summarizeDiff(diff: Record<string, unknown>): string[] {
  return Object.entries(diff).map(([key, value]) => {
    const experiment =
      value && typeof value === 'object' && 'experiment' in value
        ? (value as { experiment: unknown }).experiment
        : value
    const shown = typeof experiment === 'string' ? experiment : JSON.stringify(experiment)
    return `${key}=${shown}`
  })
}

/** 列の値をエポックとの組にする */
export function toPoints(history: History, key: string): [number, number | null][] {
  return history.rows.map((row, index) => [row.epoch ?? index + 1, row[key] ?? null])
}

/** 2 つの系列の全ての点 (エポックと値) が同じかどうか */
function samePoints(a: [number, number | null][], b: [number, number | null][]): boolean {
  if (a.length !== b.length) return false
  return a.every(([x, y], index) => x === b[index]![0] && y === b[index]![1])
}

/**
 * 全ての点が同じ値の系列 (グラフで線が完全に重なり, 下の線が見えないもの) を,
 * 名前の組にまとめて返す. 値の無い点だけの系列は対象外
 */
export function identicalSeries(
  series: { name: string; points: [number, number | null][] }[],
): string[][] {
  const groups: { points: [number, number | null][]; names: string[] }[] = []
  for (const item of series) {
    if (!item.points.some(([, value]) => value != null)) continue
    const group = groups.find((candidate) => samePoints(candidate.points, item.points))
    if (group) group.names.push(item.name)
    else groups.push({ points: item.points, names: [item.name] })
  }
  return groups.filter((group) => group.names.length > 1).map((group) => group.names)
}
