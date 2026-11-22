// Scheduler の主な引数 (ML-Found の run.json の optimizers の scheduler_params) の読み方.
// 形は ML-Found の docs/FORMAT.md の「Scheduler の引数」

/** 辞書 (並びと null を除く) か */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** partial の関数の辞書 ({function, args, keywords}. function も文字か同じ辞書) か */
export function isPartial(
  value: unknown,
): value is { function: unknown; args?: unknown; keywords?: unknown } {
  return isRecord(value) && 'function' in value && ('args' in value || 'keywords' in value)
}

/** 中の Scheduler の 1 つ ({scheduler, params}) か */
export function isInnerScheduler(
  value: unknown,
): value is { scheduler: string; params: Record<string, unknown> | null } {
  return (
    isRecord(value) &&
    typeof value.scheduler === 'string' &&
    (value.params === null || isRecord(value.params))
  )
}

/** 1 つの値を文字にする. 文字 ("inf" なども) はそのまま, 関数は Python の書き方 */
export function formatParam(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isPartial(value)) {
    const args = Array.isArray(value.args) ? value.args.map(formatParam) : []
    const keywords = isRecord(value.keywords)
      ? Object.entries(value.keywords).map(([key, item]) => `${key}=${formatParam(item)}`)
      : []
    return `partial(${[formatParam(value.function), ...args, ...keywords].join(', ')})`
  }
  if (Array.isArray(value)) return `[${value.map(formatParam).join(', ')}]`
  return JSON.stringify(value)
}

/** 1 行で出せる値 (辞書の並びと, partial でない辞書は表に分ける) か */
export function isInline(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => !isRecord(item) || isPartial(item))
  return !isRecord(value) || isPartial(value)
}
