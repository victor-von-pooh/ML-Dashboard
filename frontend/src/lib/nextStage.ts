import type { RunStatus } from '../api/client'

// ML-Inference が推論の一式として読むファイル (実験のディレクトリから)
export const BUNDLE_FILE = 'inference/inference.yaml'

/** 次の段階への案内に使う, 実験の詳細の値 */
export interface NextStageRun {
  status: RunStatus
  /** 使ったモデルの定義の名前 (定義の記録が無い実験は null) */
  model?: unknown
  files: { path: string }[]
}

/** 次の段階への案内を出すかと, 推論の一式を持つか */
export interface NextStage {
  show: boolean
  hasBundle: boolean
}

/**
 * 次の段階への案内を出すかを決める. モデルの定義か推論の一式 (inference/inference.yaml)
 * を持つ完了した実験に出す. run.json の無い実験 (学習を行わない距離に基づく度合いなど)
 * は状態が不明なので, 案内の判定では一式 (評価の後に作る) を持てば終えたものとする
 * (状態の表示は未完了のまま). inference/ の下に別のファイルだけがある実験は一式とみなさない
 */
export function nextStage(run: NextStageRun): NextStage {
  const has = (path: string) => run.files.some((file) => file.path === path)
  const hasBundle = has(BUNDLE_FILE)
  const finished =
    run.status === 'completed' || (run.status === 'unknown' && hasBundle && !has('run.json'))
  return { show: finished && (run.model != null || hasBundle), hasBundle }
}
