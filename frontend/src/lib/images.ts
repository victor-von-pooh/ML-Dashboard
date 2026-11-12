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
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
    const match = NUMBERED.exec(file.path.slice(slash + 1))
    if (!match) continue
    const name = `${dir}${(match[1] ?? '').replace(/[_-]$/, '')}` || dir.replace(/\/$/, '')
    groups.set(name, [...(groups.get(name) ?? []), { path: file.path, step: Number(match[2]) }])
  }
  return [...groups.entries()]
    .filter(([, frames]) => frames.length >= 2)
    .map(([name, frames]) => ({ name, frames: frames.sort((a, b) => a.step - b.step) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
