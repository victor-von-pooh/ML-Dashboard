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
  action: '行動',
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
  environment: '環境の報酬',
  self: '学んだデータそのもの',
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

/**
 * 割合を % の文字にする (0.3 は 30 %. 既定は小数第 1 位まで). signed では 0 より大きい
 * 値に + を付ける (値段を変える割合の候補の +5 % など)
 */
export function formatPercent(
  value: number,
  { digits = 1, signed = false }: { digits?: number; signed?: boolean } = {},
): string {
  // -0 を 0 にする (丸めた後の -0.0 を「-0 %」と書かないため)
  const rounded = Number((value * 100).toFixed(digits)) || 0
  return `${signed && rounded > 0 ? '+' : ''}${rounded} %`
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

/** 領域の見本の凡例の名前 (名前の無い番号は「名前なし」) */
export function className(name: string | null | undefined): string {
  return name ?? '名前なし'
}

/** 点群の図の軸の名前 (単位があれば添える) */
export function axisLabel(axis: string, units: string | null | undefined): string {
  return units ? `${axis} (${units})` : axis
}
