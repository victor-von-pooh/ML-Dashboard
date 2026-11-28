import { Calculator, Info, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { usePolicyEstimate } from '../../api/hooks'
import type {
  EstimateRequest,
  PolicyEstimate,
  TargetPolicy,
  TrajectoryInfo,
} from '../../api/client'
import { describedBy } from '../../components/common-utils'
import { Button, Card, ErrorBox, FieldError, Spinner } from '../../components/ui'
import { useStableId } from '../../lib/a11y'
import { formatMetric } from '../../lib/format'
import { formatShare } from '../../lib/policy'
import {
  comparisonRows,
  describeActionSpace,
  describeSource,
  describeTarget,
  estimateWarnings,
  parseRate,
} from '../../lib/trajectories'

function Warning({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-warning-text">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {children}
    </p>
  )
}

/** 選んだ軌跡の説明 (ML-Found の trajectories/<名前>.json) */
function TrajectoryDetails({ trajectory }: { trajectory: TrajectoryInfo }) {
  const space = trajectory.action_space
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-3">表</dt>
        <dd className="font-mono text-xs break-all">{trajectory.file}</dd>
        {trajectory.has_info && (
          <>
            <dt className="text-ink-3">記録した評価</dt>
            <dd>{describeSource(trajectory.source)}</dd>
            <dt className="text-ink-3">環境</dt>
            <dd className="font-mono text-xs">{trajectory.env ?? '不明'}</dd>
            <dt className="text-ink-3">エポック</dt>
            <dd className="tabular-nums">{trajectory.epoch ?? '不明'}</dd>
            <dt className="text-ink-3">エピソード</dt>
            <dd className="tabular-nums">
              {trajectory.episodes ?? '不明'} ({trajectory.rows ?? '?'} 行)
            </dd>
            <dt className="text-ink-3">行動の空間</dt>
            <dd>{describeActionSpace(space)}</dd>
          </>
        )}
      </dl>
      {trajectory.description && <p className="text-xs text-ink-2">{trajectory.description}</p>}
      {trajectory.complete === false && (
        <Warning>
          評価で走らせたエピソードの一部が表に入っていません. 表にあるエピソードだけで見積もります.
        </Warning>
      )}
      {trajectory.notice && <Warning>{trajectory.notice}</Warning>}
    </div>
  )
}

/** 見積もりの結果: 重み付きの重点サンプリング, 3 つの見積もりの比べ, 重みのばらつきの印, ML-Found の知らせ */
function EstimateResult({ estimate }: { estimate: PolicyEstimate }) {
  const warnings = estimateWarnings(estimate)
  return (
    <section aria-label={`見積もり ${estimate.name}`} className="space-y-3">
      <p className="text-xs text-ink-3">
        <span className="font-mono">{estimate.name}</span> ·{' '}
        {describeTarget(estimate.policy, estimate.epsilon, estimate.best_action)} · γ ={' '}
        {estimate.gamma} · 行動 {estimate.action_start} から{' '}
        {estimate.action_start + estimate.action_count - 1} の {estimate.action_count} 個 ·{' '}
        {estimate.episodes} エピソード {estimate.steps} 歩
      </p>
      {warnings.map((warning) => (
        <Warning key={warning}>{warning}</Warning>
      ))}
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['重み付きの重点サンプリング', formatMetric(estimate.value)],
          [
            '有効なサンプルの数',
            `${formatMetric(estimate.effective_sample_size)} / ${estimate.episodes}`,
          ],
          ['最も大きい重みの割合', formatShare(estimate.max_weight_share)],
          ['重みが 0 のエピソード', `${estimate.zero_weight_episodes} / ${estimate.episodes}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line px-3 py-2">
            <dt className="text-xs text-ink-3">{label}</dt>
            <dd className="tabular-nums text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{`${estimate.name} の見積もりの比べ`}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-1.5 font-medium whitespace-nowrap">見積もり</th>
              <th className="px-4 py-1.5 text-right font-medium whitespace-nowrap">値</th>
              <th className="px-4 py-1.5 font-medium whitespace-nowrap">読み方</th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows(estimate).map((row) => (
              <tr key={row.key} className="border-b border-line last:border-b-0">
                <td className="px-4 py-1.5 whitespace-nowrap">{row.label}</td>
                <td className="tabular-nums px-4 py-1.5 text-right">{formatMetric(row.value)}</td>
                <td className="px-4 py-1.5 text-xs text-ink-2">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {estimate.underflow_episodes > 0 && (
        <p className="text-xs text-ink-2">
          {estimate.underflow_episodes} エピソードの重みは, 最も大きい重みより非常に小さいので 0
          として計算しました.
        </p>
      )}
      <div>
        <h3 className="text-sm font-medium">ML-Found の知らせ</h3>
        {estimate.notes.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">ありません.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {estimate.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 記録した軌跡 (trajectories/) から, 決まった形の方策の良さを見積もる */
export function TrajectoriesTab({
  trajectories,
  projectId,
  runId,
}: {
  trajectories: TrajectoryInfo[]
  projectId: string
  runId: string
}) {
  const idBase = useStableId('trajectories')
  // 見積もれる軌跡を先に選んでおく
  const [name, setName] = useState(
    () => (trajectories.find((item) => !item.reason) ?? trajectories[0])?.name ?? '',
  )
  const [policy, setPolicy] = useState<TargetPolicy>('uniform')
  const [epsilonText, setEpsilonText] = useState('0.1')
  const [gammaText, setGammaText] = useState('1')
  const [submitted, setSubmitted] = useState<EstimateRequest | null>(null)
  const estimate = usePolicyEstimate(projectId, runId, submitted)

  const selected = trajectories.find((item) => item.name === name)
  const epsilon = parseRate(epsilonText)
  const gamma = parseRate(gammaText)
  const greedy = policy === 'epsilon_greedy'
  const invalid = gamma === null || (greedy && epsilon === null)
  const canEstimate = selected != null && !selected.reason && !invalid

  const submit = () => {
    if (!canEstimate || gamma === null) return
    setSubmitted({
      trajectory: selected.name,
      policy,
      epsilon: greedy && epsilon !== null ? epsilon : 1,
      gamma,
    })
  }

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-ink-2">
        <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        記録した軌跡から, 環境で動かさずに別の方策の良さ (エピソードの割り引いた報酬の和の期待値)
        を重点サンプリングで見積もります. 行動を番号で選び,
        記録した方策が行動を選んだ確率を持つ軌跡だけを使えます.
      </p>
      <Card title="見積もる">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`${idBase}-name`} className="block text-xs font-medium text-ink-2">
                軌跡
              </label>
              <select
                id={`${idBase}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm"
              >
                {trajectories.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                    {item.reason ? ' (見積もれない)' : ''}
                  </option>
                ))}
              </select>
              {selected && <TrajectoryDetails trajectory={selected} />}
              {selected?.reason && (
                <ErrorBox error={`この軌跡は見積もれません: ${selected.reason}`} live={false} />
              )}
            </div>
            <div className="space-y-3">
              <fieldset>
                <legend className="text-xs font-medium text-ink-2">見積もる方策</legend>
                <div className="mt-1 space-y-1 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${idBase}-policy`}
                      checked={policy === 'uniform'}
                      onChange={() => setPolicy('uniform')}
                    />
                    一様 (全ての行動を同じ確率で選ぶ)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${idBase}-policy`}
                      checked={greedy}
                      onChange={() => setPolicy('epsilon_greedy')}
                    />
                    記録で最も多い行動の ε-greedy
                  </label>
                </div>
              </fieldset>
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="text-xs font-medium text-ink-2">
                    ε (0 以上 1 以下)
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={epsilonText}
                      disabled={!greedy}
                      onChange={(event) => setEpsilonText(event.target.value)}
                      aria-invalid={greedy && epsilon === null}
                      aria-describedby={describedBy(
                        greedy && epsilon === null && `${idBase}-epsilon-error`,
                      )}
                      className="mt-1 block h-8 w-28 rounded-md border border-line bg-bg px-2 text-sm disabled:opacity-50"
                    />
                  </label>
                  {greedy && epsilon === null && (
                    <FieldError id={`${idBase}-epsilon-error`}>
                      0 以上 1 以下の数にしてください
                    </FieldError>
                  )}
                </div>
                <div>
                  <label className="text-xs font-medium text-ink-2">
                    割引率 γ (0 以上 1 以下)
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={gammaText}
                      onChange={(event) => setGammaText(event.target.value)}
                      aria-invalid={gamma === null}
                      aria-describedby={describedBy(gamma === null && `${idBase}-gamma-error`)}
                      className="mt-1 block h-8 w-28 rounded-md border border-line bg-bg px-2 text-sm"
                    />
                  </label>
                  {gamma === null && (
                    <FieldError id={`${idBase}-gamma-error`}>
                      0 以上 1 以下の数にしてください
                    </FieldError>
                  )}
                </div>
              </div>
              {greedy && epsilon === 0 && (
                <Warning>
                  ε = 0 では, 記録で最も多い行動の他をとったエピソードの重みが 0 になります.
                </Warning>
              )}
              <Button type="submit" variant="primary" icon={Calculator} disabled={!canEstimate}>
                見積もる
              </Button>
            </div>
          </div>
        </form>
      </Card>
      {submitted && (
        <Card title="見積もりの結果">
          {estimate.data ? (
            <EstimateResult estimate={estimate.data} />
          ) : estimate.error ? (
            <ErrorBox error={estimate.error} />
          ) : (
            <Spinner label="見積もり中" />
          )}
        </Card>
      )}
    </div>
  )
}
