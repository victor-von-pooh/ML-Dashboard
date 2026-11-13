import type { History } from '../api/client'

/** 比べられる実験の数の上限 (グラフの系列の色の数) */
export const MAX_COMPARE = 8

/** 1 つのグラフにまとめる指標 (例: train/loss と valid/loss を loss に) */
export interface MetricGroup {
  name: string
  keys: string[]
}

const PHASES = ['train', 'valid']

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

/**
 * 更新ごとの学習率を, エポックの軸の上の点にする.
 * エポック e の更新は e から e + 1 の間に等間隔に並べ, エポックの最初の更新を
 * エポックを始めた時点の学習率 (history の lr) と同じ位置にする
 */
export function lrStepPoints(
  steps: { step: number; epoch: number; lr?: number | null }[],
): [number, number | null][] {
  // エポックごとの最初の更新の番号と, 1 エポックの更新の数 (次のエポックの最初との差)
  const firsts = new Map<number, number>()
  for (const item of steps) {
    if (!firsts.has(item.epoch)) firsts.set(item.epoch, item.step)
  }
  const epochs = [...firsts.keys()].sort((a, b) => a - b)
  const counts = new Map<number, number>()
  epochs.forEach((epoch, index) => {
    const next = epochs[index + 1]
    const first = firsts.get(epoch)!
    if (next !== undefined) {
      counts.set(epoch, firsts.get(next)! - first)
    } else {
      // 最後のエポックは, 前のエポックの数か, 記録の最後までの数
      const last = Math.max(
        ...steps.filter((item) => item.epoch === epoch).map((item) => item.step),
      )
      const previous = index > 0 ? counts.get(epochs[index - 1]!) : undefined
      counts.set(epoch, Math.max(previous ?? 0, last - first + 1))
    }
  })
  return steps.map((item) => {
    const count = Math.max(counts.get(item.epoch) ?? 1, 1)
    const offset = (item.step - firsts.get(item.epoch)!) / count
    return [item.epoch + offset, item.lr ?? null]
  })
}
