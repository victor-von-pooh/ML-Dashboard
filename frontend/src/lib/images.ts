import type { RunFile } from '../api/client'

/** エポックなどの番号が付いた画像の並び (例: samples/epoch_010.png) */
export interface ImageSeries {
  /** 並びの名前 (例: samples/epoch) */
  name: string
  frames: { path: string; step: number }[]
}

// ファイル名の末尾の番号 (epoch_010.png, step-200.jpg, 0005.png など)
const NUMBERED = /^(.*?)(\d+)\.(png|jpe?g|gif|webp)$/i

/** 番号の付いた画像を, 同じディレクトリと名前の並びごとにまとめる. 2 枚以上の並びだけを返す */
export function groupImageSeries(files: RunFile[]): ImageSeries[] {
  const groups = new Map<string, { path: string; step: number }[]>()
  for (const file of files) {
    if (file.kind !== 'image') continue
    const slash = file.path.lastIndexOf('/')
    const dir = slash >= 0 ? file.path.slice(0, slash) : ''
    const match = NUMBERED.exec(file.path.slice(slash + 1))
    if (!match) continue

    // 名前は「ディレクトリ/番号の前の部分」. 番号だけのファイルはディレクトリの名前
    const prefix = (match[1] ?? '').replace(/[_.-]+$/, '')
    const name = prefix ? (dir ? `${dir}/${prefix}` : prefix) : dir || '(画像)'
    const frames = groups.get(name) ?? []
    frames.push({ path: file.path, step: Number(match[2]) })
    groups.set(name, frames)
  }
  return [...groups.entries()]
    .filter(([, frames]) => frames.length >= 2)
    .map(([name, frames]) => ({ name, frames: frames.sort((a, b) => a.step - b.step) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 複数の実験で同じ名前の画像の並び. 番号ごとに, 実験ごとの画像の場所を持つ */
export interface SharedImageSeries {
  name: string
  /** いずれかの実験にある番号 (小さい順) */
  steps: number[]
  /** 実験ごとの「番号 → 画像の場所」. その並びが無い実験は null */
  frames: (Map<number, string> | null)[]
}

/** 実験ごとの画像の並びから, 2 つ以上の実験にある並びを取り出し, 番号をそろえる */
export function sharedImageSeries(perRun: ImageSeries[][]): SharedImageSeries[] {
  const names = new Map<string, number>()
  for (const runSeries of perRun) {
    for (const series of runSeries) names.set(series.name, (names.get(series.name) ?? 0) + 1)
  }
  return [...names.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const frames = perRun.map((runSeries) => {
        const series = runSeries.find((item) => item.name === name)
        return series ? new Map(series.frames.map((frame) => [frame.step, frame.path])) : null
      })
      const steps = [...new Set(frames.flatMap((map) => (map ? [...map.keys()] : [])))].sort(
        (a, b) => a - b,
      )
      return { name, steps, frames }
    })
}
