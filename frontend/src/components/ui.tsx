/**
 * 学習・評価の段階に固有の部品. 共通の部品 (殻の正の写しの common.tsx) も
 * ここから書き出す (部品の import の先を ui のままにできるため)
 */
import clsx from 'clsx'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleHelp,
  Loader2,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'

import { directionLabel, metricNote, type ColumnDirection } from '../lib/metrics'
import type { JobStatus } from '../lib/progress'
import { STAGE_NAME } from '../lib/stage'

export {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  FieldError,
  PageHeader,
  Spinner,
  StatTile,
  Tabs,
  type ButtonVariant,
  type CardTone,
  type TabItem,
} from './common'

/**
 * 下の画面のパンくず. 頭に段階の名前で段階の頭の画面へのリンクを置き, その後に
 * links を「 / 」でつなぐ (殻の段階の並びと同じ名前で, 今どこにいるかが分かるように)
 */
export function StageCrumbs({ links = [] }: { links?: { to: string; label: ReactNode }[] }) {
  return (
    <>
      <Link to="/" className="hover:text-ink">
        {STAGE_NAME}
      </Link>
      {links.map((link) => (
        <Fragment key={link.to}>
          {' / '}
          <Link to={link.to} className="hover:text-ink">
            {link.label}
          </Link>
        </Fragment>
      ))}
    </>
  )
}

const STATUS: Record<JobStatus, { label: string; icon: LucideIcon; className: string }> = {
  completed: { label: '完了', icon: CheckCircle2, className: 'text-good-text bg-good/10' },
  running: { label: '実行中', icon: Loader2, className: 'text-accent-text bg-accent/10' },
  finishing: { label: '後の処理中', icon: Loader2, className: 'text-accent-text bg-accent/10' },
  stopped: { label: '中断', icon: PauseCircle, className: 'text-serious-text bg-serious/10' },
  failed: { label: '失敗', icon: XCircle, className: 'text-critical-text bg-critical/10' },
  unknown: { label: '未完了', icon: CircleHelp, className: 'text-ink-2 bg-surface-2' },
}

const STATUS_HINT: Record<JobStatus, string> = {
  completed: '最後まで学習しました',
  running: '学習中です',
  finishing: '学習を終え, 評価や推論の一式の書き出しなどの後の処理をしています',
  stopped: '中断の要求 (STOP, 登録した関数) か Ctrl-C で止めました',
  failed: '正しく終わりませんでした',
  unknown: '途中で止まったか, 結果が残っていません',
}

/**
 * 実験とジョブの状態. 色だけに頼らずアイコンと文字も付ける. 「状態: 完了」を名前にした
 * 印 (img) とし, 名前を 1 度だけ読み上げる. 変わっても知らせない (live にしない. 一覧の
 * 行ごとに出すので, 知らせると重なるため)
 */
export function StatusBadge({ status }: { status: JobStatus }) {
  const { label, icon: Icon, className } = STATUS[status]
  return (
    <span
      role="img"
      aria-label={`状態: ${label}`}
      title={STATUS_HINT[status]}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon
        className={clsx(
          'size-3.5',
          (status === 'running' || status === 'finishing') && 'animate-spin',
        )}
        aria-hidden
      />
      {label}
    </span>
  )
}

/** グラフの見出しの指標の名前. 名前の分かる指標は日本語の説明を添える */
export function MetricTitle({ name }: { name: string }) {
  const note = metricNote(name)
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono">{name}</span>
      {note && <span className="text-xs font-normal text-ink-2">{note}</span>}
    </span>
  )
}

/** 指標の良い向きの印 (グラフの見出しに添える). 名前から推測した向きはそう書く */
export function DirectionBadge({ value }: { value: ColumnDirection }) {
  const Icon = value.direction === 'max' ? ArrowUp : ArrowDown
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2"
      title={
        value.guessed
          ? '指標の名前から推測した向き'
          : 'ML-Found の監視する指標の向き (trainer.mode)'
      }
    >
      <Icon className="size-3" aria-hidden />
      {directionLabel(value.direction)}
      {value.guessed && ' (推測)'}
    </span>
  )
}
