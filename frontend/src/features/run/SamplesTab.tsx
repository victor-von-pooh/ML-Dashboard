import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Info } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { useApi, type History, type Sample, type SampleClass } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { cssVar } from '../../lib/colors'
import { isCsvSample } from '../../lib/csv'
import { indexHistory } from '../../lib/epochMetrics'
import { useTheme } from '../../lib/themeContext'
import {
  axisLabel,
  className,
  groupSamples,
  sampleEpochLabel,
  type Point3,
  type SampleGroup,
} from '../../lib/results'
import { CsvCompare, CsvSample, DownloadLink } from './CsvSample'
import { EpochMetrics, type EpochMetricsSource } from './EpochMetrics'

// 文の見本で読む大きさの上限と, 出す文字数
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 20000

// 点群を上から見た図にする大きさの上限 (バックエンドの上限と同じ)
const MAX_CLOUD_BYTES = 20 * 1024 * 1024

/** 実験のファイルを文字で読む */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`読めませんでした (${response.status})`)
  return response.text()
}

function TextSample({ url, sample }: { url: string; sample: Sample }) {
  const large = sample.size > MAX_TEXT_BYTES
  const text = useQuery({
    queryKey: ['sample-text', url, sample.size, sample.created_at],
    queryFn: () => fetchText(url),
    enabled: !large,
    staleTime: Infinity,
  })
  if (large) return <DownloadLink url={url} sample={sample} />
  if (text.error) return <ErrorBox error={text.error} live={false} />
  if (text.data === undefined) return <Spinner />
  const cut = text.data.length > MAX_TEXT_CHARS
  return (
    <div className="space-y-1">
      <pre className="max-h-[420px] overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-sm whitespace-pre-wrap text-ink">
        {cut ? text.data.slice(0, MAX_TEXT_CHARS) : text.data}
      </pre>
      {cut && (
        <p className="text-xs text-ink-3">
          先頭の {MAX_TEXT_CHARS.toLocaleString()} 文字だけを出しています.{' '}
          <DownloadLink url={url} sample={sample} />
        </p>
      )}
    </div>
  )
}

/** 点群を上から (z の軸の向きに) 見た図. 点の位置を x, y で描く */
function CloudView({ points, label }: { points: Point3[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { theme } = useTheme()
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const size = canvas.width
    const margin = 8
    const xs = points.map((point) => point[0])
    const ys = points.map((point) => point[1])
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    // 縦横の比を保つため, 広い方の幅に合わせる
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1
    const scale = (size - 2 * margin) / span
    context.clearRect(0, 0, size, size)
    context.fillStyle = cssVar('--series-1')
    for (const [x, y] of points) {
      // 画面の縦は下向きなので y を反転
      context.fillRect(
        margin + (x - minX) * scale - 1,
        size - margin - (y - minY) * scale - 1,
        2,
        2,
      )
    }
  }, [points, theme])
  return (
    <canvas
      ref={ref}
      width={360}
      height={360}
      role="img"
      aria-label={label}
      className="h-auto w-full max-w-[360px] rounded-lg border border-line bg-surface-2"
    />
  )
}

/** 点群の座標の選び (元の座標か, ファイルのままの正規化した座標) */
type CloudCoordinates = 'original' | 'normalized'

const COORDINATE_LABELS: Record<CloudCoordinates, string> = {
  original: '元の座標',
  normalized: '正規化した座標',
}

function PointCloudSample({
  url,
  sample,
  projectId,
  runId,
}: {
  url: string
  sample: Sample
  projectId: string
  runId: string
}) {
  const api = useApi()
  const drawable = sample.path.toLowerCase().endsWith('.ply') && sample.size <= MAX_CLOUD_BYTES
  // 点の読み込みと元の座標への戻しはバックエンド (ML-Found の original_coordinates)
  const cloud = useQuery({
    queryKey: ['sample-cloud', projectId, runId, sample.path, sample.size, sample.created_at],
    queryFn: () => api.getSampleCloud(projectId, runId, sample.path),
    enabled: drawable,
    staleTime: Infinity,
    retry: false,
  })
  const [coordinates, setCoordinates] = useState<CloudCoordinates>('original')
  const data = cloud.data
  const original = data?.original ?? null
  // 元の座標があれば選べ, 無ければファイルのままの座標だけ
  const shown = original && coordinates === 'original' ? original : (data?.points ?? null)
  const viewing: CloudCoordinates | null = original ? coordinates : null
  // 単位は元の座標か, 正規化していない (scale も shift も無い) 点群の座標に添える
  const units = viewing === 'normalized' ? null : (data?.units ?? null)
  const toggleLabel = `${sample.name} の点群の座標`
  return (
    <div className="space-y-2">
      {drawable && cloud.isPending && <Spinner />}
      {cloud.error && (
        <p className="text-xs text-ink-3">点群を図にしていません: {cloud.error.message}</p>
      )}
      {data?.reason && (
        <p className="flex items-start gap-1 text-xs text-ink-2">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {data.reason}
        </p>
      )}
      {original && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={toggleLabel}>
          {(['original', 'normalized'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setCoordinates(item)}
              aria-pressed={coordinates === item}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                coordinates === item
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line text-ink-2 hover:bg-surface-2',
              )}
            >
              {COORDINATE_LABELS[item]}
            </button>
          ))}
        </div>
      )}
      {data && shown && (
        <figure className="space-y-1">
          <CloudView
            points={shown as Point3[]}
            label={`${sample.name} の点群を上から見た図${viewing ? ` (${COORDINATE_LABELS[viewing]})` : ''}`}
          />
          <figcaption className="text-xs text-ink-3">
            上から見た図 ({axisLabel('x', units)} を横, {axisLabel('y', units)} を縦.{' '}
            {viewing && `${COORDINATE_LABELS[viewing]}. `}
            {data.vertices > shown.length
              ? `${data.vertices.toLocaleString()} 点を ${shown.length.toLocaleString()} 点に間引いて描画`
              : `${shown.length.toLocaleString()} 点`}
            )
          </figcaption>
        </figure>
      )}
      <DownloadLink url={url} sample={sample} />
    </div>
  )
}

/** 領域の見本の凡例 (番号, 名前, 色). 色は PNG の色そのもの */
function MaskLegend({ classes, label }: { classes: SampleClass[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {classes.map((row) => (
        <li key={row.id} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm border border-line"
            style={{ backgroundColor: row.color }}
          />
          <span className="tabular-nums font-mono text-ink-3">{row.id}</span>
          <span className={row.name ? 'text-ink' : 'text-ink-3'}>{className(row.name)}</span>
          <span className="font-mono text-ink-3">{row.color}</span>
        </li>
      ))}
    </ul>
  )
}

function ImageView({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
      <img
        src={url}
        alt={label}
        className="h-auto max-h-[480px] w-full object-contain [image-rendering:pixelated]"
      />
    </div>
  )
}

function SampleContent({
  sample,
  projectId,
  runId,
}: {
  sample: Sample
  projectId: string
  runId: string
}) {
  const { runFileUrl } = useApi()
  const url = runFileUrl(projectId, runId, sample.path)
  const label = `${sample.name} の${sampleEpochLabel(sample.epoch)}`
  // CSV のファイル (表を作る課題の作った表と本物の表など) は表で見る
  if (isCsvSample(sample)) return <CsvSample url={url} sample={sample} label={`${label} (表)`} />
  switch (sample.kind) {
    case 'image':
      return <ImageView url={url} label={label} />
    case 'mask':
      // 番号の表が無い見本は絵だけ
      return (
        <div className="space-y-2">
          <ImageView url={url} label={`${label} (領域を色分けした絵)`} />
          {sample.classes && sample.classes.length > 0 && (
            <MaskLegend classes={sample.classes} label={`${sample.name} の領域の凡例`} />
          )}
        </div>
      )
    case 'text':
      return <TextSample url={url} sample={sample} />
    case 'audio':
      return (
        <div className="space-y-2">
          <audio controls preload="metadata" src={url} aria-label={label} className="w-full" />
          <DownloadLink url={url} sample={sample} />
        </div>
      )
    case 'point_cloud':
      return <PointCloudSample url={url} sample={sample} projectId={projectId} runId={runId} />
    default:
      return <DownloadLink url={url} sample={sample} />
  }
}

/** 1 つの名前の見本. エポックを選んで見る (開いたときは最後の見本) */
function SampleCard({
  group,
  projectId,
  runId,
  metrics,
}: {
  group: SampleGroup
  projectId: string
  runId: string
  metrics: EpochMetricsSource
}) {
  const selectId = useId()
  const last = group.entries.length - 1
  // 選んだ見本はパスで持つ (null は最後の見本. 学習中に見本が増えたら追従).
  // 選んだ見本が一覧から消えた場合も最後の見本
  const [selected, setSelected] = useState<string | null>(null)
  const found = group.entries.findIndex((entry) => entry.path === selected)
  const current = found >= 0 ? found : last
  const sample = group.entries[current]!
  return (
    <Card
      landmark={false}
      title={<span className="font-mono">{group.name}</span>}
      actions={
        group.entries.length > 1 ? (
          <>
            <label htmlFor={selectId} className="text-xs text-ink-3">
              エポック
            </label>
            <select
              id={selectId}
              value={current}
              onChange={(event) => {
                const next = Number(event.target.value)
                setSelected(next === last ? null : (group.entries[next]?.path ?? null))
              }}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
            >
              {group.entries.map((entry, position) => (
                <option key={entry.path} value={position}>
                  {sampleEpochLabel(entry.epoch)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-sm text-ink-2">{sampleEpochLabel(sample.epoch)}</span>
        )
      }
    >
      {/* 見本と同じエポックの評価は, カードが広ければ見本の横, 狭ければ下に並べる */}
      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-4 @lg:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
          <figure className="min-w-0 space-y-2">
            <SampleContent sample={sample} projectId={projectId} runId={runId} />
            <figcaption className="space-y-0.5 text-xs">
              {sample.caption && <p className="text-sm text-ink">{sample.caption}</p>}
              <p className="text-ink-3">
                分割 <span className="font-mono text-ink-2">{sample.split ?? '—'}</span>
                {' · '}
                <span className="font-mono">{sample.path}</span>
              </p>
            </figcaption>
          </figure>
          <EpochMetrics name={group.name} epoch={sample.epoch} {...metrics} />
        </div>
      </div>
    </Card>
  )
}

/** 見本の出力 (ML-Found の samples/index.json). 名前ごとにまとめる */
export function SamplesTab({
  samples,
  projectId,
  runId,
  history,
  historyFailed,
  best,
  validInterval = 1,
}: {
  samples: Sample[]
  projectId: string
  runId: string
  history?: History
} & Partial<Omit<EpochMetricsSource, 'index'>>) {
  const metrics = useMemo(
    () => ({
      // 行の引き方と列ごとの最も良い値は, 見本のカードごとでなく 1 回だけ作る
      index: history ? indexHistory(history, best) : undefined,
      historyFailed,
      best,
      validInterval,
    }),
    [history, historyFailed, best, validInterval],
  )
  const groups = useMemo(() => groupSamples(samples), [samples])
  // 最後の見本が CSV の名前 (2 つ以上あれば並べて見られる)
  const tables = useMemo(
    () => groups.filter((group) => isCsvSample(group.entries.at(-1)!)),
    [groups],
  )
  return (
    <div className="space-y-3">
      {tables.length >= 2 && <CsvCompare groups={tables} projectId={projectId} runId={runId} />}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <SampleCard
            key={group.name}
            group={group}
            projectId={projectId}
            runId={runId}
            metrics={metrics}
          />
        ))}
      </div>
      <p className="text-xs text-ink-3">
        画像の見本のエポックごとの推移は「画像の推移」のタブでも見られます. samples/
        の直下の番号付きの画像 (samples/epoch_010.png など) は「画像の推移」のタブにあります.
      </p>
    </div>
  )
}
