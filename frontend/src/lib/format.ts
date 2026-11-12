/** 秒数を「1 時間 2 分」「3.4 秒」のように表す */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} 秒`
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours} 時間 ${minutes} 分`
  return `${minutes} 分 ${secs} 秒`
}

/** 指標の値を桁に合わせて表す */
export function formatMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(3)
  if (abs >= 100) return value.toFixed(1)
  return value.toPrecision(4).replace(/\.?0+$/, '')
}

/** ISO 8601 の日時を「2026-11-08 22:00:01」の形にする */
export function formatDateTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

/** 日時が今からどれだけ前かを表す */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diff = (now.getTime() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'たった今'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 時間前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 日前`
  return formatDateTime(iso).slice(0, 10)
}

/** バイト数を KB, MB などで表す */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`
}

/** config の値を 1 行の文字列で表す */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
