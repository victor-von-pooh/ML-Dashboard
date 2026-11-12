import clsx from 'clsx'
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Loader2,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import type { RunStatus } from '../api/client'

export function Card({
  title,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section
      className={clsx(
        'rounded-xl border border-line bg-surface shadow-sm shadow-black/[0.03]',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  icon: Icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: LucideIcon }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-line bg-surface text-critical hover:bg-critical/10',
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-4" aria-hidden />}
      {children}
    </button>
  )
}

const STATUS: Record<RunStatus, { label: string; icon: LucideIcon; className: string }> = {
  completed: { label: '完了', icon: CheckCircle2, className: 'text-good bg-good/10' },
  running: { label: '実行中', icon: Loader2, className: 'text-accent bg-accent/10' },
  stopped: { label: '中断', icon: PauseCircle, className: 'text-serious bg-serious/10' },
  failed: { label: '失敗', icon: XCircle, className: 'text-critical bg-critical/10' },
  unknown: { label: '未完了', icon: CircleHelp, className: 'text-ink-3 bg-surface-2' },
}

/** 実験の状態. 色だけに頼らずアイコンと文字も付ける */
export function StatusBadge({ status }: { status: RunStatus }) {
  const { label, icon: Icon, className } = STATUS[status]
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        className,
      )}
    >
      <Icon className={clsx('size-3.5', status === 'running' && 'animate-spin')} aria-hidden />
      {label}
    </span>
  )
}

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-3">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex items-start gap-2 rounded-lg border border-critical/30 bg-critical/5 px-4 py-3 text-sm text-ink">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
      <span>{message}</span>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <div className="rounded-full bg-accent-soft p-3 text-accent">
        <Icon className="size-6" aria-hidden />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  )
}

/** 大きな数値で 1 つの値を見せるタイル */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="tabular mt-1 truncate text-xl font-semibold text-ink">{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-ink-3">{hint}</div>}
    </div>
  )
}

export interface TabItem<T extends string> {
  id: T
  label: string
  count?: number
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          onClick={() => onChange(item.id)}
          className={clsx(
            '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            item.id === value
              ? 'border-accent text-ink'
              : 'border-transparent text-ink-3 hover:text-ink-2',
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span className="tabular rounded-full bg-surface-2 px-1.5 text-xs text-ink-3">
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-ink-3">{breadcrumb}</div>}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 truncate text-sm text-ink-3">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
