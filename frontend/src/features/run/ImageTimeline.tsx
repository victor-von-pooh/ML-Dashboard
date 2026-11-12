import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { runFileUrl } from '../../api/client'
import { Card } from '../../components/ui'
import type { ImageSeries } from '../../lib/images'

// 再生するときに次の画像に移るまでの時間 (ミリ秒)
const PLAY_INTERVAL = 800

/** 番号の付いた画像を, スライダーと再生で順に見る */
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
  const [index, setIndex] = useState(last)
  const [playing, setPlaying] = useState(false)
  const frame = series.frames[Math.min(index, last)]!
  // 名前の最後 (epoch, step など) を番号の単位として表示
  const unit = series.name.split('/').pop() ?? ''

  // 再生中は一定の間隔で次の画像に移り, 最後まで来たら最初から
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setIndex((current) => (current >= last ? 0 : current + 1))
    }, PLAY_INTERVAL)
    return () => window.clearInterval(timer)
  }, [playing, last])

  // 前後の画像を先に読み込み, 送ったときにちらつかないようにする
  useEffect(() => {
    for (const offset of [-1, 1]) {
      const next = series.frames[index + offset]
      if (next) new Image().src = runFileUrl(projectId, runId, next.path)
    }
  }, [index, series.frames, projectId, runId])

  const move = (step: number) => {
    setPlaying(false)
    setIndex((current) => Math.max(0, Math.min(last, current + step)))
  }

  return (
    <Card
      title={<span className="font-mono">{series.name}</span>}
      actions={
        <span className="tabular text-xs text-ink-3">
          {index + 1} / {series.frames.length}
        </span>
      }
    >
      <figure className="space-y-3">
        <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-white">
          <img
            src={runFileUrl(projectId, runId, frame.path)}
            alt={`${series.name} の ${frame.step}`}
            className="max-h-[420px] w-auto object-contain [image-rendering:pixelated]"
          />
        </div>
        <figcaption className="tabular text-center text-sm font-medium">
          {unit ? `${unit} ${frame.step}` : frame.step}
          <span className="ml-2 font-mono text-xs font-normal text-ink-3">{frame.path}</span>
        </figcaption>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={index === 0}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="前の画像"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2"
            aria-label={playing ? '止める' : '順に再生する'}
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
            onClick={() => move(1)}
            disabled={index === last}
            className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            aria-label="次の画像"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
          <label htmlFor={sliderId} className="sr-only">
            {series.name} の番号
          </label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={last}
            value={index}
            onChange={(event) => {
              setPlaying(false)
              setIndex(Number(event.target.value))
            }}
            aria-valuetext={`${frame.step} (${index + 1} / ${series.frames.length})`}
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
        </div>
        <div className="tabular flex justify-between text-[11px] text-ink-3">
          <span>{series.frames[0]?.step}</span>
          <span>{series.frames[last]?.step}</span>
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
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {series.map((item) => (
        <SeriesViewer key={item.name} series={item} projectId={projectId} runId={runId} />
      ))}
    </div>
  )
}
