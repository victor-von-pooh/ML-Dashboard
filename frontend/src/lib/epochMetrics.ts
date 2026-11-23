import type { BestValue, History, HistoryRow } from '../api/client'
import { columnDirection, groupMetrics, judgedOnly, type ColumnDirection } from './metrics'

/** 指標の列の分け方 (学習用, 学習用データの評価し直し, 検証用, どれでもない列) */
export type Phase = 'train' | 'train_eval' | 'valid' | 'other'

/** 表の列の順 */
const PHASE_ORDER: Phase[] = ['train', 'train_eval', 'valid', 'other']

/** 表の列の見出し */
export const PHASE_LABELS: Record<Phase, string> = {
  train: '学習用',
  train_eval: '学習用 (評価し直し)',
  valid: '検証用',
  other: 'その他の値 (学習率など)',
}

/**
 * 値に付ける印. best は監視する指標の, モデルに選ばれたエポック (run.json のベスト) の値.
 * guessed は監視しない列の, 記録した全てのエポックの中で最も良い値 (向きは名前から推測)
 */
export type CellMark = 'best' | 'guessed' | null

/** 1 つの列の, 選んだエポックの値 */
export interface EpochCell {
  key: string
  value: number | null
  mark: CellMark
  /** 検証の間隔を空けた実験で, このエポックを検証していないために値が無いか */
  skipped: boolean
}

/** 1 つの指標 (学習用と検証用をまとめたもの) の行 */
export interface EpochMetricRow {
  name: string
  direction: ColumnDirection | null
  /** ベストモデルを選ぶ監視する指標の行か */
  monitor: boolean
  cells: Partial<Record<Phase, EpochCell>>
}

/** 選んだエポックの指標の表 */
export interface EpochMetrics {
  phases: Phase[]
  rows: EpochMetricRow[]
  /** 検証していないために値の無い列があるか */
  skipped: boolean
  /** 検証の間隔の他の理由で値の無い列があるか */
  missing: boolean
  /** 推測した向きで最も良い値の印を付けた列があるか */
  guessed: boolean
}

/** history.csv をエポックで引けるようにしたもの (見本のタブで 1 回だけ作る) */
export interface HistoryIndex {
  columns: string[]
  /** エポックごとの行. 再開で同じエポックの行が重なる場合は最後の (使われた) 行 */
  rows: Map<number, HistoryRow>
  /** 監視しない列の, 推測した向きで最も良い値 (向きの分からない列は無し) */
  bests: Map<string, number>
}

function phaseOf(key: string): Phase {
  const [phase, ...rest] = key.split('/')
  if (rest.length === 0) return 'other'
  return phase === 'train' || phase === 'train_eval' || phase === 'valid' ? phase : 'other'
}

/** history.csv をエポックごとの行と, 列ごとの最も良い値にまとめる */
export function indexHistory(history: History, best: BestValue | null | undefined): HistoryIndex {
  const rows = new Map<number, HistoryRow>()
  for (const row of history.rows) {
    if (row.epoch != null) rows.set(row.epoch, row)
  }
  const bests = new Map<string, number>()
  for (const key of history.columns) {
    if (key === 'epoch' || key === best?.monitor) continue
    const direction = columnDirection(key, [best])
    if (!direction) continue
    const better = direction.direction === 'max' ? Math.max : Math.min
    let top: number | null = null
    for (const row of rows.values()) {
      const value = row[key]
      if (value == null || !Number.isFinite(value)) continue
      top = top == null ? value : better(top, value)
    }
    if (top != null) bests.set(key, top)
  }
  return { columns: history.columns, rows, bests }
}

/**
 * 1 つのエポックの指標を, 指標ごとの行と学習用と検証用の列の表にする.
 * 記録の無いエポックは null
 */
export function epochMetrics(
  index: HistoryIndex,
  epoch: number,
  best: BestValue | null | undefined,
  interval: number,
): EpochMetrics | null {
  const row = index.rows.get(epoch)
  if (!row) return null
  const used = new Set<Phase>()
  let skipped = false
  let missing = false
  let guessed = false
  const rows = groupMetrics(index.columns).map<EpochMetricRow>((group) => {
    const monitor = best != null && group.keys.includes(best.monitor)
    const cells: Partial<Record<Phase, EpochCell>> = {}
    for (const key of group.keys) {
      const value = row[key] ?? null
      // 監視する指標は学習曲線のベストの印と同じく, モデルに選ばれたエポックだけ
      let mark: CellMark = null
      if (value != null && key === best?.monitor) {
        mark = best.epoch === epoch ? 'best' : null
      } else if (value != null && index.bests.get(key) === value) {
        mark = 'guessed'
        guessed = true
      }
      const cell: EpochCell = {
        key,
        value,
        mark,
        skipped: value == null && judgedOnly(key, interval),
      }
      if (cell.skipped) skipped = true
      else if (value == null) missing = true
      const phase = phaseOf(key)
      cells[phase] = cell
      used.add(phase)
    }
    // 良い向き (監視する指標はその向き, 他は指標の名前から推測)
    const direction = columnDirection(monitor && best ? best.monitor : group.name, [best])
    return { name: group.name, direction, monitor, cells }
  })
  return {
    phases: PHASE_ORDER.filter((phase) => used.has(phase)),
    rows,
    skipped,
    missing,
    guessed,
  }
}
