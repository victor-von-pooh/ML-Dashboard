// 保存していない書きかけの下書き (ブラウザの localStorage に場所ごとに残す)

import { useEffect, useRef } from 'react'

// 下書きを置くブラウザの保存場所の名前 (場所ごとの下書きの辞書)
const DRAFT_KEY = 'ml-dashboard:drafts'
// 下書きを戻せる期間 (それより古いものは戻さずに消す)
const DRAFT_DAYS = 14

/** 1 つの場所の下書き */
export interface Draft<T> {
  value: T
  /** 書いた時刻 (ISO 8601) */
  time: string
}

/** 下書きの辞書を読む (読めない場合は空. 形の合わないものと古いものは除く) */
function readDrafts(): Record<string, Draft<unknown>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? '{}') as unknown
    if (!value || typeof value !== 'object') return {}
    const limit = Date.now() - DRAFT_DAYS * 24 * 60 * 60 * 1000
    const drafts: Record<string, Draft<unknown>> = {}
    for (const [place, item] of Object.entries(value as Record<string, Partial<Draft<unknown>>>)) {
      const time = Date.parse(String(item?.time))
      if (item && 'value' in item && Number.isFinite(time) && time > limit) {
        drafts[place] = { value: item.value, time: String(item.time) }
      }
    }
    return drafts
  } catch {
    return {}
  }
}

/** 下書きの辞書を書く (書けない場合は false) */
function writeDrafts(drafts: Record<string, Draft<unknown>>): boolean {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
    return true
  } catch {
    return false
  }
}

/**
 * 場所の下書きを読む (無いか形が合わなければ null)
 *
 * @param place - 下書きの場所 (`launch:<プロジェクト>:<実験>` など)
 * @param check - 中身の形を確かめる関数
 */
export function readDraft<T>(
  place: string,
  check: (value: unknown) => value is T,
): Draft<T> | null {
  const item = readDrafts()[place]
  if (!item || !check(item.value)) return null
  return { value: item.value, time: item.time }
}

/**
 * 場所の下書きを書く (書けない場合は古い下書きを残さないように消す)
 *
 * @param place - 下書きの場所
 * @param value - 書く中身
 */
export function writeDraft(place: string, value: unknown): void {
  const drafts = readDrafts()
  drafts[place] = { value, time: new Date().toISOString() }
  if (!writeDrafts(drafts)) clearDraft(place)
}

/** 場所の下書きを消す */
export function clearDraft(place: string): void {
  const drafts = readDrafts()
  if (!(place in drafts)) return
  delete drafts[place]
  writeDrafts(drafts)
}

/**
 * 保存していない書きかけを, 少し待ってから場所の下書きに書く. 部品が外されるときと
 * `flushKey` が替わるときは待たずに書く
 *
 * 殻の中で段階を移ると部品が外され, ページを閉じないので `beforeunload` の確かめが出ない.
 * 殻でプロジェクトを替えたときも, そのまま段階を移ることがある. 待つ間の書きかけを黙って
 * 捨てないように, そのときに書く
 *
 * @param place - 下書きの場所
 * @param value - 書く中身. null は書きかけが無い (下書きを消す), undefined はまだ分からない
 *   (読み込みの間など. 書かず, 消さない)
 * @param flushKey - 替わったときに待たずに書く値 (殻で選んだ問題の設定)
 * @param delay - 待つ時間 (ミリ秒)
 * @returns 書きかけを捨てて下書きを消す関数 (起動したときなど, 外されても書かないため)
 */
export function useDraftWriter(
  place: string,
  value: unknown,
  flushKey: unknown = null,
  delay = 1000,
): () => void {
  // まだ書いていない書きかけ (書くものが無ければ null)
  const pending = useRef<{ place: string; value: unknown } | null>(null)
  // まだ書いていない書きかけを待たずに書く
  const flush = useRef(() => {
    const item = pending.current
    if (item === null) return
    pending.current = null
    writeDraft(item.place, item.value)
  })
  // 中身が替わったかを比べるための文字 (毎回作り直す値でも書き直さないため)
  const text = value === undefined ? undefined : JSON.stringify(value)
  useEffect(() => {
    if (text === undefined) return
    if (text === 'null') {
      pending.current = null
      clearDraft(place)
      return
    }
    const item = { place, value: JSON.parse(text) as unknown }
    pending.current = item
    const timer = window.setTimeout(() => {
      if (pending.current === item) flush.current()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [place, text, delay])
  // flushKey が替わったときは, まだ書いていない書きかけを待たずに書く (最初は書かない)
  const lastKey = useRef(flushKey)
  useEffect(() => {
    if (Object.is(lastKey.current, flushKey)) return
    lastKey.current = flushKey
    flush.current()
  }, [flushKey])
  // 外されるときも, まだ書いていない書きかけを待たずに書く
  useEffect(() => {
    const write = flush.current
    return () => write()
  }, [])
  return () => {
    const item = pending.current
    pending.current = null
    clearDraft(item?.place ?? place)
  }
}
