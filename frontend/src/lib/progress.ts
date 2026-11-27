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

/** 進み具合のフェーズの表示名 (エポックの終わりの処理の間は, その旨も) */
export function phaseLabel(phase: string, stage?: string | null): string {
  const name = phase === 'valid' ? '検証' : phase === 'train_eval' ? '学習用データの評価' : '学習'
  return stage === 'epoch_end' ? `${name}の終わりの評価中` : name
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

/**
 * ジョブの状態の印. 実験の状態に, 学習を終えてスクリプトが後の処理
 * (評価や推論の一式の書き出しなど) をしている間の「後の処理中」を足したもの
 */
export type JobStatus = RunStatus | 'finishing'

/** ジョブの状態を, プロセスの生死と実験の状態を合わせて表す */
export function jobStatus(job: JobInfo): JobStatus {
  const runStatus = job.run?.status
  // 実験は完了でもプロセスが動いている間は, 学習の後の処理の途中
  // (ML-Found は fit の終わりに完了を書き, 推論の一式はその後に書き出す)
  if (job.status === 'running' && runStatus === 'completed') return 'finishing'
  // 実験は完了でも終了コードが 0 でなければ, 学習の後の処理で止まった
  // (終了コードの分からない, ダッシュボードが起動していないプロセスは実験の状態に従う)
  if (
    job.status === 'finished' &&
    runStatus === 'completed' &&
    job.return_code != null &&
    job.return_code !== 0
  ) {
    return job.stop_requested ? 'stopped' : 'failed'
  }
  // 終わったジョブの実験の状態が分からない (run.json を書く前に止まった)
  // 場合は, 終了コードで判断する
  const settled = job.status === 'finished' && (runStatus === 'unknown' || runStatus === 'running')
  if (job.run && !settled) return job.run.status
  if (job.status === 'running') return 'running'
  if (job.stop_requested) return 'stopped'
  return job.return_code === 0 ? 'completed' : 'failed'
}
