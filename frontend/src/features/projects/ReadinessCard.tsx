import clsx from 'clsx'
import {
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  Loader2,
  PackagePlus,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'

import type { EnvironmentJob, ProjectReadiness } from '../../api/client'
import {
  useEnvironmentJob,
  useReadiness,
  useRecheckReadiness,
  useStartEnvironmentJob,
} from '../../api/hooks'
import { Button, Card, ErrorBox, Spinner } from '../../components/ui'
import {
  JOB_STATUS,
  environmentAction,
  readinessItems,
  type ReadinessState,
} from '../../lib/readiness'
import { safeUrl } from '../../lib/requirements'

const STATE: Record<ReadinessState, { icon: LucideIcon; label: string; className: string }> = {
  ok: { icon: CheckCircle2, label: 'そろっている', className: 'text-good-text' },
  missing: { icon: XCircle, label: '足りない', className: 'text-critical-text' },
  unknown: { icon: CircleHelp, label: '分からない', className: 'text-ink-2' },
}

/** プロジェクトの学習の準備 (データセット, モデルの定義, 環境) と, 環境を作るボタン */
export function ReadinessCard({ projectId }: { projectId: string }) {
  const readiness = useReadiness(projectId)
  const recheck = useRecheckReadiness(projectId)
  const job = useEnvironmentJob(projectId, true)
  const start = useStartEnvironmentJob(projectId)
  const [confirming, setConfirming] = useState(false)
  const running = job.data?.status === 'running'

  return (
    <Card
      title="学習の準備"
      className="mb-6"
      actions={
        <Button
          icon={RefreshCw}
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending || readiness.isPending || running}
        >
          {recheck.isPending ? '確かめています' : '確かめ直す'}
        </Button>
      }
    >
      {readiness.isPending ? (
        <Spinner label="学習の準備を確かめています" />
      ) : readiness.error ? (
        <ErrorBox error={readiness.error} />
      ) : (
        <ReadinessBody
          readiness={readiness.data}
          job={job.data ?? readiness.data.job ?? null}
          confirming={confirming && !running}
          onConfirm={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onStart={() => {
            start.mutate(readiness.data.commands, { onSettled: () => setConfirming(false) })
          }}
          starting={start.isPending}
          startError={start.error ?? recheck.error}
        />
      )}
    </Card>
  )
}

function ReadinessBody({
  readiness,
  job,
  confirming,
  onConfirm,
  onCancel,
  onStart,
  starting,
  startError,
}: {
  readiness: ProjectReadiness
  job: EnvironmentJob | null
  confirming: boolean
  onConfirm: () => void
  onCancel: () => void
  onStart: () => void
  starting: boolean
  startError: Error | null
}) {
  const items = readinessItems(readiness)
  const action = environmentAction(readiness)
  const running = job?.status === 'running'
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-2" aria-label="学習の準備の項目">
        {items.map((item) => {
          const state = STATE[item.state]
          const Icon = state.icon
          return (
            <li key={item.label} className="flex items-start gap-2">
              <Icon className={clsx('mt-0.5 size-4 shrink-0', state.className)} aria-hidden />
              <div className="min-w-0">
                <p>
                  <span className="font-medium">{item.label}</span>
                  <span className="sr-only"> ({state.label})</span>: {item.text}
                </p>
                {item.detail && (
                  <p className="font-mono text-xs break-all text-ink-3">{item.detail}</p>
                )}
                {item.hint && <p className="text-xs text-ink-2">{item.hint}</p>}
              </div>
            </li>
          )
        })}
      </ul>

      {readiness.manual.length > 0 && (
        <div className="text-xs text-ink-2">
          pip では入らない機能は, 公式の手順で入れます:{' '}
          {readiness.manual.map((requirement) => {
            const url = safeUrl(requirement.install.url)
            return url ? (
              <a
                key={requirement.name}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mr-2 inline-flex items-center gap-0.5 text-accent-text hover:underline"
              >
                {requirement.name}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span key={requirement.name} className="mr-2">
                {requirement.name}
              </span>
            )
          })}
        </div>
      )}
      {readiness.unknown.length > 0 && (
        <p className="text-xs text-ink-2">
          requires の {readiness.unknown.join(', ')} は ML-Found の登録簿に無いので入れません
          (プロジェクトの機能は学習のスクリプトが確かめます).
        </p>
      )}
      {readiness.requires_error && <ErrorBox error={readiness.requires_error} live={false} />}
      {readiness.check_error && <ErrorBox error={readiness.check_error} live={false} />}
      {startError && <ErrorBox error={startError} />}

      {readiness.ready && !running && (
        <p className="text-good-text">学習を始める準備ができています.</p>
      )}

      {action && !running && !confirming && (
        <Button variant="primary" icon={PackagePlus} onClick={onConfirm}>
          {action}
        </Button>
      )}
      {confirming && (
        <section
          aria-label="入れる内容の確認"
          className="space-y-2 rounded-lg border border-line bg-surface-2 p-3"
        >
          {readiness.commands.length > 0 ? (
            <>
              <p>
                次のコマンドを順に動かします. パッケージはネットワークから取るので,
                数分かかることがあります.
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                {readiness.commands.map((command) => (
                  <li key={command.join(' ')}>
                    <code className="font-mono text-xs break-all">{command.join(' ')}</code>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {readiness.switch_python && (
            <p className="text-xs text-ink-2">
              終わったら, 学習に使う Python を{' '}
              <code className="font-mono break-all">{readiness.target_python}</code> にします.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={onStart} disabled={starting}>
              {starting ? '始めています' : '実行する'}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={starting}>
              やめる
            </Button>
          </div>
        </section>
      )}

      {job && <JobLog job={job} />}
    </div>
  )
}

function JobLog({ job }: { job: EnvironmentJob }) {
  const running = job.status === 'running'
  const failed = job.status === 'failed' || job.status === 'interrupted'
  const Icon = running ? Loader2 : failed ? XCircle : CheckCircle2
  return (
    <details open={running || failed} className="rounded-lg border border-line">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <Icon
          className={clsx(
            'size-4',
            running && 'animate-spin text-accent-text',
            failed && 'text-critical-text',
            !running && !failed && 'text-good-text',
          )}
          aria-hidden
        />
        <span role="status">環境のジョブ: {JOB_STATUS[job.status]}</span>
        {job.return_code != null && job.return_code !== 0 && (
          <span className="text-xs text-ink-3">(終了コード {job.return_code})</span>
        )}
      </summary>
      <pre
        aria-label="環境のジョブの出力"
        className="max-h-72 overflow-auto border-t border-line bg-surface-2 px-3 py-2 font-mono text-xs whitespace-pre-wrap"
      >
        {job.output || '(出力はまだありません)'}
      </pre>
    </details>
  )
}
