import { useCallback, useMemo, useState } from 'react'

import type { BestValue, History } from '../../api/client'
import { LineChart, type ChartMarker, type ChartSeries } from '../../components/LineChart'
import { Card, DirectionBadge, MetricTitle } from '../../components/ui'
import {
  EPOCH_AXIS,
  axisAt,
  axisLabel,
  axisOptions,
  axisStart,
  columnDirection,
  groupMetrics,
  integerAxis,
  judgedOnly,
  pointStyle,
  toPoints,
} from '../../lib/metrics'
import { seriesVar } from '../../lib/colors'

/**
 * 学習率のグラフに重ねる, 更新ごとの学習率の点を返す. lr は 1 つの Optimizer の列,
 * lr_<名前> は名前付きの複数の Optimizer の列で, それ以外の指標は空
 */
function stepsOf(history: History, name: string): History['lr_steps'] {
  if (name === 'lr') return history.lr_steps
  const named = history.named_lr_steps ?? {}
  return (name.startsWith('lr_') && Object.hasOwn(named, name) && named[name]) || []
}

/** 学習用を 1 色目, 検証用を 2 色目, 学習用データの評価し直しを 3 色目にそろえる */
function colorIndex(key: string, position: number): number {
  if (key.startsWith('train/')) return 0
  if (key.startsWith('valid/')) return 1
  if (key.startsWith('train_eval/')) return 2
  return position
}

/** 1 つの実験の指標を, 学習用と検証用を重ねたグラフで並べる */
export function MetricCharts({
  history,
  best,
  earlyStoppedEpoch,
  validInterval = 1,
}: {
  history: History
  best?: BestValue | null
  earlyStoppedEpoch?: number | null
  /** ML-Found の検証の間隔 (trainer.valid_every_n_epochs) */
  validInterval?: number
}) {
  const [logScale, setLogScale] = useState(false)
  // 横軸の列 (エポックか, エポックごとに増え続ける列). 候補から消えた列はエポックに戻す
  const [chosenAxis, setAxis] = useState(EPOCH_AXIS)
  const options = useMemo(() => axisOptions([history]), [history])
  const axis = options.includes(chosenAxis) ? chosenAxis : EPOCH_AXIS
  const byEpoch = axis === EPOCH_AXIS
  // 横軸に選んだ列そのもののグラフは出さない (横軸と同じ値の直線になるため)
  const groups = useMemo(
    () =>
      groupMetrics(history.columns).filter(
        (group) => byEpoch || !(group.keys.length === 1 && group.keys[0] === axis),
      ),
    [history.columns, byEpoch, axis],
  )
  const integerX = useMemo(() => integerAxis([history], axis), [history, axis])
  const xMin = useMemo(() => axisStart([history], axis), [history, axis])
  // 更新ごとの学習率はエポックの軸の上の位置なので, 横軸がエポックのときだけ重ねる
  const steps = useCallback(
    (name: string) => (byEpoch ? stepsOf(history, name) : []),
    [byEpoch, history],
  )
  const hiddenSteps = !byEpoch && groups.some((group) => stepsOf(history, group.name).length > 0)

  // ベストと早期終了の目印は, 選んだ横軸の上の位置に置く (位置の無いものは出さない)
  const markers = useMemo(() => {
    const result: ChartMarker[] = []
    const at = (epoch: number) => axisAt(history, axis, epoch)
    const bestX = best ? at(best.epoch) : null
    if (best && bestX != null) result.push({ x: bestX, label: `best ${best.epoch}` })
    const stopX = earlyStoppedEpoch ? at(earlyStoppedEpoch) : null
    if (earlyStoppedEpoch && earlyStoppedEpoch !== best?.epoch && stopX != null) {
      result.push({ x: stopX, label: 'early stop' })
    }
    return result
  }, [best, earlyStoppedEpoch, history, axis])

  const charts = useMemo(
    () =>
      groups.map((group) => ({
        group,
        series: [
          ...group.keys.map<ChartSeries>((key, position) => ({
            name: key,
            color: seriesVar(colorIndex(key, position)),
            points: toPoints(history, key, axis),
            sparse: judgedOnly(key, validInterval) || undefined,
          })),
          // step ごとに学習率を変えた実験は, エポックの中の変化も点線で重ねる
          // (位置はバックエンドがエポックの軸の上に計算済み. 対数の軸では 0 以下を欠損)
          ...(steps(group.name).length > 0
            ? [
                {
                  name: `${group.name} (更新ごと)`,
                  color: seriesVar(2),
                  dashed: true,
                  points: steps(group.name).map<[number, number | null]>(({ x, lr }) => [
                    x,
                    logScale && lr != null && lr <= 0 ? null : lr,
                  ]),
                },
              ]
            : []),
        ],
        // 良い向き (監視する指標はその向き, 他は指標の名前から推測)
        direction: columnDirection(
          best && group.keys.includes(best.monitor) ? best.monitor : group.name,
          [best],
        ),
        // 何エポックかおきにだけ記録した系列 (グラフの下に点で描いた旨を添える)
        sparse: group.keys.filter(
          (key) =>
            judgedOnly(key, validInterval) || pointStyle(toPoints(history, key, axis)).sparse,
        ),
      })),
    [groups, history, logScale, validInterval, best, axis, steps],
  )

  if (history.rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-3">
        記録された指標がありません. 最初のエポックを終える前に止まったか, 学習中です.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-4">
        {options.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-ink-2">
            横軸
            <select
              value={axis}
              onChange={(event) => setAxis(event.target.value)}
              className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {axisLabel(option)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={logScale}
            onChange={(event) => setLogScale(event.target.checked)}
            className="accent-[var(--accent)]"
          />
          縦軸を対数にする (正の値だけの指標)
        </label>
      </div>
      {hiddenSteps && (
        <p className="text-right text-[11px] text-ink-3">
          更新ごとの学習率は, 横軸がエポックのときだけ重ねます
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {charts.map(({ group, series, sparse, direction }) => (
          <Card
            key={group.name}
            title={<MetricTitle name={group.name} />}
            actions={
              direction || (best && group.keys.includes(best.monitor)) ? (
                <>
                  {direction && <DirectionBadge value={direction} />}
                  {best && group.keys.includes(best.monitor) && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
                      監視する指標
                    </span>
                  )}
                </>
              ) : undefined
            }
          >
            <LineChart
              series={series}
              markers={markers}
              logScale={logScale}
              xLabel={axis}
              integerX={integerX}
              xMin={xMin}
              label={
                !byEpoch
                  ? `${group.name} の ${axis} に対する推移`
                  : steps(group.name).length > 0
                    ? `${group.name} のエポックごとの推移と, 更新ごとの推移`
                    : `${group.name} のエポックごとの推移`
              }
            />
            {sparse.length > 0 && (
              <p className="mt-2 text-[11px] text-ink-3">
                {sparse.join(', ')} は記録のあるエポック (検証したエポックなど) を点で示し,
                間を線でつないでいます
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
