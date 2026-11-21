import clsx from 'clsx'
import {
  CircleCheck,
  Columns3,
  Equal,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'

import type { EvaluationValue, GuardCheck } from '../../api/client'
import { formatMetric } from '../../lib/format'
import { GUARD_LABELS, diffTone, guardDetail, type EvaluationColumn } from '../../lib/evaluations'

const GUARD_STYLE: Record<GuardCheck['state'], { icon: LucideIcon; className: string }> = {
  dropped: { icon: ShieldAlert, className: 'text-critical-text bg-critical/10' },
  kept: { icon: ShieldCheck, className: 'text-good-text bg-good/10' },
  unknown: { icon: ShieldQuestionMark, className: 'text-ink-2 bg-surface-2' },
}

/** 守る指標の印. 色だけに頼らずアイコンと文字も付け, 説明に落ちた指標を出す */
export function GuardBadge({ guard }: { guard: GuardCheck | null | undefined }) {
  if (!guard) return <span className="text-xs text-ink-3">—</span>
  const { icon: Icon, className } = GUARD_STYLE[guard.state]
  const detail = guardDetail(guard)
  return (
    <span
      title={detail}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {GUARD_LABELS[guard.state]}
      <span className="sr-only">. {detail}</span>
    </span>
  )
}

const TONE: Record<
  'good' | 'bad' | 'same',
  { icon: LucideIcon; label: string; className: string }
> = {
  good: { icon: CircleCheck, label: '良い', className: 'text-good-text' },
  bad: { icon: TriangleAlert, label: '悪い', className: 'text-critical-text' },
  same: { icon: Equal, label: '同じ', className: 'text-ink-3' },
}

/** 評価の値. 比べる相手との差は, 向きが分かれば良し悪しを色とアイコンと文字で出す */
export function EvaluationCell({ value }: { value: EvaluationValue | undefined }) {
  if (value?.value == null) return <span className="text-ink-3">—</span>
  const tone = diffTone(value)
  if (!tone) {
    return (
      <span title={value.diff && !value.better ? '指標の向きが分からない差' : undefined}>
        {formatMetric(value.value)}
      </span>
    )
  }
  const { icon: Icon, label, className } = TONE[tone]
  const sign = value.value > 0 ? '+' : ''
  return (
    <span
      className={clsx('inline-flex items-center justify-end gap-1', className)}
      title={value.baseline ? `${value.baseline} との差` : '比べる相手との差'}
    >
      {sign}
      {formatMetric(value.value)}
      <Icon className="size-3.5" aria-hidden />
      <span className="text-[11px]">{label}</span>
    </span>
  )
}

/** 評価の列の見出しの中身 (列の名前と, 評価の名前) */
export function ColumnLabel({ column }: { column: EvaluationColumn }) {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className="font-mono">{column.column}</span>
      <span className="font-mono text-[10px] font-normal text-ink-3">{column.evaluation}</span>
    </span>
  )
}

/** 並べる評価の列を選ぶ欄 (名前で探せる). 上限まで選ぶと他は選べない */
export function EvaluationColumnPicker({
  columns,
  chosen,
  limit,
  onChange,
}: {
  columns: EvaluationColumn[]
  chosen: EvaluationColumn[]
  limit: number
  onChange: (keys: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const chosenKeys = chosen.map((column) => column.key)
  const word = search.trim().toLowerCase()
  const shown = columns.filter((column) => !word || column.key.toLowerCase().includes(word))
  const full = chosenKeys.length >= limit
  const toggle = (key: string) =>
    onChange(
      chosenKeys.includes(key)
        ? chosenKeys.filter((item) => item !== key)
        : full
          ? chosenKeys
          : [...chosenKeys, key],
    )
  return (
    <details className="relative">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs font-medium text-ink-2 hover:bg-surface-2">
        <Columns3 className="size-4" aria-hidden />
        評価の列 ({chosen.length}/{Math.min(limit, columns.length)})
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-line bg-surface p-2 shadow-lg">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="評価の列を名前で探す"
          placeholder="名前で探す"
          className="mb-2 h-8 w-full rounded-md border border-line bg-surface px-2 text-xs outline-none focus:border-accent"
        />
        <p className="mb-1 text-[11px] text-ink-3">
          テスト用の評価の値. {limit} 列まで並べられます
        </p>
        <ul className="max-h-64 overflow-auto" aria-label="評価の列">
          {shown.map((column) => {
            const checked = chosenKeys.includes(column.key)
            return (
              <li key={column.key}>
                <label
                  className={clsx(
                    'flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-2',
                    !checked && full && 'text-ink-3',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && full}
                    onChange={() => toggle(column.key)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="font-mono break-all">{column.key}</span>
                  {column.guard && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-accent-text">
                      <ShieldCheck className="size-3" aria-hidden />
                      守る指標
                    </span>
                  )}
                </label>
              </li>
            )
          })}
          {shown.length === 0 && <li className="px-1.5 py-1 text-xs text-ink-3">ありません</li>}
        </ul>
      </div>
    </details>
  )
}
