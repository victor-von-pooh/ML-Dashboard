import {
  Ban,
  CheckCircle2,
  Clock,
  GitCompareArrows,
  Loader2,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'react-router'

import type { BatchCandidate, BatchInfo, JobInfo } from '../../api/client'
import { encodeRunId } from '../../api/client'
import { useDeleteBatch, useStopBatch } from '../../api/hooks'
import { Button, ErrorBox, StatusBadge } from '../../components/ui'
import { formatDateTime } from '../../lib/format'
import { batchState, compareCandidates } from '../../lib/batches'
import { MAX_COMPARE } from '../../lib/metrics'
import { jobStatus } from '../../lib/progress'

// 環境のジョブを待っていることを表す印 (バックエンドの ENVIRONMENT_MARK)
const ENVIRONMENT_MARK = 'environment'

// 候補の状態ごとのアイコンと言葉 (色だけに頼らない)
const STATES: Record<
  BatchCandidate['state'],
  { icon: LucideIcon; label: string; className: string }
> = {
  waiting: { icon: Clock, label: '待つ', className: 'text-ink-3' },
  running: { icon: Loader2, label: '学習中', className: 'text-accent-text' },
  finished: { icon: CheckCircle2, label: '終わった', className: 'text-good-text' },
  cancelled: { icon: Ban, label: '取りやめた', className: 'text-ink-3' },
  failed: { icon: TriangleAlert, label: '起動できなかった', className: 'text-warning-text' },
}

/** 候補のまとまり. 候補ごとの状態, 待っているジョブ, 取りやめ, 候補の実験を比べる, 記録を消す */
export function BatchCard({ batch, jobs }: { batch: BatchInfo; jobs: JobInfo[] }) {
  const stop = useStopBatch()
  const remove = useDeleteBatch()
  const runOf = new Map(jobs.map((job) => [job.id, job.run_id]))
  const jobOf = new Map(jobs.map((job) => [job.id, job]))
  // 候補のジョブが残した実験と, 比較の画面の URL (比べられる数まで)
  const { runIds, url: compareUrl } = compareCandidates(batch, jobs)
  // 終わったまとまりは, もう何も待たない
  const waiting = batch.finished ? [] : (batch.waiting_for ?? [])
  const waitingEnvironment = waiting.includes(ENVIRONMENT_MARK)
  const waitingJobs = waiting.filter((id) => id !== ENVIRONMENT_MARK)
  const stopReasonId = useId()
  const names = batch.candidates.map((candidate) => candidate.name)
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">
            候補のまとまり: {batch.project_name ?? batch.project_id} / {batch.script} (
            {batch.candidates.length} 個の定義)
          </h3>
          <p className="truncate font-mono text-xs text-ink-2" title={names.join(', ')}>
            {names.join(', ')}
          </p>
          <p className="tabular text-xs text-ink-3">
            作成 {formatDateTime(batch.created_at)} · {batchState(batch)}
          </p>
          {!batch.owned && !batch.finished && (
            <p className="text-xs text-warning-text">
              このダッシュボードのプロセスが進めていないまとまりです (持ち主: {batch.owner.hostname}
              , pid {batch.owner.pid})
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {batch.finished && runIds.length >= 2 && (
            <Link
              to={compareUrl}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-sm hover:bg-surface-2"
            >
              <GitCompareArrows className="size-4" aria-hidden />
              候補の実験を比べる
              {runIds.length > MAX_COMPARE && ` (先頭の ${MAX_COMPARE} つ)`}
            </Link>
          )}
          {batch.finished && (
            <Button
              icon={Trash2}
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'まとまりの記録と候補の config を消しますか? 候補のジョブと実験は残ります.',
                  )
                ) {
                  remove.mutate(batch.id)
                }
              }}
            >
              記録を消す
            </Button>
          )}
          {!batch.finished && !batch.owned && (
            <p id={stopReasonId} className="max-w-64 text-xs text-ink-3">
              取りやめは, 進めているプロセス ({batch.owner.hostname}) のダッシュボードで行います.
              そのプロセスが応答しない場合は, 強制して取りやめられます
            </p>
          )}
          {!batch.finished && !batch.owned && (
            <Button
              variant="danger"
              icon={X}
              disabled={stop.isPending}
              aria-describedby={stopReasonId}
              onClick={() => {
                if (
                  window.confirm(
                    `持ち主のダッシュボード (${batch.owner.hostname}, pid ${batch.owner.pid}) が応答しない場合だけ使います. 動いている場合は, そのプロセスの記録と食い違います.\n待っている候補を取りやめ, 学習中の候補をエポックの区切りで止めますか?`,
                  )
                ) {
                  stop.mutate({ batchId: batch.id, force: true })
                }
              }}
            >
              持ち主が応答しない場合の取りやめ
            </Button>
          )}
          {!batch.finished && batch.owned && (
            <Button
              icon={X}
              disabled={stop.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    '待っている候補を取りやめ, 学習中の候補をエポックの区切りで止めますか?',
                  )
                ) {
                  stop.mutate({ batchId: batch.id, force: false })
                }
              }}
            >
              残りを取りやめる
            </Button>
          )}
        </div>
      </div>
      {(waitingEnvironment || waitingJobs.length > 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-2">
          <Clock className="size-3.5" aria-hidden />
          次の候補は,{' '}
          {[
            waitingEnvironment ? '学習の準備 (環境のジョブ)' : null,
            waitingJobs.length > 0 ? '学習中のジョブ' : null,
          ]
            .filter(Boolean)
            .join(' と ')}
          が終わるのを待っています
          {waitingJobs.map((id) => (
            <Link
              key={id}
              to={`/jobs/${id}`}
              className="font-mono text-accent-text hover:underline"
            >
              {id}
            </Link>
          ))}
        </p>
      )}
      <ol className="mt-3 space-y-1 text-sm">
        {batch.candidates.map((candidate, index) => {
          const { icon: Icon, label, className } = STATES[candidate.state]
          const runId = candidate.job_id ? runOf.get(candidate.job_id) : null
          const job = candidate.job_id ? jobOf.get(candidate.job_id) : undefined
          return (
            <li key={`${candidate.path}:${index}`} className="flex flex-wrap items-center gap-2">
              <span className="tabular w-6 text-right text-xs text-ink-3">{index + 1}.</span>
              <span className={`inline-flex items-center gap-1 text-xs ${className}`}>
                <Icon className="size-3.5" aria-hidden />
                {label}
              </span>
              <span className="font-mono text-xs">{candidate.name}</span>
              {/* 終わった候補は, 完了か失敗か中断かをジョブの状態で添える */}
              {candidate.state === 'finished' && job && <StatusBadge status={jobStatus(job)} />}
              {candidate.job_id && (
                <Link
                  aria-label={`${candidate.name} のジョブ`}
                  to={`/jobs/${candidate.job_id}`}
                  className="text-xs text-accent-text hover:underline"
                >
                  ジョブ
                </Link>
              )}
              {runId && (
                <Link
                  aria-label={`${candidate.name} の実験`}
                  to={`/projects/${batch.project_id}/runs/${encodeRunId(runId)}`}
                  className="text-xs text-accent-text hover:underline"
                >
                  実験
                </Link>
              )}
              {candidate.mismatch && (
                <span className="inline-flex items-center gap-1 text-xs text-warning-text">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  学習した定義がまとまりを作ったときの中身と違います
                </span>
              )}
              {candidate.reason && <span className="text-xs text-ink-3">({candidate.reason})</span>}
            </li>
          )
        })}
      </ol>
      {stop.error && (
        <div className="mt-3">
          <ErrorBox error={stop.error} />
        </div>
      )}
      {remove.error && (
        <div className="mt-3">
          <ErrorBox error={remove.error} />
        </div>
      )}
    </section>
  )
}
