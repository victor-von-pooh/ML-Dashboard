import type { BestValue, History } from '../api/client'

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

/** 学習曲線の既定の横軸 (history.csv の epoch. 無い記録では行の番号) */
export const EPOCH_AXIS = 'epoch'

/**
 * 列の値を横軸の値との組にする. 横軸は既定でエポック, 他の列 (環境のステップ数など)
 * を選んだ場合は, その列の値の無い行を除く
 */
export function toPoints(
  history: History,
  key: string,
  x: string = EPOCH_AXIS,
): [number, number | null][] {
  if (x === EPOCH_AXIS) {
    return history.rows.map((row, index) => [row.epoch ?? index + 1, row[key] ?? null])
  }
  return history.rows.flatMap<[number, number | null]>((row) => {
    const position = row[x]
    return position == null ? [] : [[position, row[key] ?? null]]
  })
}

/**
 * 実験が横軸に使える列か. エポックは全ての実験で使え, 他の列はバックエンドが
 * 横軸の候補 (エポックごとに増え続ける列) とした場合だけ
 */
export function hasAxis(history: History, x: string): boolean {
  return x === EPOCH_AXIS || (history.x_columns ?? []).includes(x)
}

/** 実験の横軸の候補を, エポックを先頭に重ねずに並べる */
export function axisOptions(histories: History[]): string[] {
  const options = histories.flatMap((history) => history.x_columns ?? [])
  return [...new Set([EPOCH_AXIS, ...options])]
}

/** エポックの位置を, 選んだ横軸の上の位置にする (目印のため). 無ければ null */
export function axisAt(history: History, x: string, epoch: number): number | null {
  if (x === EPOCH_AXIS) return epoch
  // 再開で同じエポックの行が重なる場合は, 最後の (使われた) 行
  const row = history.rows.findLast((item) => item.epoch === epoch)
  return row?.[x] ?? null
}

/** 横軸の選択肢の表示名 (エポックは日本語, 他の列は列の名前のまま) */
export function axisLabel(x: string): string {
  return x === EPOCH_AXIS ? 'エポック' : x
}

/**
 * 横軸の左端. エポック以外の列 (環境のステップ数など) は, 値が全て 0 以上なら 0 から描く
 * (学習を始めた時点からの進み具合として読むため). それ以外は undefined (最初の値)
 */
export function axisStart(histories: History[], x: string): number | undefined {
  if (x === EPOCH_AXIS) return undefined
  const nonNegative = histories.every((history) =>
    history.rows.every((row) => row[x] == null || row[x] >= 0),
  )
  return nonNegative ? 0 : undefined
}

/** 横軸の値が全て整数か (目盛りを整数に限るため) */
export function integerAxis(histories: History[], x: string): boolean {
  if (x === EPOCH_AXIS) return true
  return histories.every((history) =>
    history.rows.every((row) => row[x] == null || Number.isInteger(row[x])),
  )
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

/** 系列の点の描き方 (孤立した点の記号と, 値の無い点を飛ばしてつなぐか) */
export interface PointStyle {
  /** 前後の点がどちらも値を持たない, 値のある点 (線を引けないので記号で描く) の位置 */
  isolated: Set<number>
  /** 値のある点が 2 つ以上で全て孤立した系列 (何エポックかおきに記録する指標) */
  sparse: boolean
}

/** 値の無い点で途切れる線では見えない点を探し, 系列の描き方を決める */
export function pointStyle(points: [number, number | null][]): PointStyle {
  const has = (index: number) => points[index] !== undefined && points[index]![1] != null
  const isolated = new Set<number>()
  let valued = 0
  points.forEach((_, index) => {
    if (!has(index)) return
    valued += 1
    if (!has(index - 1) && !has(index + 1)) isolated.add(index)
  })
  return { isolated, sparse: valued >= 2 && isolated.size === valued }
}

/** config の ML-Found の検証の間隔 (trainer.valid_every_n_epochs. 無いか読めなければ 1) */
export function validInterval(config: Record<string, unknown> | null | undefined): number {
  const trainer = config?.trainer
  const value =
    trainer && typeof trainer === 'object'
      ? (trainer as Record<string, unknown>).valid_every_n_epochs
      : undefined
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : 1
}

/**
 * 検証の間隔を空けた実験で, 検証したエポックだけに値のある指標か (valid/ と train_eval/).
 * 値の無いエポックを飛ばしてつなぎ, 記録した点に記号を付ける
 */
export function judgedOnly(key: string, interval: number): boolean {
  return interval > 1 && (key.startsWith('valid/') || key.startsWith('train_eval/'))
}

/** 指標の良い向き (大きいほど良いか, 小さいほど良いか) */
export type Direction = 'max' | 'min'

// 名前から向きを推測する指標 (小さいほど良いものを先に判定)
const LOWER_IS_BETTER = /loss|err|mae|mse|rmse|nelbo|kl|recon|residual|boundary|perplexity|time/i
// 語として現れる場合だけ小さいほど良い指標. 部分一致では confidence や fidelity まで
// 小さいほど良いと取り違えるため. fid は生成の画像の FID. chamfer は点群の Chamfer 距離.
// distance は距離 (例えば作った表と本物の表の列ごとの分布の近さ column_distance)
const LOWER_WORDS = /(^|[/_.-])(fid|chamfer|distance)($|[/_.-])/i
// ndcg と mrr は並べる課題の指標 (recall_at_k は recall で大きいほど良い)
const HIGHER_IS_BETTER = /acc|auc|^ap$|\/ap$|f1|precision|recall|r2|score|iou|psnr|ssim|ndcg|mrr/i

/** 指標の名前から良い向きを推測する. 分からなければ null */
export function guessDirection(name: string): Direction | null {
  if (LOWER_IS_BETTER.test(name) || LOWER_WORDS.test(name)) return 'min'
  if (HIGHER_IS_BETTER.test(name)) return 'max'
  return null
}

/** 列の良い向きと, 名前から推測したか */
export interface ColumnDirection {
  direction: Direction
  guessed: boolean
}

/**
 * history.csv の列の良い向き. 監視する指標は ML-Found の向き (trainer.mode. 比べる
 * 実験で向きが食い違う場合は推測に任せる), その他は名前から推測する. 学習率の列と,
 * 推測できない列は null
 */
export function columnDirection(
  key: string,
  bests: (Pick<BestValue, 'monitor' | 'mode'> | null | undefined)[] = [],
): ColumnDirection | null {
  const modes = new Set(bests.filter((best) => best?.monitor === key).map((best) => best!.mode))
  const [mode] = modes
  if (modes.size === 1 && mode) return { direction: mode, guessed: false }
  if (key === 'lr' || key.startsWith('lr_')) return null
  const direction = guessDirection(key)
  return direction ? { direction, guessed: true } : null
}

/** 良い向きの表示 */
export function directionLabel(direction: Direction): string {
  return direction === 'max' ? '大きいほど良い' : '小さいほど良い'
}
