import type { BestValue, History } from '../api/client'
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
  other: '値',
}

/** 1 つの列の, 選んだエポックの値 */
export interface EpochCell {
  key: string
  value: number | null
  /** 良い向きの分かる列で, 記録した全てのエポックの中で最も良い値か */
  best: boolean
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
}

function phaseOf(key: string): Phase {
  const [phase, ...rest] = key.split('/')
  if (rest.length === 0) return 'other'
  return phase === 'train' || phase === 'train_eval' || phase === 'valid' ? phase : 'other'
}

/** 列の記録した全てのエポックの中で最も良い値 (向きの分からない列は null) */
function bestValue(history: History, key: string, direction: ColumnDirection | null) {
  if (!direction) return null
  const values = history.rows
    .map((row) => row[key])
    .filter((value): value is number => value != null && Number.isFinite(value))
  if (values.length === 0) return null
  return direction.direction === 'max' ? Math.max(...values) : Math.min(...values)
}

/**
 * history.csv の 1 つのエポックの指標を, 指標ごとの行と学習用と検証用の列の表にする.
 * 再開で同じエポックの行が重なる場合は最後の (使われた) 行. 記録の無いエポックは null
 */
export function epochMetrics(
  history: History,
  epoch: number,
  best: BestValue | null | undefined,
  interval: number,
): EpochMetrics | null {
  const row = history.rows.findLast((item) => item.epoch === epoch)
  if (!row) return null
  const used = new Set<Phase>()
  let skipped = false
  let missing = false
  const rows = groupMetrics(history.columns).map<EpochMetricRow>((group) => {
    const monitor = best != null && group.keys.includes(best.monitor)
    const cells: Partial<Record<Phase, EpochCell>> = {}
    for (const key of group.keys) {
      const phase = phaseOf(key)
      const value = row[key] ?? null
      const direction = columnDirection(key, [best])
      const top = bestValue(history, key, direction)
      const cell: EpochCell = {
        key,
        value,
        best: value != null && top != null && value === top,
        skipped: value == null && judgedOnly(key, interval),
      }
      if (cell.skipped) skipped = true
      else if (value == null) missing = true
      cells[phase] = cell
      used.add(phase)
    }
    // 良い向き (監視する指標はその向き, 他は指標の名前から推測)
    const direction = columnDirection(monitor && best ? best.monitor : group.name, [best])
    return { name: group.name, direction, monitor, cells }
  })
  return { phases: PHASE_ORDER.filter((phase) => used.has(phase)), rows, skipped, missing }
}
