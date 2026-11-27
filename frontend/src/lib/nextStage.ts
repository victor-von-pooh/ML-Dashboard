import type { JobInfo, RunStatus } from '../api/client'
import { jobStatus } from './progress'

// ML-Inference が推論の一式として読むファイル (実験のディレクトリから)
export const BUNDLE_FILE = 'inference/inference.yaml'

/**
 * 実験の学習のジョブの様子. running は学習の後の処理 (推論の一式の書き出しなど) の途中か
 * 学習中, halted は後の処理で失敗したか止めた, none はジョブが無いか終えた (端末から起動した
 * 学習と, ジョブの一覧を読めなかった場合も). null はジョブの一覧を読む前
 */
export type JobPhase = 'running' | 'halted' | 'none' | null

/**
 * この実験 (projectId, runId) を学習したジョブ (ダッシュボードから起動したもの) のうち,
 * 最も新しいものの様子を決める
 */
export function jobPhaseOf(
  jobs: JobInfo[],
  projectId: string,
  runId: string,
): { phase: Exclude<JobPhase, null>; job: JobInfo | null } {
  const own = jobs
    .filter((job) => job.project_id === projectId && job.run_id === runId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const job = own[0] ?? null
  if (!job) return { phase: 'none', job }
  if (job.status === 'running') return { phase: 'running', job }
  // 実験は完了でも終了コードが 0 でない (か止めた) ジョブは, 後の処理で止まり一式を書き終えていない
  const status = jobStatus(job)
  return { phase: status === 'failed' || status === 'stopped' ? 'halted' : 'none', job }
}

/** 次の段階への案内に使う, 実験の詳細の値 */
export interface NextStageRun {
  status: RunStatus
  /** 使ったモデルの定義の名前 (定義の記録が無い実験は null) */
  model?: unknown
  files: { path: string }[]
  /**
   * この実験の学習のジョブの様子. 学習のスクリプトは run.json を完了にした後に推論の一式を
   * 書き出すので, 動いている間は後の処理の途中
   */
  job: JobPhase
}

/** 次の段階への案内を出すかと, 推論の一式を持つかと, 学習の後の処理の様子 */
export interface NextStage {
  show: boolean
  hasBundle: boolean
  /** 学習を終え, ジョブが推論の一式などを書き出している途中 (案内の代わりに出す) */
  finishing: boolean
  /** 学習を終えた後の処理でジョブが失敗したか止めた (案内の代わりにジョブの状態を出す) */
  halted: boolean
}

/**
 * 次の段階への案内を出すかを決める. モデルの定義か推論の一式 (inference/inference.yaml)
 * を持つ完了した実験に出す. run.json の無い実験 (学習を行わない距離に基づく度合いなど)
 * は状態が不明なので, 案内の判定では一式 (評価の後に作る) を持てば終えたものとする
 * (状態の表示は未完了のまま). inference/ の下に別のファイルだけがある実験は一式とみなさない.
 * 学習のジョブが動いている間と, 後の処理で失敗したか止めた場合は出さない (ジョブの一覧を
 * 読む前も出さない)
 */
export function nextStage(run: NextStageRun): NextStage {
  const has = (path: string) => run.files.some((file) => file.path === path)
  const hasBundle = has(BUNDLE_FILE)
  const finished =
    run.status === 'completed' || (run.status === 'unknown' && hasBundle && !has('run.json'))
  const finishing = finished && run.job === 'running'
  const halted = finished && run.job === 'halted'
  const settled = finished && run.job === 'none'
  return { show: settled && (run.model != null || hasBundle), hasBundle, finishing, halted }
}
