import { isMap, parseDocument } from 'yaml'

/** experiment の config の中身に, 点区切りの項目の値を書き込む (コメントは残す) */
export function setYamlValue(text: string, key: string, value: unknown): string {
  const document = parseDocument(text)
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message)

  // 空の文書や中身が辞書でない場合と, {} のような 1 行の辞書は, 複数行の辞書として作り直す
  if (!isMap(document.contents) || document.contents.items.length === 0) {
    document.contents = document.createNode({}) as never
  }
  const path = key.split('.')
  document.setIn(path, value)
  // params: {} のような 1 行の辞書に書き足した場合も, 複数行の辞書で書く
  for (let depth = 1; depth <= path.length; depth += 1) {
    const node = document.getIn(path.slice(0, depth), true)
    if (isMap(node) && node.items.length > 0) node.flow = false
  }
  return document.toString()
}

/** 点区切りの項目を消す. 消した結果, 空になった親の辞書も消す */
export function deleteYamlValue(text: string, key: string): string {
  const document = parseDocument(text)
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message)
  const path = key.split('.')
  document.deleteIn(path)
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parent = document.getIn(path.slice(0, depth))
    if (isMap(parent) && parent.items.length === 0) document.deleteIn(path.slice(0, depth))
  }
  return document.toString()
}

/** 入力欄の文字を, 引数の種類に合わせた値に変える. 変えられない場合は undefined */
export function parseInput(kind: string, raw: string): unknown {
  const text = raw.trim()
  if (kind === 'bool') return text === 'true'
  if (text === '') return undefined
  // int と float は同じ規則で数として読み, 整数かどうかは checkParamValue で確認
  // (種類は ML-Found の登録簿が型の注釈から決めるので, weight_decay = 0 なども float)
  if (kind === 'int' || kind === 'float') {
    // auto は ML-Found が学習を始めるときに補う値 (書ける引数は ML-Found が確認)
    if (text === 'auto') return text
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) ? Number(text) : undefined
  }
  if (kind === 'str') return text
  if (text === 'null') return null
  // 配列は JSON の配列だけを受け付け
  if (kind === 'list') {
    try {
      const parsed: unknown = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  // 配列や必須の引数などは JSON か数値として読み, 読めなければ文字列
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 値を入力欄に出す文字にする */
export function formatInput(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** 範囲を持つ引数の仕様 (ML-Found の登録簿の一部) */
interface RangeSpec {
  kind: string
  minimum?: number | null
  maximum?: number | null
  exclusive_minimum?: boolean
  exclusive_maximum?: boolean
}

/**
 * 引数の範囲の説明 (「0 以上 1 未満」「0 より大きく 1 以下」など). 範囲が無ければ空文字.
 * ML-Found の範囲のエラーの文と同じ言い方
 */
export function describeRange(spec: RangeSpec): string {
  const hasMaximum = spec.maximum != null
  // 端を含まない下限は, 上限が続く場合だけ「より大きく」とつなげる
  const lower = spec.exclusive_minimum ? (hasMaximum ? 'より大きく' : 'より大きい') : '以上'
  return [
    spec.minimum != null ? `${spec.minimum} ${lower}` : '',
    hasMaximum ? `${spec.maximum} ${spec.exclusive_maximum ? '未満' : '以下'}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** 引数の値の範囲と整数かどうか. 外れている場合は理由, 問題が無ければ null */
export function checkParamValue(spec: RangeSpec, value: unknown): string | null {
  // 数と, 数の配列 (min_lr などはグループごとに指定可能) の各要素を確かめる
  const numbers = Array.isArray(value) ? value : [value]
  const hasRange = spec.minimum != null || spec.maximum != null
  for (const item of numbers) {
    // 範囲を持つ引数は, ML-Found と同じく数でなければ誤り
    // (補間と ??? と auto は ML-Found が解決や補ってから確かめるので対象外,
    // 配列でない null は値なし)
    if (typeof item !== 'number') {
      const deferred =
        typeof item === 'string' && (item.startsWith('${') || item === '???' || item === 'auto')
      const empty = item == null && !Array.isArray(value)
      if (hasRange && spec.kind !== 'str' && !deferred && !empty) return '数で書いてください'
      continue
    }
    if (spec.kind === 'int' && !Number.isInteger(item)) return '整数にしてください'
    // 無限大と NaN は, 範囲を持つ引数では範囲の外 (ML-Found と同じ扱い)
    const belowMinimum =
      (hasRange && !Number.isFinite(item)) ||
      (spec.minimum != null &&
        (spec.exclusive_minimum ? item <= spec.minimum : item < spec.minimum))
    const aboveMaximum =
      spec.maximum != null && (spec.exclusive_maximum ? item >= spec.maximum : item > spec.maximum)
    if (belowMinimum || aboveMaximum) {
      const range = describeRange(spec)
      // 「より大きい」で終わる場合は, そのまま「値」につなげる
      return `${range}${range.endsWith('い') ? '' : 'の'}値にしてください`
    }
  }
  return null
}
