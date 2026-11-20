import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { runFileUrl, type Sample } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { cssVar } from '../../lib/colors'
import { formatBytes } from '../../lib/format'
import { useTheme } from '../../lib/themeContext'
import {
  groupSamples,
  parseAsciiPly,
  sampleEpochLabel,
  type Point3,
  type SampleGroup,
} from '../../lib/results'

// 文の見本で読む大きさの上限と, 出す文字数
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 20000

// 点群を上から見た図にする大きさの上限と, 描く点の数
const MAX_CLOUD_BYTES = 20 * 1024 * 1024
const MAX_CLOUD_POINTS = 20000

/** 実験のファイルを文字で読む */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`読めませんでした (${response.status})`)
  return response.text()
}

function DownloadLink({ url, sample }: { url: string; sample: Sample }) {
  const file = sample.path.slice(sample.path.lastIndexOf('/') + 1)
  return (
    <a
      href={url}
      download={file}
      className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline"
    >
      <Download className="size-4" aria-hidden />
      {file} をダウンロード ({formatBytes(sample.size)})
    </a>
  )
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
  if (text.error) return <ErrorBox error={text.error} />
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

function PointCloudSample({ url, sample }: { url: string; sample: Sample }) {
  const drawable = sample.path.toLowerCase().endsWith('.ply') && sample.size <= MAX_CLOUD_BYTES
  const text = useQuery({
    queryKey: ['sample-text', url, sample.size, sample.created_at],
    queryFn: () => fetchText(url),
    enabled: drawable,
    staleTime: Infinity,
  })
  const cloud = useMemo(
    () => (text.data ? parseAsciiPly(text.data, MAX_CLOUD_POINTS) : null),
    [text.data],
  )
  return (
    <div className="space-y-2">
      {drawable && text.data === undefined && !text.error && <Spinner />}
      {text.error && <p className="text-xs text-ink-3">点群を読めなかったので図にしていません</p>}
      {cloud ? (
        <figure className="space-y-1">
          <CloudView points={cloud.points} label={`${sample.name} の点群を上から見た図`} />
          <figcaption className="text-xs text-ink-3">
            上から見た図 (x を横, y を縦.{' '}
            {cloud.vertices > cloud.points.length
              ? `${cloud.vertices.toLocaleString()} 点を ${cloud.points.length.toLocaleString()} 点に間引いて描画`
              : `${cloud.points.length.toLocaleString()} 点`}
            )
          </figcaption>
        </figure>
      ) : (
        text.data !== undefined && (
          <p className="text-xs text-ink-3">
            ascii の PLY ではないので図にしていません. ダウンロードして点群の道具で開いてください
          </p>
        )
      )}
      <DownloadLink url={url} sample={sample} />
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
  const url = runFileUrl(projectId, runId, sample.path)
  const label = `${sample.name} の${sampleEpochLabel(sample.epoch)}`
  switch (sample.kind) {
    case 'image':
      return (
        <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
          <img
            src={url}
            alt={label}
            className="h-auto max-h-[480px] w-full object-contain [image-rendering:pixelated]"
          />
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
      return <PointCloudSample url={url} sample={sample} />
    default:
      return <DownloadLink url={url} sample={sample} />
  }
}

/** 1 つの名前の見本. エポックを選んで見る (開いたときは最後の見本) */
function SampleCard({
  group,
  projectId,
  runId,
}: {
  group: SampleGroup
  projectId: string
  runId: string
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
      <figure className="space-y-2">
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
    </Card>
  )
}

/** 見本の出力 (ML-Found の samples/index.json). 名前ごとにまとめる */
export function SamplesTab({
  samples,
  projectId,
  runId,
}: {
  samples: Sample[]
  projectId: string
  runId: string
}) {
  const groups = useMemo(() => groupSamples(samples), [samples])
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <SampleCard key={group.name} group={group} projectId={projectId} runId={runId} />
        ))}
      </div>
      <p className="text-xs text-ink-3">
        画像の見本のエポックごとの推移は「画像の推移」のタブでも見られます. samples/
        の直下の番号付きの画像 (samples/epoch_010.png など) は「画像の推移」のタブにあります.
      </p>
    </div>
  )
}
