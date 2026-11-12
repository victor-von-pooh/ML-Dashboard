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
  // 既定値が 0 のような整数でも小数を書けるように, int と float は同じ数として扱う
  if (kind === 'int' || kind === 'float') {
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
