import { CircleHelp, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { encodeRunId, type RunTask } from '../../api/client'
import { Card } from '../../components/ui'
import {
  labelOf,
  METHOD_LABELS,
  ORIGIN_LABELS,
  OUTPUT_LABELS,
  ROLE_LABELS,
} from '../../lib/results'

/** 設定の値を読める文字にする (辞書は JSON) */
function settingsText(settings: unknown): string | null {
  if (settings == null) return null
  if (typeof settings === 'string') return settings
  return JSON.stringify(settings, null, 2)
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-ink">{children ?? '—'}</dd>
    </div>
  )
}

/** 正解の出どころ. 今ある処理の出力は「超えられない」を目立たせる */
function Origin({ task }: { task: RunTask }) {
  const origin = task.origin
  if (task.newer_version) {
    return (
      <div className="flex items-start gap-1.5 text-sm text-ink">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <div>
          <p className="font-medium">分からない (新しい版)</p>
          <p className="text-xs text-ink-3">{task.origin_note}</p>
        </div>
      </div>
    )
  }
  if (origin.type === 'process') {
    const settings = settingsText(origin.settings)
    return (
      <div
        className="rounded-lg border border-accent bg-accent-soft p-3 text-sm text-ink"
        data-testid="origin-process"
      >
        <p className="flex items-start gap-1.5 font-semibold">
          <Info className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
          この処理との一致を測り, この処理を超えられない
        </p>
        <dl className="mt-2 grid gap-1 pl-5.5">
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-3">処理</dt>
            <dd className="font-medium break-words">{origin.name ?? '名前の分からない処理'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-3">設定</dt>
            <dd className="min-w-0">
              {settings ? (
                <pre className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">
                  {settings}
                </pre>
              ) : (
                '書いていない'
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-2 pl-5.5 text-xs text-ink-2">{task.origin_note}</p>
      </div>
    )
  }
  return (
    <div className="text-sm text-ink">
      <p className="font-medium">{labelOf(ORIGIN_LABELS, origin.type)}</p>
      <p className="text-xs text-ink-3">{task.origin_note}</p>
    </div>
  )
}

/** 元にした実験か重み. 実験がダッシュボードにあればリンク */
function Base({ task }: { task: RunTask }) {
  const items: ReactNode[] = []
  if (task.base_run) {
    items.push(
      <Link
        key="run"
        to={`/projects/${task.base_run.project_id}/runs/${encodeRunId(task.base_run.run_id)}`}
        className="font-mono text-accent-text hover:underline"
      >
        {task.base_run.run_id}
      </Link>,
    )
  } else if (task.base_experiment) {
    items.push(
      <span key="path" className="font-mono" title="ダッシュボードに無い実験">
        {task.base_experiment}
      </span>,
    )
  }
  if (task.base_weights) {
    items.push(
      <span key="weights" className="font-mono">
        {task.base_weights}
      </span>,
    )
  }
  if (items.length === 0) return <>無し</>
  return <span className="flex flex-col gap-0.5">{items}</span>
}

/** 何の実験か (ML-Found の task.yaml) */
export function TaskPanel({ task }: { task: RunTask }) {
  return (
    <Card title="何の実験か">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Item label="受け持ち">{labelOf(ROLE_LABELS, task.role)}</Item>
        <Item label="出力">{labelOf(OUTPUT_LABELS, task.output)}</Item>
        <Item label="正解の種類">{task.target_kind}</Item>
        <Item label="作り方">{labelOf(METHOD_LABELS, task.method)}</Item>
        <div className="sm:col-span-2 lg:col-span-4">
          <Item label="出力の意味">{task.what}</Item>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-ink-3">正解の出どころ</dt>
          <dd className="mt-1">
            <Origin task={task} />
          </dd>
        </div>
        <Item label="元にしたもの">
          <Base task={task} />
        </Item>
        <Item label="データセット">
          {(task.dataset_name ?? task.dataset_path) ? (
            <span className="font-mono" title={task.dataset_path ?? undefined}>
              {task.dataset_name ?? task.dataset_path}
            </span>
          ) : null}
        </Item>
      </dl>
    </Card>
  )
}
