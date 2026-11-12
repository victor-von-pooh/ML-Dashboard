import clsx from 'clsx'
import { ExternalLink, OctagonX, Square } from 'lucide-react'
import { Link } from 'react-router'

import { encodeRunId, type JobInfo, type Progress } from '../../api/client'
import { useStopJob } from '../../api/hooks'
import { Button, ErrorBox, StatusBadge } from '../../components/ui'
import { formatDateTime, formatDuration } from '../../lib/format'
import { estimateRemaining, jobStatus, progressRatio } from '../../lib/progress'

/** 割合の進捗バー. 読み上げ用に値も持たせる */
export function ProgressBar({
  label,
  value,
  max,
  detail,
}: {
  label: string
  value: number
  max: number | null
  detail: string
}) {
  const ratio = max ? Math.min(1, value / max) : null
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="tabular text-ink-3">{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={max ? value : undefined}
        aria-valuetext={detail}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={clsx(
            'h-full rounded-full bg-accent transition-[width] duration-500',
            ratio === null && 'w-1/3 animate-pulse',
          )}
          style={ratio === null ? undefined : { width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  )
}

/** エポックとバッチの進捗バー */
export function ProgressBars({ progress }: { progress: Progress }) {
  const remaining = estimateRemaining(progress, progress.start_epoch)
  const phase = progress.phase === 'valid' ? '検証' : '学習'
  return (
    <div className="space-y-3">
      <ProgressBar
        label="エポック"
        value={progress.epoch - 1 + progressRatio(progress)}
        max={progress.total_epochs}
        detail={`${progress.epoch} / ${progress.total_epochs} · 経過 ${formatDuration(
          progress.elapsed_sec,
        )}${remaining != null ? ` · 残り約 ${formatDuration(remaining)}` : ''}`}
      />
      <ProgressBar
        label={`エポックの中 (${phase})`}
        value={progress.batch}
        max={progress.total_batches ?? null}
        detail={`${progress.batch}${progress.total_batches != null ? ` / ${progress.total_batches}` : ''} バッチ`}
      />
    </div>
  )
}

/** ジョブの概要と操作 */
export function JobCard({ job, detail = false }: { job: JobInfo; detail?: boolean }) {
  const stop = useStopJob()
  const running = job.status === 'running'
  const run = job.run

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={jobStatus(job)} />
            {/* 詳細の画面では見出しと重ならないように名前を出さない */}
            {!detail && (
              <h3 className="truncate font-semibold">
                <Link to={`/jobs/${job.id}`} className="hover:text-accent-text">
                  {job.project_name ?? job.project_id} / {job.script}
                </Link>
              </h3>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-ink-3" title={job.config}>
            {job.config_text != null
              ? '画面で書き換えた config'
              : job.config.split('/').slice(-3).join('/')}
          </p>
          <p className="tabular text-xs text-ink-3">
            開始 {formatDateTime(job.created_at)}
            {job.finished_at && ` · 終了 ${formatDateTime(job.finished_at)}`}
            {job.return_code != null && ` · 終了コード ${job.return_code}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {run && job.run_id && (
            <Link
              to={`/projects/${job.project_id}/runs/${encodeRunId(job.run_id)}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-sm hover:bg-surface-2"
            >
              <ExternalLink className="size-4" aria-hidden />
              実験を開く
            </Link>
          )}
          {running && (
            <>
              <Button
                icon={Square}
                disabled={stop.isPending || job.stop_requested}
                onClick={() => stop.mutate({ jobId: job.id, force: false })}
              >
                {job.stop_requested ? '止めています' : 'エポックの区切りで止める'}
              </Button>
              <Button
                variant="danger"
                icon={OctagonX}
                disabled={stop.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      'エポックの途中で学習を止めますか? (Ctrl-C と同じ)\n今のエポックの結果は記録されません.',
                    )
                  ) {
                    stop.mutate({ jobId: job.id, force: true })
                  }
                }}
              >
                すぐに止める
              </Button>
            </>
          )}
        </div>
      </div>

      {stop.error && (
        <div className="mt-3">
          <ErrorBox error={stop.error} />
        </div>
      )}
      {running && (
        <p className="mt-2 text-xs text-ink-3">
          「エポックの区切りで止める」は今のエポックを終えて結果を保存してから止めます.
          「すぐに止める」は今のエポックの結果を残しません.
        </p>
      )}
      {running && job.progress && (
        <div className="mt-4">
          <ProgressBars progress={job.progress} />
        </div>
      )}
      {running && !job.progress && (
        <p className="mt-3 text-xs text-ink-3">
          学習の準備中です (データの読み込みなど). 進み具合は ML-Found が progress.json
          を書き始めると表示されます.
        </p>
      )}
      {!running && run?.error && <p className="mt-3 text-xs text-critical-text">{run.error}</p>}
      {job.config_text != null && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-ink-2">書き換えた config の中身</summary>
          <pre className="mt-2 overflow-auto rounded-lg bg-surface-2/60 p-3 font-mono text-ink-2">
            {job.config_text || '(空: default のまま)'}
          </pre>
        </details>
      )}
    </section>
  )
}
