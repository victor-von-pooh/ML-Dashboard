import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react'
import { useId, useState } from 'react'

import { runFileUrl } from '../../api/client'
import { Card } from '../../components/ui'
import type { SharedImageSeries } from '../../lib/images'

interface RunColumn {
  id: string
  label: string
  color: string
}

/** 並びの名前を, 表示する題名 (ディレクトリ) と番号の単位 (epoch など) に分ける */
function splitName(name: string): { title: string; unit: string } {
  const slash = name.lastIndexOf('/')
  if (slash < 0) return { title: name, unit: '' }
  return { title: name.slice(0, slash), unit: name.slice(slash + 1) }
}

/** 1 つの並びについて, 同じ番号の画像を実験ごとに横に並べる */
function SharedSeriesViewer({
  series,
  runs,
  projectId,
}: {
  series: SharedImageSeries
  runs: RunColumn[]
  projectId: string
}) {
  const sliderId = useId()
  const last = series.steps.length - 1
  // null は最後の番号を表示 (学習中に画像が増えたら最新に追従)
  const [index, setIndex] = useState<number | null>(null)
  const current = index === null ? last : Math.min(index, last)
  const step = series.steps[current]!
  const { title, unit } = splitName(series.name)
  const stepLabel = unit ? `${unit} ${step}` : String(step)

  const select = (next: number) => {
    const clamped = Math.max(0, Math.min(last, next))
    setIndex(clamped === last ? null : clamped)
  }

  return (
    <Card
      title={<span className="font-mono">{title}</span>}
      actions={<span className="tabular text-sm font-semibold text-ink">{stepLabel}</span>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {runs.map((run, position) => {
            const frames = series.frames[position]
            const path = frames?.get(step)
            return (
              <figure key={run.id} className="min-w-0 space-y-1">
                <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
                  {path ? (
                    <img
                      src={runFileUrl(projectId, run.id, path)}
                      alt={`${run.label} の ${title} (${stepLabel})`}
                      className="size-full object-contain [image-rendering:pixelated]"
                    />
                  ) : (
                    <span className="flex flex-col items-center gap-1 px-2 text-center text-[11px] text-ink-3">
                      <ImageOff className="size-4" aria-hidden />
                      {frames ? 'この番号の画像はありません' : 'この並びの画像はありません'}
                    </span>
                  )}
                </div>
                <figcaption className="flex items-center gap-1.5 text-xs text-ink-2">
                  <span
                    className="h-1 w-3 shrink-0 rounded-full"
                    style={{ background: `var(${run.color})` }}
                    aria-hidden
                  />
                  <span className="truncate">{run.label}</span>
                </figcaption>
              </figure>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => select(current - 1)}
            disabled={current === 0}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="前の番号"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => select(current + 1)}
            disabled={current === last}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="次の番号"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <label htmlFor={sliderId} className="sr-only">
            {title} の {unit || '番号'}
          </label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={last}
            value={current}
            disabled={last === 0}
            onChange={(event) => select(Number(event.target.value))}
            aria-valuetext={`${stepLabel} (${current + 1} / ${series.steps.length})`}
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
        </div>
      </div>
    </Card>
  )
}

/** 複数の実験の, 同じ名前と番号の画像 (エポックごとの生成画像など) を並べて比べる */
export function ImageCompare({
  series,
  runs,
  projectId,
}: {
  series: SharedImageSeries[]
  runs: RunColumn[]
  projectId: string
}) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold">画像の比較</h2>
      <div className="space-y-4">
        {series.map((item) => (
          <SharedSeriesViewer key={item.name} series={item} runs={runs} projectId={projectId} />
        ))}
      </div>
    </div>
  )
}
