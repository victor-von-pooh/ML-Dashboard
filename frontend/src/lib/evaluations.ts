import type { EvaluationValue, GuardCheck, RunEvaluations } from '../api/client'

// 一覧と比較に並べる評価の列の上限 (表の幅を保つため. docs/DESIGN.md の「一覧と比較の評価」)
export const MAX_LIST_COLUMNS = 3
export const MAX_COMPARE_COLUMNS = 6

// 評価の列で並べ替えるときの並べ替えの名前の頭
export const EVALUATION_SORT_PREFIX = 'ev:'

// 評価の列を 1 つも並べないことを URL に残す印 (ev= の空の値)
export const NO_COLUMNS = ''

/** テスト用の評価の 1 つの列 (全ての実験を合わせたもの) */
export interface EvaluationColumn {
  /** <評価の名前>:<列> */
  key: string
  evaluation: string
  column: string
  guard: boolean
  diff: boolean
  /** 指標の向き (実験で違う場合や分からない場合は null) */
  better: EvaluationValue['better']
  baseline: string | null
}

/** 評価の値の列の名前 (評価の名前に : は入らない) */
export function valueKey(value: Pick<EvaluationValue, 'evaluation' | 'column'>): string {
  return `${value.evaluation}:${value.column}`
}

/** 実験の評価の値を列の名前で引く */
export function findValue(
  evaluations: RunEvaluations | null | undefined,
  key: string,
): EvaluationValue | undefined {
  return evaluations?.values.find((value) => valueKey(value) === key)
}

/**
 * 全ての実験の評価の列を集める. 守る指標の表を先に, 次に評価の名前,
 * 表の列の順 (初めに出てきた順)
 */
export function collectColumns(list: (RunEvaluations | null | undefined)[]): EvaluationColumn[] {
  const columns = new Map<string, EvaluationColumn>()
  // 評価の中の列の順 (初めに出てきた位置)
  const orders = new Map<string, number>()
  for (const evaluations of list) {
    evaluations?.values.forEach((value, index) => {
      const key = valueKey(value)
      const known = columns.get(key)
      if (!known) {
        orders.set(key, index)
        columns.set(key, {
          key,
          evaluation: value.evaluation,
          column: value.column,
          guard: value.guard,
          diff: value.diff,
          better: value.better ?? null,
          baseline: value.baseline ?? null,
        })
        return
      }
      // 実験で向きが違えば分からないとする
      if (known.better !== (value.better ?? null)) known.better = null
      known.guard ||= value.guard
    })
  }
  return [...columns.values()].sort(
    (a, b) =>
      Number(b.guard) - Number(a.guard) ||
      (a.evaluation < b.evaluation ? -1 : a.evaluation > b.evaluation ? 1 : 0) ||
      (orders.get(a.key) ?? 0) - (orders.get(b.key) ?? 0),
  )
}

/**
 * 並べる列. 選んだ列 (今ある列だけ) か, 選んでいないか選んだ列が全て無くなった
 * 場合は先頭の列. 列を並べない印 (NO_COLUMNS) だけなら並べない
 */
export function chooseColumns(
  columns: EvaluationColumn[],
  requested: string[],
  limit: number,
): EvaluationColumn[] {
  if (requested.length > 0 && requested.every((key) => key === NO_COLUMNS)) return []
  const chosen = requested
    .map((key) => columns.find((column) => column.key === key))
    .filter((column): column is EvaluationColumn => column !== undefined)
  const unique = [...new Map(chosen.map((column) => [column.key, column])).values()]
  return (unique.length > 0 ? unique : columns).slice(0, limit)
}

/** 差を 0 とみなす幅 (計算の誤差で悪いとしないため) */
export const DIFF_TOLERANCE = 1e-12

/** 差の値の良し悪し. 向きが分からない値と差でない値は null */
export function diffTone(value: EvaluationValue | undefined): 'good' | 'bad' | 'same' | null {
  if (!value?.diff || value.value == null || !value.better) return null
  // 計算の誤差の幅は同じとする (バックエンドの DIFF_TOLERANCE と同じ)
  if (Math.abs(value.value) <= DIFF_TOLERANCE) return 'same'
  const better = value.better === 'lower' ? value.value < 0 : value.value > 0
  return better ? 'good' : 'bad'
}

/** 評価の列で初めに並べ替えるときの向き (良い順. 向きが分からなければ大きい順) */
export function initialDesc(column: EvaluationColumn | undefined): boolean {
  return column?.better !== 'lower'
}

/** 評価の列での並べ替え (key は <評価の名前>:<列>) */
export interface EvaluationSort {
  key: string
  desc: boolean
}

/** URL の並べ替え (sort=ev:<列>. desc=0 なら小さい順) を読む. 評価の列でなければ null */
export function readEvaluationSort(params: URLSearchParams): EvaluationSort | null {
  const value = params.get('sort') ?? ''
  if (!value.startsWith(EVALUATION_SORT_PREFIX) || value === EVALUATION_SORT_PREFIX) return null
  return { key: value.slice(EVALUATION_SORT_PREFIX.length), desc: params.get('desc') !== '0' }
}

/** 並べ替えを URL に書いた写しを返す (他の値は残す) */
export function writeEvaluationSort(
  params: URLSearchParams,
  sort: EvaluationSort,
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set('sort', `${EVALUATION_SORT_PREFIX}${sort.key}`)
  if (sort.desc) next.delete('desc')
  else next.set('desc', '0')
  return next
}

/** 評価の値による絞り込みの 1 つ (<列><比べ方><数>) */
export interface ValueFilter {
  key: string
  op: '<' | '<=' | '>' | '>='
  threshold: number
}

const FILTER_PATTERN = /^([^<>=\s]+?)(<=|>=|<|>)(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i

/**
 * 検索の語を, 評価の値による絞り込みと残りの語に分ける. 列は <評価の名前>:<列> か,
 * 1 つの評価だけにある列の名前. 列に当たらない語は文字の語のまま
 */
export function parseValueFilters(
  query: string,
  columns: EvaluationColumn[],
): { filters: ValueFilter[]; words: string[]; unresolved: string[] } {
  const filters: ValueFilter[] = []
  const words: string[] = []
  // 比べ方の形なのに列に当たらなかった語 (利用者に知らせる)
  const unresolved: string[] = []
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const match = FILTER_PATTERN.exec(word)
    const key = match ? resolveColumn(match[1]!, columns) : undefined
    if (match && key) {
      filters.push({ key, op: match[2] as ValueFilter['op'], threshold: Number(match[3]) })
    } else {
      if (match && columns.length > 0) unresolved.push(word)
      words.push(word.toLowerCase())
    }
  }
  return { filters, words, unresolved }
}

/** 絞り込みの列の名前を, 列の名前 (<評価の名前>:<列>) にする (大文字と小文字は区別しない) */
function resolveColumn(name: string, columns: EvaluationColumn[]): string | undefined {
  const lower = name.toLowerCase()
  const exact = columns.find((column) => column.key.toLowerCase() === lower)
  if (exact) return exact.key
  const same = columns.filter((column) => column.column.toLowerCase() === lower)
  return same.length === 1 ? same[0]!.key : undefined
}

/** 実験の評価の値が絞り込みに合うか. その値の無い実験は合わない */
export function matchesValueFilters(
  evaluations: RunEvaluations | null | undefined,
  filters: ValueFilter[],
): boolean {
  return filters.every(({ key, op, threshold }) => {
    const value = findValue(evaluations, key)?.value
    if (value == null) return false
    switch (op) {
      case '<':
        return value < threshold
      case '<=':
        return value <= threshold
      case '>':
        return value > threshold
      case '>=':
        return value >= threshold
    }
  })
}

// 守る指標の判定の画面の言葉
export const GUARD_LABELS: Record<GuardCheck['state'], string> = {
  dropped: '落ちた',
  kept: '保った',
  unknown: '判断できない',
}

/** 守る指標の判定の説明 (落ちた指標と判断できなかった理由) */
export function guardDetail(guard: GuardCheck): string {
  const lines = [
    ...guard.dropped.map((item) => `落ちた: ${item}`),
    ...guard.unknown.map((item) => `判断できない: ${item}`),
  ]
  return lines.length > 0
    ? lines.join('\n')
    : 'テスト用の守る指標は, 全て比べる相手より落ちていません'
}
