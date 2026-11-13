import type { ModelParam } from '../api/client'

/** 要素数の合計 (学習するパラメータ, 学習しないパラメータ, バッファ) */
export interface ParamCounts {
  trainable: number
  frozen: number
  buffer: number
}

/** 一覧から種類ごとの要素数を求める. 共有した 2 つ目以降の名前は数えない (ML-Found と同じ) */
export function countParams(rows: ModelParam[]): ParamCounts {
  const counts: ParamCounts = { trainable: 0, frozen: 0, buffer: 0 }
  for (const row of rows) {
    if (row.same_as) continue
    if (row.kind === 'buffer') counts.buffer += row.numel
    else if (row.requires_grad) counts.trainable += row.numel
    else counts.frozen += row.numel
  }
  return counts
}

/** 名前か層のクラス名に検索語を含む行に絞る */
export function filterParams(rows: ModelParam[], query: string): ModelParam[] {
  const text = query.trim().toLowerCase()
  if (!text) return rows
  return rows.filter(
    (row) => row.name.toLowerCase().includes(text) || row.module.toLowerCase().includes(text),
  )
}
