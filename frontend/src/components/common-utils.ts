/**
 * 5 つの段階の画面の共通の部品が使う, 部品でない関数 (殻の docs/DESIGN.md の R12).
 *
 * 殻の parts/common-utils.ts が正で, 各アプリは frontend/src/components/common-utils.ts
 * にそのまま写す (1 字でも違うと殻の CI が差を出す). 部品と分けるのは, 部品の
 * ファイルが部品だけを書き出すようにするため (React の差し替えの決まり)
 */

/** 誤りの検証の配列で, 欄の名前でない置き場所の印 (loc の先頭だけに来る) */
const LOCATIONS = new Set(['body', 'query', 'path', 'header', 'cookie'])

/** 入力の検証の誤り (422) の 1 件を「欄: 理由」の行にする */
function validationLine(item: unknown): string {
  const record = (item && typeof item === 'object' ? item : {}) as {
    loc?: unknown
    msg?: unknown
  }
  const loc = Array.isArray(record.loc) ? record.loc : []
  // 先頭の置き場所の印だけを除き, 欄の名前 (path という名前の欄も) は残す
  const parts = loc.length > 0 && LOCATIONS.has(String(loc[0])) ? loc.slice(1) : loc
  const field = parts.join('.')
  const message = typeof record.msg === 'string' ? record.msg : ''
  return field ? `${field}: ${message}` : message
}

/**
 * API の誤りの応答の本文から画面の文を作る. detail が文ならそのまま (FastAPI の
 * 既定の 404 の Not Found は経路が無いと言い換える), 画面の文 (message) を持つ
 * 形ならその文, 入力の検証の誤り (422 の配列) なら 1 件ずつ「欄: 理由」を 1 行に
 * して改行でつなぐ. 他は状態の番号と文
 *
 * @param status - 応答の状態の番号
 * @param statusText - 応答の状態の文
 * @param body - 応答の本文を JSON として読んだもの (読めなければ undefined)
 */
export function errorText(status: number, statusText: string, body: unknown): string {
  const fallback = `${status} ${statusText}`.trim()
  if (!body || typeof body !== 'object' || !('detail' in body)) return fallback
  const detail = (body as { detail: unknown }).detail
  if (typeof detail === 'string') {
    // 段階の API は見つからない物を日本語の文で返すので, 英語の既定の文は経路の誤り
    if (status === 404 && detail === 'Not Found') return 'API の経路が見つかりません (404)'
    return detail
  }
  if (Array.isArray(detail)) {
    const lines = detail.map(validationLine).filter((line) => line !== '')
    return lines.length > 0 ? lines.join('\n') : fallback
  }
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const message = (detail as { message: unknown }).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(detail)
}

/**
 * 欄の aria-describedby の値を作る. 渡した id のうち空 (空白だけを含む) でない
 * ものを空白でつなぎ,
 * 1 つも無ければ undefined を返す (説明と欄の下の誤りと ErrorBox を, 出ている
 * ものだけ結ぶため)
 *
 * @param ids - 結ぶ要素の id (出ていない要素は undefined, null, false, 空の文)
 */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const value = ids
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim())
    .join(' ')
  return value === '' ? undefined : value
}

/** タブの中身の要素に付ける属性 (選んだタブと結び付ける) */
export function tabPanelProps(idBase: string, value: string) {
  return {
    id: `${idBase}-panel`,
    role: 'tabpanel',
    'aria-labelledby': `${idBase}-tab-${value}`,
  } as const
}
