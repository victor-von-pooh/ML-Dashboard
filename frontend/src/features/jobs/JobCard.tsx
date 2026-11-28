import clsx from 'clsx'
import { ExternalLink, OctagonX, RotateCcw, SkipBack, Square } from 'lucide-react'
import { useId } from 'react'
import { Link, useNavigate } from 'react-router'

import { encodeRunId, isCopyRefused, type JobInfo, type Progress } from '../../api/client'
import { useRerunJob, useStopJob } from '../../api/hooks'
import { Button, ErrorBox, StatusBadge } from '../../components/ui'
import { formatDateTime, formatDuration } from '../../lib/format'
import { summarizeDiff } from '../../lib/metrics'
import { estimateRemaining, jobStatus, phaseLabel, progressRatio } from '../../lib/progress'

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
        <span className="tabular-nums text-ink-3">{detail}</span>
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
  const phase = phaseLabel(progress.phase, progress.stage)
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
export function JobCard({
  job,
  detail = false,
  batchLabel,
}: {
  job: JobInfo
  detail?: boolean
  /** 候補のまとまりのジョブなら, どの定義の何番目か */
  batchLabel?: string
}) {
  const stop = useStopJob()
  const running = job.status === 'running'
  const status = jobStatus(job)
  // 学習を終え, スクリプトが評価や推論の一式を書き出している間
  const finishing = status === 'finishing'
  // 起動し直した後の後の処理中のプロセスには, 同じプロセスと確かめられた場合
  // (attached) だけ割り込む. run.json が完了の後は, run.json だけでは同じ pid を
  // 使い回した別のプロセスと見分けられないため
  const detached = finishing && !job.attached
  const forceNoteId = useId()
  const run = job.run
  const rerun = useRerunJob()
  const navigate = useNavigate()
  const batchNoteId = useId()
  // 候補のジョブの中断のボタンには, 次の候補へ進むことの添え書きを結ぶ
  const describedBy = batchLabel && running ? batchNoteId : undefined

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm shadow-black/[0.03]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            {/* 詳細の画面では見出しと重ならないように名前を出さない */}
            {!detail && (
              <h3 className="truncate font-semibold">
                <Link to={`/jobs/${job.id}`} className="hover:text-accent-text">
                  {job.project_name ?? job.project_id} / {job.script}
                </Link>
              </h3>
            )}
          </div>
          {batchLabel && (
            <p id={batchNoteId} className="mt-1 text-xs text-accent-text">
              候補のまとまり: {batchLabel}
              {running && ' (中断しても, まとまりは次の候補へ進みます)'}
            </p>
          )}
          <p className="mt-1 truncate font-mono text-xs text-ink-3" title={job.config}>
            {batchLabel
              ? '候補のまとまりの config'
              : job.config_text != null
                ? '画面で書き換えた config'
                : job.config.split('/').slice(-3).join('/')}
          </p>
          {/* 同じスクリプトのジョブを見分けるための, 進んだエポックと config の違い */}
          {run && (
            <p className="tabular-nums truncate text-xs text-ink-2">
              {run.epochs}
              {run.planned_epochs != null && ` / ${run.planned_epochs}`} エポック
              {' · '}
              {summarizeDiff(run.diff).slice(0, 3).join(', ') || 'default との差分なし'}
              {Object.keys(run.diff).length > 3 && ' …'}
            </p>
          )}
          <p className="tabular-nums text-xs text-ink-3">
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
          {!running && (
            <Button
              icon={RotateCcw}
              disabled={rerun.isPending}
              onClick={() =>
                rerun.mutate(job.id, { onSuccess: (next) => navigate(`/jobs/${next.id}`) })
              }
              title="同じスクリプトと config で, もう一度学習を起動する (モデルは config の model.spec が指す定義で組み立てる. models/ なら今の中身)"
            >
              同じ設定でもう一度
            </Button>
          )}
          {/* 学習を終えた後の処理の間は, エポックで止める要求を読む学習が無い */}
          {running && !finishing && (
            <>
              <Button
                icon={Square}
                disabled={stop.isPending || job.stop_requested}
                onClick={() => stop.mutate({ jobId: job.id, force: false })}
                aria-describedby={describedBy}
              >
                {job.stop_requested ? '止めています' : 'エポックの区切りで止める'}
              </Button>
              <Button
                icon={SkipBack}
                disabled={stop.isPending}
                aria-describedby={describedBy}
                onClick={() => {
                  if (
                    window.confirm(
                      'エポックの途中で学習を止めますか?\n途中のエポックは捨て, 最後に終えたエポックの状態に戻します (設定によっては途中までの重みが残ります).',
                    )
                  ) {
                    stop.mutate({ jobId: job.id, force: false, now: true })
                  }
                }}
              >
                エポックの途中で止める
              </Button>
            </>
          )}
          {running && (
            <Button
              variant="danger"
              icon={OctagonX}
              disabled={stop.isPending || detached}
              aria-describedby={detached ? forceNoteId : describedBy}
              onClick={() => {
                if (
                  window.confirm(
                    finishing
                      ? 'プロセスに割り込んで学習の後の処理を止めますか? (Ctrl-C と同じ)\n推論の一式は残りません.'
                      : 'プロセスに割り込んで学習を止めますか? (Ctrl-C と同じ)\n今のエポックの結果は記録されません.',
                  )
                ) {
                  stop.mutate({ jobId: job.id, force: true })
                }
              }}
            >
              すぐに止める
            </Button>
          )}
        </div>
      </div>

      {rerun.error && (
        <div className="mt-3">
          <ErrorBox error={rerun.error}>
            {isCopyRefused(rerun.error) && (
              <p className="mt-1">
                今の定義で起動し直す場合は, {run && job.run_id ? '「実験を開く」から' : ''}
                実験の詳細を開き, 「この設定でもう一度起動」で開き直してください.
              </p>
            )}
          </ErrorBox>
        </div>
      )}
      {stop.error && (
        <div className="mt-3">
          <ErrorBox error={stop.error} />
        </div>
      )}
      {running && !finishing && (
        <p className="mt-2 text-xs text-ink-3">
          「エポックの区切りで止める」は今のエポックを終えて結果を保存してから止めます.
          「エポックの途中で止める」は次のバッチを終えたところで (多くは数秒以内に) 止め,
          途中のエポックを捨てて最後に終えたエポックの状態に戻します. 対応していない版の ML-Found
          ではエポックの区切りで止めます. 「すぐに止める」はプロセスに割り込むので,
          今のエポックの結果を残しません.
        </p>
      )}
      {finishing && (
        <p className="mt-3 text-xs text-ink-2">
          学習を終えました. スクリプトが学習の後の処理 (評価や推論の一式の書き出しなど)
          をしています. プロセスが終わると「完了」になります.
          {detached ? (
            <span id={forceNoteId}>
              {' '}
              サーバーを起動し直した後で, 同じプロセスと確かめられないので,
              後の処理中のプロセスには割り込めません. 終わるのを待つか, 端末で止めてください.
            </span>
          ) : (
            ' 止める場合は「すぐに止める」で, 推論の一式は残りません.'
          )}
        </p>
      )}
      {running && !finishing && job.progress && (
        <div className="mt-4">
          <ProgressBars progress={job.progress} />
        </div>
      )}
      {running && !finishing && !job.progress && (
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
