import { useMemo, useState } from 'react'

import type { BestValue, History } from '../../api/client'
import { LineChart, type ChartMarker, type ChartSeries } from '../../components/LineChart'
import { Card } from '../../components/ui'
import { groupMetrics, toPoints } from '../../lib/metrics'
import { seriesVar } from '../../lib/colors'

/** 学習用を 1 色目, 検証用を 2 色目にそろえる */
function colorIndex(key: string, position: number): number {
  if (key.startsWith('train/')) return 0
  if (key.startsWith('valid/')) return 1
  return position
}

/** 1 つの実験の指標を, 学習用と検証用を重ねたグラフで並べる */
export function MetricCharts({
  history,
  best,
  earlyStoppedEpoch,
}: {
  history: History
  best?: BestValue | null
  earlyStoppedEpoch?: number | null
}) {
  const [logScale, setLogScale] = useState(false)
  const groups = useMemo(() => groupMetrics(history.columns), [history.columns])

  const markers = useMemo(() => {
    const result: ChartMarker[] = []
    if (best) result.push({ x: best.epoch, label: `best ${best.epoch}` })
    if (earlyStoppedEpoch && earlyStoppedEpoch !== best?.epoch) {
      result.push({ x: earlyStoppedEpoch, label: 'early stop' })
    }
    return result
  }, [best, earlyStoppedEpoch])

  const charts = useMemo(
    () =>
      groups.map((group) => ({
        group,
        series: group.keys.map<ChartSeries>((key, position) => ({
          name: key,
          color: seriesVar(colorIndex(key, position)),
          points: toPoints(history, key),
        })),
      })),
    [groups, history],
  )

  if (history.rows.length === 0) {
    return <p className="py-10 text-center text-sm text-ink-3">history.csv がまだありません.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
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
      <div className="grid gap-4 lg:grid-cols-2">
        {charts.map(({ group, series }) => (
          <Card
            key={group.name}
            title={<span className="font-mono">{group.name}</span>}
            actions={
              best && group.keys.includes(best.monitor) ? (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-strong">
                  監視する指標
                </span>
              ) : undefined
            }
          >
            <LineChart
              series={series}
              markers={markers}
              logScale={logScale}
              xLabel="epoch"
              label={`${group.name} のエポックごとの推移`}
            />
          </Card>
        ))}
      </div>
    </div>
  )
}
