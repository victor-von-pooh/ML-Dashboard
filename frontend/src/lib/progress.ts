import type { JobInfo, Progress, RunStatus } from '../api/client'

/** エポックの中の進み具合 (0 から 1). 検証中は学習を終えたものとして扱う */
export function progressRatio(progress: Progress): number {
  if (!progress.total_batches) return progress.phase === 'valid' ? 1 : 0
  const within = Math.min(1, progress.batch / progress.total_batches)
  return progress.phase === 'valid' ? 1 : within
}

/** これまでの速さから, 予定のエポックを終えるまでの残りの秒数を見積もる */
export function estimateRemaining(progress: Progress, startEpoch = 1): number | null {
  // 経過時間はこのプロセスの分だけなので, 再開した場合は再開してからのエポックで割る
  const done = progress.epoch - startEpoch + progressRatio(progress)
  if (done <= 0 || progress.elapsed_sec <= 0) return null
  const remaining =
    (progress.elapsed_sec / done) *
    (progress.total_epochs - (progress.epoch - 1) - progressRatio(progress))
  return Math.max(0, remaining)
}

/** ジョブの状態を, 実験の状態に合わせて表す */
export function jobStatus(job: JobInfo): RunStatus {
  if (job.run) return job.run.status
  if (job.status === 'running') return 'running'
  if (job.stop_requested) return 'stopped'
  return job.return_code === 0 ? 'completed' : 'failed'
}
