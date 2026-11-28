import { Trophy } from 'lucide-react'
import { useMemo } from 'react'

import type { BestValue } from '../../api/client'
import { DirectionBadge } from '../../components/ui'
import {
  epochMetrics,
  PHASE_LABELS,
  type EpochCell,
  type HistoryIndex,
} from '../../lib/epochMetrics'
import { formatMetric } from '../../lib/format'

/** 見本の横に並べる, 見本と同じエポックの評価 */
export interface EpochMetricsSource {
  /** エポックで引ける history.csv (読む間と読めなかった場合は undefined) */
  index?: HistoryIndex
  /** history.csv を読めなかったか */
  historyFailed?: boolean
  best?: BestValue | null
  /** ML-Found の検証の間隔 (trainer.valid_every_n_epochs) */
  validInterval: number
}

function Cell({ cell, interval }: { cell: EpochCell | undefined; interval: number }) {
  if (!cell) return <td className="px-2 py-1" />
  if (cell.value == null) {
    return (
      <td
        className="px-2 py-1 text-right align-top whitespace-nowrap text-ink-3"
        title={
          cell.skipped
            ? `${interval} エポックおきに検証するので, このエポックは検証していません`
            : 'このエポックの記録がありません'
        }
      >
        {cell.skipped ? '検証なし' : '—'}
      </td>
    )
  }
  return (
    <td className="tabular-nums px-2 py-1 text-right align-top whitespace-nowrap text-ink">
      <span className="flex flex-col items-end">
        {formatMetric(cell.value)}
        {cell.mark && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-warning-text">
            <Trophy className="size-3 text-warning" aria-hidden />
            {cell.mark === 'best' ? 'ベスト' : '最良 (推測)'}
          </span>
        )}
      </span>
    </td>
  )
}

/** 見本のエポックの history.csv の指標 (学習用と検証用) の表 */
export function EpochMetrics({
  name,
  epoch,
  index,
  historyFailed = false,
  best,
  validInterval,
}: EpochMetricsSource & { name: string; epoch: number | null | undefined }) {
  const table = useMemo(
    () => (index && epoch != null ? epochMetrics(index, epoch, best, validInterval) : null),
    [index, epoch, best, validInterval],
  )
  const heading = (
    <h4 className="text-xs font-medium text-ink-2">
      {epoch == null ? '同じエポックの評価' : `エポック ${epoch} の評価`}
    </h4>
  )
  // 学習の後の見本は, どのエポックの重みで作ったかが分からないので並べない
  if (epoch == null) {
    return (
      <section aria-label={`${name} の見本と同じエポックの評価`} className="space-y-1">
        {heading}
        <p className="text-xs text-ink-3">
          学習の後の見本はエポックに結び付かないので, 指標を並べません.
          最後のエポックの監視する指標と検証用の値は, 上の「最終」の欄にあります.
        </p>
      </section>
    )
  }
  return (
    <section aria-label={`${name} の見本と同じエポックの評価`} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        {best &&
          (best.epoch === epoch ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
              <Trophy className="size-3 text-warning" aria-hidden />
              ベストのエポック
            </span>
          ) : (
            <span className="text-[11px] text-ink-3">
              ベストはエポック {best.epoch} ({best.monitor})
            </span>
          ))}
      </div>
      {!index ? (
        <p className="text-xs text-ink-3">
          {historyFailed
            ? 'history.csv を読めませんでした. 学習曲線のタブで理由を確かめられます.'
            : 'history.csv を読んでいます.'}
        </p>
      ) : !table ? (
        <p className="text-xs text-ink-3">history.csv にエポック {epoch} の記録がありません.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <caption className="sr-only">
                {name} の見本と同じエポック {epoch} の指標
              </caption>
              <thead>
                <tr className="border-b border-line text-ink-3">
                  <th scope="col" className="px-2 py-1 text-left font-medium">
                    指標
                  </th>
                  {table.phases.map((phase) => (
                    <th key={phase} scope="col" className="px-2 py-1 text-right font-medium">
                      {PHASE_LABELS[phase]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.name} className="border-b border-line last:border-0">
                    <th
                      scope="row"
                      className="min-w-[7.5rem] px-2 py-1 text-left align-top font-normal"
                    >
                      <span className="font-mono text-ink">{row.name}</span>
                      {(row.direction || row.monitor) && (
                        <span className="mt-0.5 flex flex-col items-start gap-0.5 whitespace-nowrap">
                          {row.direction && <DirectionBadge value={row.direction} />}
                          {row.monitor && (
                            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
                              監視する指標
                            </span>
                          )}
                        </span>
                      )}
                    </th>
                    {table.phases.map((phase) => (
                      <Cell key={phase} cell={row.cells[phase]} interval={validInterval} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-ink-3">
            「ベストのエポック」の印, 「ベストはエポック N」の文と監視する指標の「ベスト」は,
            ML-Found がモデルに選んだエポック (run.json のベスト) を指します.
            {table.guessed &&
              ' 「最良 (推測)」は監視しない指標の, 記録した全てのエポックの中で最も良い値です (向きは指標の名前から推測).'}
            {table.skipped &&
              ` 検証は ${validInterval} エポックおきなので, 検証しないエポックの検証用の値は「検証なし」です.`}
            {table.missing && ' — は history.csv に値の無い列です.'}
          </p>
        </>
      )}
    </section>
  )
}
