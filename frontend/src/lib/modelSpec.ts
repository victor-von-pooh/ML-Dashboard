import type { RunModelSpec } from '../api/client'

// モデルの定義を写さなかった理由 (ML-Found の source.yaml の model_spec の status).
// 起動し直すときのお知らせ (バックエンドの MODEL_SPEC_REASONS) と同じ言葉
const STATUS_REASONS: Record<string, string> = {
  missing: '定義のファイルが無い',
  outside: '定義がプロジェクトの外にある',
  link: '定義の場所がシンボリックリンク',
  not_file: '定義が普通のファイルでない',
  unreadable: '定義を読めない',
  too_large: '定義が 16 MiB を超える',
  invalid: '定義の場所を読めない',
  write_failed: '写しを書けなかった',
}

/** 写したかの言葉. 写した場合は写しのファイルと sha256 の先頭を添える */
export function modelSpecStatus(spec: RunModelSpec): string {
  const status = spec.status ?? null
  if (status === 'copied') {
    const sha = spec.sha256 ? `, sha256 ${spec.sha256.slice(0, 12)}` : ''
    return `写した: model_spec.yaml${sha}`
  }
  // 知らない値は写していないものとして値のまま出す (ML-Found の約束)
  if (status) {
    const reason = Object.hasOwn(STATUS_REASONS, status) ? STATUS_REASONS[status] : undefined
    return `写していない: ${reason ?? status}`
  }
  return '写したか分からない'
}

/** 起動のしかたの行に出す「場所 (写したか)」の文 */
export function describeModelSpec(spec: RunModelSpec): string {
  return `${spec.path ?? '場所が分からない'} (${modelSpecStatus(spec)})`
}
