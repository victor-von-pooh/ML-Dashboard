import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { runFileUrl } from '../../api/client'
import { Card } from '../../components/ui'
import type { ImageSeries } from '../../lib/images'

// 再生するときに次の画像に移るまでの時間 (ミリ秒)
const PLAY_INTERVAL = 800

/** 並びの名前を, 表示する題名 (ディレクトリ) と番号の単位 (epoch など) に分ける */
function splitName(name: string): { title: string; unit: string } {
  const slash = name.lastIndexOf('/')
  if (slash < 0) return { title: name, unit: '' }
  return { title: name.slice(0, slash), unit: name.slice(slash + 1) }
}

/** 番号の付いた画像を, スライダー, 縮小画像の帯, 再生で順に見る */
function SeriesViewer({
  series,
  projectId,
  runId,
}: {
  series: ImageSeries
  projectId: string
  runId: string
}) {
  const sliderId = useId()
  const last = series.frames.length - 1
  // null は最新の画像を表示 (学習中に画像が増えたら最新に追従)
  const [index, setIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const current = index === null ? last : Math.min(index, last)
  const frame = series.frames[current]!
  const { title, unit } = splitName(series.name)
  const stepLabel = (step: number) => (unit ? `${unit} ${step}` : String(step))

  // 再生中は一定の間隔で次の画像に移り, 最後まで来たら最初から
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setIndex((value) => {
        const position = value ?? last
        return position >= last ? 0 : position + 1
      })
    }, PLAY_INTERVAL)
    return () => window.clearInterval(timer)
  }, [playing, last])

  const select = (next: number) => {
    setPlaying(false)
    const clamped = Math.max(0, Math.min(last, next))
    setIndex(clamped === last ? null : clamped)
  }

  // 最後の画像で再生を押した場合は最初から再生
  const togglePlay = () => {
    if (!playing && current === last) setIndex(0)
    setPlaying((value) => !value)
  }

  return (
    <Card
      title={<span className="font-mono">{title}</span>}
      actions={
        <span className="tabular text-sm font-semibold text-ink">{stepLabel(frame.step)}</span>
      }
    >
      <figure className="space-y-3">
        <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
          <img
            src={runFileUrl(projectId, runId, frame.path)}
            alt={`${title} の ${stepLabel(frame.step)}`}
            className="h-auto max-h-[480px] w-full object-contain [image-rendering:pixelated]"
          />
        </div>
        <figcaption className="truncate text-center font-mono text-xs text-ink-3">
          {frame.path}
        </figcaption>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => select(current - 1)}
            disabled={current === 0}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="前の画像"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2"
            aria-label="順に再生"
            aria-pressed={playing}
          >
            {playing ? (
              <Pause className="size-4" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => select(current + 1)}
            disabled={current === last}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="次の画像"
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
            onChange={(event) => select(Number(event.target.value))}
            aria-valuetext={`${stepLabel(frame.step)} (${current + 1} / ${series.frames.length})`}
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
        </div>

        {/* 保存された全ての番号を縮小画像で並べ, どの番号があるかと最初との違いを見やすくする */}
        <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label="保存された画像">
          {series.frames.map((item, position) => (
            <button
              key={item.path}
              type="button"
              role="listitem"
              onClick={() => select(position)}
              aria-current={position === current}
              className={clsx(
                'shrink-0 overflow-hidden rounded-md border-2 bg-surface-2 text-center',
                position === current ? 'border-accent' : 'border-transparent hover:border-line',
              )}
            >
              <img
                src={runFileUrl(projectId, runId, item.path)}
                alt=""
                loading="lazy"
                className="h-14 w-auto object-contain [image-rendering:pixelated]"
              />
              <span className="tabular block px-1 text-[11px] text-ink-2">{item.step}</span>
            </button>
          ))}
        </div>
      </figure>
    </Card>
  )
}

/** 実験の中の番号付きの画像 (エポックごとの生成画像など) の推移 */
export function ImageTimeline({
  series,
  projectId,
  runId,
}: {
  series: ImageSeries[]
  projectId: string
  runId: string
}) {
  return (
    <div className="space-y-3">
      <div
        className={clsx(
          'grid grid-cols-1 items-start gap-4',
          series.length > 1 && 'lg:grid-cols-2',
        )}
      >
        {series.map((item) => (
          <SeriesViewer key={item.name} series={item} projectId={projectId} runId={runId} />
        ))}
      </div>
      <p className="text-xs text-ink-3">
        番号の付いた画像 (例: samples/epoch_010.png) だけを並べています. best.png
        のような番号の無い画像はファイルのタブにあります.
      </p>
    </div>
  )
}
