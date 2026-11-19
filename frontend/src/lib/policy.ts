import type { PolicyGuards, PolicySpace, RunPolicy } from '../api/client'

// 表にする要素の上限 (要素の多い空間は先頭だけ)
export const MAX_POLICY_ROWS = 200

type Bounds = (number | null)[] | null | undefined

/** 範囲の値の表示. null は制限なし (無限大) */
export function formatBound(value: number | null | undefined): string {
  return value === null || value === undefined ? '制限なし' : String(value)
}

/** 空間の要素の数 (box は形の積, discrete は行動の数) */
export function spaceSize(space: PolicySpace): number {
  if (space.type === 'discrete') return space.n ?? 0
  if (space.low) return space.low.length
  return (space.shape ?? []).reduce((total, size) => total * size, 1)
}

export interface BoundRow {
  index: number
  spaceLow: number | null
  spaceHigh: number | null
  guardLow: number | null
  guardHigh: number | null
}

/** box の空間と守りの範囲を, 要素ごとの行にする (平らにした順) */
export function boundRows(
  space: PolicySpace,
  guardLow: Bounds,
  guardHigh: Bounds,
  limit = MAX_POLICY_ROWS,
): { rows: BoundRow[]; total: number } {
  const total = spaceSize(space)
  const rows = Array.from({ length: Math.min(total, limit) }, (_, index) => ({
    index,
    spaceLow: space.low?.[index] ?? null,
    spaceHigh: space.high?.[index] ?? null,
    guardLow: guardLow?.[index] ?? null,
    guardHigh: guardHigh?.[index] ?? null,
  }))
  return { rows, total }
}

export interface ActionRow {
  action: number
  allowed: boolean
}

/** discrete の行動を番号ごとの行にし, 選んでよいかを付ける (null は全て選んでよい) */
export function discreteRows(
  space: PolicySpace,
  allowed: number[] | null | undefined,
  limit = MAX_POLICY_ROWS,
): { rows: ActionRow[]; total: number } {
  const total = space.n ?? 0
  const start = space.start ?? 0
  const set = allowed ? new Set(allowed) : null
  const rows = Array.from({ length: Math.min(total, limit) }, (_, offset) => ({
    action: start + offset,
    allowed: set === null || set.has(start + offset),
  }))
  return { rows, total }
}

/** 外れたときの動きの説明 */
export function describeFallback(fallback: PolicyGuards['fallback']): string {
  if (fallback.kind === 'stop') return '止める (行動を返さない)'
  if (fallback.kind === 'handover') return '元の制御に戻す (行動を返さない)'
  if (fallback.kind === 'action') {
    const action = Array.isArray(fallback.action)
      ? `[${fallback.action.join(', ')}]`
      : String(fallback.action ?? '')
    return `決めた行動 ${action} にする`
  }
  return fallback.kind
}

/** モデルの出力の読み方の説明 */
export function describeHead(head: string | null | undefined): string {
  if (head === 'categorical') return '行動ごとのスコア (最も高い行動を選ぶ)'
  if (head === 'deterministic') return '出力が行動'
  return head ?? '不明'
}

/** 重みの sha256 の確かめの表示. 色だけに頼らず文字も付ける */
export function weightsStatus(status: RunPolicy['weights_status']): {
  label: string
  tone: 'good' | 'critical' | 'warning'
} {
  if (status === 'match') return { label: '一致', tone: 'good' }
  if (status === 'mismatch') return { label: '違う (読む側は読まない)', tone: 'critical' }
  if (status === 'missing') return { label: '重みが無い', tone: 'warning' }
  return { label: '確かめていない', tone: 'warning' }
}
