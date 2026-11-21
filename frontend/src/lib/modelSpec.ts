import type { RunModelSpec } from '../api/client'

// モデルの定義の写しの記録 (ML-Found の source.yaml の model_spec) の状態の言葉
const STATUS_LABELS: Record<string, string> = {
  copied: '写した',
  missing: 'ファイルが無いので写していない',
  outside: 'プロジェクトの外なので写していない',
  link: 'シンボリックリンクなので写していない',
  not_file: '普通のファイルでないので写していない',
  unreadable: '読めないので写していない',
  too_large: '16 MiB を超えるので写していない',
  invalid: '場所として読めないので写していない',
  write_failed: '写しを書けなかった',
}

/** 写したかの言葉. 写した場合は写しのファイルと sha256 の先頭を添える */
export function modelSpecStatus(spec: RunModelSpec): string {
  const status = spec.status ?? null
  if (status === 'copied') {
    const sha = spec.sha256 ? `, sha256 ${spec.sha256.slice(0, 12)}` : ''
    return `写した (model_spec.yaml${sha})`
  }
  const label = status && Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : undefined
  if (label) return label
  // 知らない値は写していないものとして読む (ML-Found の約束)
  if (status) return `写していない (${status})`
  return '写したか分からない'
}

/** 起動のしかたの行に出す「場所 (写したか)」の文 */
export function describeModelSpec(spec: RunModelSpec): string {
  return `${spec.path ?? '場所が分からない'} (${modelSpecStatus(spec)})`
}
