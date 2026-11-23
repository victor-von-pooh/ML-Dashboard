import type { PolicyEstimate, TargetPolicy } from '../api/client'
import { formatMetric } from './format'
import { formatShare } from './policy'

/** 軌跡を記録した評価 (ML-Found の trajectories/<名前>.json の source) */
export function describeSource(source: string | null | undefined): string {
  if (source === 'evaluation_loader') return '学習中の検証 (EvaluationLoader)'
  if (source === 'evaluate_policy') return '方策の一式の守り付きの評価 (evaluate_policy)'
  return source ?? '不明'
}

/** 0 以上 1 以下の数の欄の値を読む. 読めなければ null */
export function parseRate(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

/** 見積もる方策の説明 */
export function describeTarget(
  policy: TargetPolicy,
  epsilon: number,
  best: number | null | undefined,
): string {
  if (policy === 'uniform') return '一様 (全ての行動を同じ確率で選ぶ)'
  const action = best == null ? '記録で最も多い行動' : `記録で最も多い行動 ${best}`
  return `ε-greedy (ε = ${epsilon}. ${action} を 1 - ε + ε / n, 他の行動を ε / n で選ぶ)`
}

export interface EstimateRow {
  key: string
  label: string
  value: number | null | undefined
  note: string
}

/** 3 つの見積もりと記録の方策の平均を比べる表の行 */
export function comparisonRows(estimate: PolicyEstimate): EstimateRow[] {
  return [
    {
      key: 'value',
      label: '重み付きの重点サンプリング',
      value: estimate.value,
      note: '重みの和で割る. ばらつきが小さく, 少し偏る',
    },
    {
      key: 'ordinary',
      label: '普通の重点サンプリング',
      value: estimate.ordinary,
      note: 'エピソードの数で割る. 偏らないが, ばらつきが大きい',
    },
    {
      key: 'per_decision',
      label: '歩ごとの重点サンプリング',
      value: estimate.per_decision,
      note: '各歩の報酬に, その歩までの重みを掛ける',
    },
    {
      key: 'behavior_value',
      label: '記録の方策の平均',
      value: estimate.behavior_value,
      note: '記録した報酬の和の平均 (重みを掛けない). 比べる基準',
    },
  ]
}

/** 見積もりの結果を当てにする前に知らせること */
export function estimateWarnings(estimate: PolicyEstimate): string[] {
  const warnings: string[] = []
  if (estimate.value == null) {
    warnings.push(
      '全てのエピソードの重みが 0 なので, 重み付きの見積もりは決まりません. 見積もる方策に近い方策で記録した軌跡が要ります.',
    )
  } else if (estimate.low_ess) {
    warnings.push(
      `有効なサンプルの数 ${formatMetric(estimate.effective_sample_size)} がエピソードの数 ${estimate.episodes} の ${formatShare(estimate.low_ess_ratio)} より少ないので, 見積もりは当てになりません (一部のエピソードの重みが大きく, 最も大きい重みの割合は ${formatShare(estimate.max_weight_share)}).`,
    )
  }
  if (
    estimate.policy === 'epsilon_greedy' &&
    estimate.epsilon === 0 &&
    estimate.zero_weight_episodes > 0
  ) {
    warnings.push(
      `ε = 0 では, 記録で最も多い行動${estimate.best_action == null ? '' : ` (${estimate.best_action})`} の他をとったエピソードの重みが 0 になります (${estimate.zero_weight_episodes} / ${estimate.episodes} エピソード).`,
    )
  }
  return warnings
}
