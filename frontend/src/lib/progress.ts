import type { JobInfo, Progress, RunStatus } from '../api/client'

/**
 * エポックの中の進み具合 (0 から 1). 検証中と, 学習用データの評価し直し
 * (train_eval) の間は, 学習を終えたものとして扱う
 */
export function progressRatio(progress: Progress): number {
  if (progress.phase !== 'train') return 1
  if (!progress.total_batches) return 0
  return Math.min(1, progress.batch / progress.total_batches)
}

/** 進み具合のフェーズの表示名 */
export function phaseLabel(phase: string): string {
  if (phase === 'valid') return '検証'
  if (phase === 'train_eval') return '学習用データの評価'
  return '学習'
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
