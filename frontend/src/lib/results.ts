import type { Evaluation, Sample } from '../api/client'

// ML-Found の task.yaml の値の名前 (ML-Quest の言葉) と画面の言葉
export const ROLE_LABELS: Record<string, string> = {
  predict: '予測する',
  generate: '作る',
  rank: '並べる',
  group: 'まとめる',
  effect: '効果を見積もる',
}

export const OUTPUT_LABELS: Record<string, string> = {
  class: 'クラス',
  value: '値',
  distribution: '分布',
  region: '領域',
  shape: '形',
  text: '文',
  image: '画像',
  table: '表',
  ranking: '順位',
  cluster: '群',
  effect: '効果',
}

export const METHOD_LABELS: Record<string, string> = {
  rule: '規則',
  pretrained: '既製のモデルをそのまま',
  head: '既製の特徴の上に頭だけ学習',
  partial: '一部を微調整',
  finetune: '全体を微調整',
  scratch: '一から学習',
}

export const ORIGIN_LABELS: Record<string, string> = {
  process: '今ある処理の出力',
  annotation: '人が付けた',
  measurement: '測った',
  synthetic: '作った正確な正解',
  unknown: '分からない',
}

/** 値の名前を「画面の言葉 (名前)」にする. 知らない名前はそのまま, 無ければ null */
export function labelOf(labels: Record<string, string>, value: string | null | undefined) {
  if (value == null) return null
  const label = Object.hasOwn(labels, value) ? labels[value] : undefined
  return label ? `${label} (${value})` : value
}

/** 見本のエポックの表示 (null は学習の後) */
export function sampleEpochLabel(epoch: number | null | undefined): string {
  return epoch == null ? '学習の後' : `エポック ${epoch}`
}

/** 1 つの名前の見本. エポックの順で, 学習の後 (null) は最後 */
export interface SampleGroup {
  name: string
  entries: Sample[]
}

/** 見本を名前ごとにまとめる. 名前は最初に書いた順, 中はエポックの順 */
export function groupSamples(samples: Sample[]): SampleGroup[] {
  const groups = new Map<string, Sample[]>()
  for (const sample of samples) {
    const entries = groups.get(sample.name) ?? []
    // 同じ名前とエポックが 2 つある場合 (一覧の書き換えの途中など) は後の項目
    const same = entries.findIndex((item) => (item.epoch ?? null) === (sample.epoch ?? null))
    if (same >= 0) entries.splice(same, 1)
    entries.push(sample)
    groups.set(sample.name, entries)
  }
  return [...groups.entries()].map(([name, entries]) => ({
    name,
    entries: entries.sort(
      (a, b) => (a.epoch ?? Number.POSITIVE_INFINITY) - (b.epoch ?? Number.POSITIVE_INFINITY),
    ),
  }))
}

/** 曲線の縦軸の系列. 数の値を持つ列 (x の列を除く) だけ */
export interface CurveSeries {
  column: string
  points: [number, number | null][]
}

/** 評価の曲線を, x の列を横軸にした系列にする. x が数でない行は除き, x の順に並べる */
export function curveSeries(evaluation: Evaluation): CurveSeries[] {
  const x = evaluation.x
  if (evaluation.kind !== 'curve' || !x) return []
  const rows = evaluation.rows
    .filter((row) => typeof row[x] === 'number')
    .sort((a, b) => (a[x] as number) - (b[x] as number))
  return evaluation.columns
    .filter((column) => column !== x && rows.some((row) => typeof row[column] === 'number'))
    .map((column) => ({
      column,
      points: rows.map((row): [number, number | null] => {
        const value = row[column]
        return [row[x] as number, typeof value === 'number' ? value : null]
      }),
    }))
}

/** 値が全て数 (null を除く. 1 つ以上) の列. 表で右に寄せる */
export function numericColumns(evaluation: Evaluation): Set<string> {
  return new Set(
    evaluation.columns.filter((column) => {
      const values = evaluation.rows.map((row) => row[column]).filter((value) => value != null)
      return values.length > 0 && values.every((value) => typeof value === 'number')
    }),
  )
}

/** 評価の表の値の表示 */
export function formatCell(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value)
    const abs = Math.abs(value)
    return abs !== 0 && (abs < 1e-3 || abs >= 1e6) ? value.toExponential(3) : value.toPrecision(4)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** 点群の点 (x, y, z) */
export type Point3 = [number, number, number]

/**
 * ascii の PLY から頂点の x, y, z を読む. バイナリの PLY と形の違うファイルは null.
 * 点が maxPoints より多い場合は等間隔に間引く
 */
export function parseAsciiPly(text: string, maxPoints = 20000): Point3[] | null {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== 'ply') return null
  let format = ''
  let vertices = -1
  let inVertex = false
  const properties: string[] = []
  let headerEnd = -1
  for (let index = 1; index < lines.length; index += 1) {
    const words = (lines[index] ?? '').trim().split(/\s+/)
    if (words[0] === 'format') format = words[1] ?? ''
    else if (words[0] === 'element') {
      inVertex = words[1] === 'vertex'
      if (inVertex) vertices = Number(words[2])
      else if (vertices < 0) return null
    } else if (words[0] === 'property' && inVertex) {
      // list の性質 (property list ...) は頂点には無い前提
      properties.push(words[words.length - 1] ?? '')
    } else if (words[0] === 'end_header') {
      headerEnd = index
      break
    }
  }
  const columns = ['x', 'y', 'z'].map((name) => properties.indexOf(name))
  if (format !== 'ascii' || headerEnd < 0 || !(vertices > 0) || columns.some((i) => i < 0)) {
    return null
  }

  // 頂点の要素は先頭にある前提 (ML-Found の書く形と多くの道具の形)
  const step = Math.max(1, Math.ceil(vertices / maxPoints))
  const points: Point3[] = []
  for (let index = 0; index < vertices; index += step) {
    const words = (lines[headerEnd + 1 + index] ?? '').trim().split(/\s+/)
    const point = columns.map((column) => Number(words[column])) as Point3
    if (point.every(Number.isFinite)) points.push(point)
  }
  return points.length > 0 ? points : null
}
