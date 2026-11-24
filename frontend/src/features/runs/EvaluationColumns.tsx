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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'

import type { EvaluationValue, GuardCheck } from '../../api/client'
import { useStableId } from '../../lib/a11y'
import { formatMetric } from '../../lib/format'
import { GUARD_LABELS, diffTone, guardDetail, type EvaluationColumn } from '../../lib/evaluations'

const GUARD_STYLE: Record<GuardCheck['state'], { icon: LucideIcon; className: string }> = {
  dropped: { icon: ShieldAlert, className: 'text-critical-text bg-critical/10' },
  kept: { icon: ShieldCheck, className: 'text-good-text bg-good/10' },
  unknown: { icon: ShieldQuestionMark, className: 'text-ink-2 bg-surface-2' },
}

// 印の説明を開いたことを他の印に知らせる (開いている説明を 1 つにするため)
const GUARD_OPEN_EVENT = 'guard-badge-open'

// 説明の幅 (px. 画面の端からはみ出さない位置にするため)
const DETAIL_WIDTH = 288

/**
 * フォーカスの行き先が印の外か. 行き先が無いか, 印を包む要素 (説明の文を押したとき)
 * なら外としない
 */
function leftBadge(wrapper: HTMLElement | null, next: Node | null): boolean {
  if (next === null || wrapper === null) return false
  return !wrapper.contains(next) && !next.contains(wrapper)
}

/**
 * 守る指標の印. 色だけに頼らずアイコンと文字も付ける. 押すと (キーボードとタッチでも)
 * 落ちた指標と判断できなかった理由の説明が印の下に浮いて開く (表の形を変えないため)
 */
export function GuardBadge({ guard }: { guard: GuardCheck | null | undefined }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const open = position !== null
  const wrapper = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const detail = useRef<HTMLSpanElement>(null)
  const detailId = useStableId('guard-detail')
  // 印の下 (窓の下端で足りなければ上) に, 画面の端からはみ出さないように置く.
  // 印が横に流れる表や画面の見える範囲から外れたら閉じる (別の列の上に浮かないため)
  const place = useCallback(() => {
    const element = button.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const visible = [element.closest('.overflow-x-auto'), element.closest('main')].every((area) => {
      if (!area) return true
      const bounds = area.getBoundingClientRect()
      return (
        rect.right >= bounds.left &&
        rect.left <= bounds.right &&
        rect.bottom >= bounds.top &&
        rect.top <= bounds.bottom
      )
    })
    if (!visible) {
      setPosition(null)
      return
    }
    const width = document.documentElement.clientWidth
    const height = document.documentElement.clientHeight
    const detailHeight = detail.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(rect.left, width - DETAIL_WIDTH - 8))
    const below = rect.bottom + 4
    const top =
      below + detailHeight > height - 8 && rect.top - 4 - detailHeight >= 8
        ? rect.top - 4 - detailHeight
        : below
    setPosition({ top, left })
  }, [])
  // 開いた直後に説明の高さを測って置き直し, 上の部分の高さが変わっても置き直す
  useLayoutEffect(() => {
    if (!open) return
    place()
    const main = button.current?.closest('main')
    if (!main || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    // main は高さが決まっているので, 中の内容の大きさを見る
    observer.observe(main.firstElementChild ?? main)
    return () => observer.disconnect()
  }, [open, place])
  // 開いている間は, 外を押す, Esc, 他の印を開く, 印の外へフォーカスが移ると閉じ,
  // 流すか窓の大きさを変えると置き直す
  useEffect(() => {
    if (!open) return
    const close = () => setPosition(null)
    // 説明の文を押してフォーカスが印を包む要素に移った後に Tab で移る場合は,
    // 印の blur が起きないので, 行き先で確かめる
    const onFocusIn = (event: globalThis.FocusEvent) => {
      if (leftBadge(wrapper.current, event.target as Node | null)) close()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== detailId) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener(GUARD_OPEN_EVENT, onOther)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener(GUARD_OPEN_EVENT, onOther)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, detailId, place])
  if (!guard) return <span className="text-xs text-ink-3">—</span>
  const { icon: Icon, className } = GUARD_STYLE[guard.state]
  const toggle = () => {
    if (open) {
      setPosition(null)
      return
    }
    place()
    document.dispatchEvent(new CustomEvent(GUARD_OPEN_EVENT, { detail: detailId }))
  }
  // Tab などで印から離れたら閉じる (説明の文を選ぶために押して, 行き先が無いか
  // 印を包む要素になる場合は閉じない)
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (leftBadge(wrapper.current, event.relatedTarget as Node | null)) setPosition(null)
  }
  return (
    <span ref={wrapper} className="inline-block" onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        aria-label={`守る指標: ${GUARD_LABELS[guard.state]}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
        className={clsx(
          'inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          className,
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {GUARD_LABELS[guard.state]}
      </button>
      {/* 開いたときだけ中身を入れ, 読み上げは開いた説明の 1 回だけにする */}
      <span id={detailId} role="status">
        {position && (
          <span
            ref={detail}
            className="fixed z-30 block rounded-md border border-line bg-surface px-2 py-1 text-left text-[11px] whitespace-pre-line text-ink-2 shadow-lg"
            style={{ top: position.top, left: position.left, width: DETAIL_WIDTH }}
          >
            {guardDetail(guard)}
          </span>
        )}
      </span>
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

/**
 * 評価の値. 比べる相手との差は, 向きが分かれば良し悪しを色とアイコンと文字で出す.
 * 数の書き方は format (既定は一覧と比較の書き方)
 */
export function EvaluationCell({
  value,
  format = formatMetric,
}: {
  value: EvaluationValue | undefined
  format?: (value: number) => string
}) {
  if (value?.value == null) return <span className="text-ink-3">—</span>
  const tone = diffTone(value)
  if (!tone) {
    return (
      <span title={value.diff && !value.better ? '指標の向きが分からない差' : undefined}>
        {format(value.value)}
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
      {format(value.value)}
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
      <span className="sr-only"> (</span>
      <span className="font-mono text-[10px] font-normal text-ink-3">{column.evaluation}</span>
      <span className="sr-only">)</span>
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
  const details = useRef<HTMLDetailsElement>(null)
  // 外を押したときと Esc で閉じる (表に重なったまま残らないように)
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const element = details.current
      if (element?.open && !element.contains(event.target as Node)) element.open = false
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    const element = details.current
    if (event.key !== 'Escape' || !element?.open) return
    element.open = false
    element.querySelector('summary')?.focus()
  }
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
    <details ref={details} className="relative" onKeyDown={onKeyDown}>
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
