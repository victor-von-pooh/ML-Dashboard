import clsx from 'clsx'
import { CheckCircle2, ShieldAlert, TriangleAlert, XCircle } from 'lucide-react'

import type { PolicySpace, RunPolicy } from '../../api/client'
import { Card, ErrorBox } from '../../components/ui'
import { formatBytes, formatDateTime } from '../../lib/format'
import {
  boundRows,
  describeFallback,
  describeHead,
  discreteRows,
  formatBound,
  weightsStatus,
} from '../../lib/policy'

const TONE = {
  good: { icon: CheckCircle2, className: 'text-good-text' },
  critical: { icon: XCircle, className: 'text-critical-text' },
  warning: { icon: TriangleAlert, className: 'text-warning-text' },
}

/** 実機と配備は道具の外で, 人が承認することの知らせ */
function DeploymentNote() {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
      <p>
        実機での実行は道具の外です. ダッシュボードは方策を動かさず, 重みも配りません.
        方策を使ってよいか (配備) と守りの範囲は, この画面で中身を確かめたうえで人が承認します.
      </p>
    </div>
  )
}

function spaceSummary(space: PolicySpace): string {
  if (space.type === 'discrete') {
    const start = space.start ?? 0
    return space.n ? `discrete (行動 ${start} から ${start + space.n - 1})` : 'discrete'
  }
  return `box (形 [${(space.shape ?? []).join(', ')}])`
}

function TruncatedNote({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) return null
  return (
    <p className="px-4 py-2 text-xs text-ink-3">
      {total.toLocaleString()} 個の要素のうち先頭の {shown} 個だけを出しています
    </p>
  )
}

/** box の空間の範囲と守りの範囲を要素ごとに並べる表 */
function BoundsTable({
  space,
  low,
  high,
  guardLabel,
  caption,
}: {
  space: PolicySpace
  low: (number | null)[] | null | undefined
  high: (number | null)[] | null | undefined
  guardLabel: string
  caption: string
}) {
  const { rows, total } = boundRows(space, low, high)
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-1.5 font-medium">要素</th>
              <th className="px-4 py-1.5 font-medium">空間の下限</th>
              <th className="px-4 py-1.5 font-medium">空間の上限</th>
              <th className="px-4 py-1.5 font-medium">{guardLabel}の下限</th>
              <th className="px-4 py-1.5 font-medium">{guardLabel}の上限</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index} className="tabular border-b border-line last:border-b-0">
                <td className="px-4 py-1.5 font-mono text-xs">{row.index}</td>
                <td className="px-4 py-1.5 text-ink-2">{formatBound(row.spaceLow)}</td>
                <td className="px-4 py-1.5 text-ink-2">{formatBound(row.spaceHigh)}</td>
                <td className={clsx('px-4 py-1.5', row.guardLow !== null && 'font-medium')}>
                  {formatBound(row.guardLow)}
                </td>
                <td className={clsx('px-4 py-1.5', row.guardHigh !== null && 'font-medium')}>
                  {formatBound(row.guardHigh)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TruncatedNote shown={rows.length} total={total} />
    </>
  )
}

/** discrete の行動を番号ごとに, 選んでよいかと一緒に並べる表 */
function ActionsTable({ space, allowed }: { space: PolicySpace; allowed: number[] | null }) {
  const { rows, total } = discreteRows(space, allowed)
  return (
    <>
      <table className="w-full text-sm">
        <caption className="sr-only">行動と選んでよい行動</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th className="px-4 py-1.5 font-medium">行動の番号</th>
            <th className="px-4 py-1.5 font-medium">選んでよいか</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.action} className="border-b border-line last:border-b-0">
              <td className="tabular px-4 py-1.5 font-mono text-xs">{row.action}</td>
              <td className="px-4 py-1.5">
                {row.allowed ? (
                  <span className="inline-flex items-center gap-1 text-good-text">
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    選んでよい
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-critical-text">
                    <XCircle className="size-3.5" aria-hidden />
                    選ばない
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <TruncatedNote shown={rows.length} total={total} />
    </>
  )
}

/** 方策の一式 (ML-Found の policy/policy.json) の守り, 空間, 重みの確かめ */
export function PolicyTab({ policy }: { policy: RunPolicy }) {
  if (policy.error || !policy.guards || !policy.observation_space || !policy.action_space) {
    return (
      <div className="space-y-4">
        <DeploymentNote />
        <ErrorBox error={policy.error ?? 'policy.json を読めません'} live={false}>
          <p className="mt-1 text-xs text-ink-2">
            守りを読み違えないように, 読めない一式の中身は出しません.
          </p>
        </ErrorBox>
      </div>
    )
  }
  const guards = policy.guards
  const weights = weightsStatus(policy.weights_status)
  const tone = TONE[weights.tone]
  const WeightsIcon = tone.icon
  const metadata = Object.keys(policy.metadata ?? {}).length > 0 ? policy.metadata : null

  return (
    <div className="space-y-4">
      <DeploymentNote />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="方策の一式">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink-3">場所</dt>
            <dd className="font-mono text-xs">{policy.path}/</dd>
            <dt className="text-ink-3">版</dt>
            <dd>{policy.format_version}</dd>
            <dt className="text-ink-3">出力の読み方</dt>
            <dd>{describeHead(policy.head)}</dd>
            <dt className="text-ink-3">モデル</dt>
            <dd className="font-mono text-xs break-all">{policy.model_class ?? '不明'}</dd>
            <dt className="text-ink-3">書き出した時刻</dt>
            <dd>{policy.created_at ? formatDateTime(policy.created_at) : '不明'}</dd>
            <dt className="text-ink-3">観測</dt>
            <dd>{spaceSummary(policy.observation_space)}</dd>
            <dt className="text-ink-3">行動</dt>
            <dd>{spaceSummary(policy.action_space)}</dd>
          </dl>
        </Card>
        <Card title="重み">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink-3">ファイル</dt>
            <dd className="font-mono text-xs">
              {policy.weights ?? '不明'}
              {policy.weights_size != null && (
                <span className="ml-2 text-ink-3">{formatBytes(policy.weights_size)}</span>
              )}
            </dd>
            <dt className="text-ink-3">sha256</dt>
            <dd className="font-mono text-xs break-all">{policy.weights_sha256 ?? '不明'}</dd>
            <dt className="text-ink-3">確かめ</dt>
            <dd className={clsx('inline-flex items-center gap-1 font-medium', tone.className)}>
              <WeightsIcon className="size-4" aria-hidden />
              {weights.label}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-ink-3">
            重みは sha256 を確かめるだけで, 読み込みもダウンロードもしません.
          </p>
        </Card>
      </div>

      <Card title="外れたときの動き">
        <p className="text-sm font-medium">{describeFallback(guards.fallback)}</p>
        <p className="mt-1 text-xs text-ink-3">
          観測が止める条件の範囲の外のとき, 観測やモデルの出力が数でないときや形が違うとき,
          モデルがエラーになったときにこの動きにします (ML-Found の守りの決まり).
        </p>
      </Card>

      <Card title="観測と止める条件" padded={false}>
        <BoundsTable
          space={policy.observation_space}
          low={guards.observation_low}
          high={guards.observation_high}
          guardLabel="止める条件"
          caption="観測の要素ごとの範囲と止める条件"
        />
      </Card>

      <Card title="行動と行動の範囲" padded={false}>
        {policy.action_space.type === 'discrete' ? (
          <ActionsTable space={policy.action_space} allowed={guards.allowed_actions ?? null} />
        ) : (
          <BoundsTable
            space={policy.action_space}
            low={guards.action_low}
            high={guards.action_high}
            guardLabel="行動の範囲"
            caption="行動の要素ごとの範囲と守りの範囲"
          />
        )}
      </Card>

      {metadata && (
        <Card title="補足 (metadata)">
          <pre className="overflow-x-auto font-mono text-xs text-ink-2">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  )
}
