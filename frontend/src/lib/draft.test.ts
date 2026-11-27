import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readDraft, useDraftWriter, writeDraft } from './draft'

const isText = (value: unknown): value is string => typeof value === 'string'

describe('下書き', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('場所ごとに書いて読み, 形の合わないものと 14 日より古いものは戻さない', () => {
    writeDraft('note:p1:a', 'メモ')
    expect(readDraft('note:p1:a', isText)?.value).toBe('メモ')
    expect(readDraft('note:p1:b', isText)).toBeNull()
    writeDraft('note:p1:b', { text: 'x' })
    expect(readDraft('note:p1:b', isText)).toBeNull()
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
    window.localStorage.setItem(
      'ml-dashboard:drafts',
      JSON.stringify({ 'note:p1:a': { value: '古い', time: old } }),
    )
    expect(readDraft('note:p1:a', isText)).toBeNull()
  })

  it('少し待って書き, 書きかけが無くなれば消し, 分からない間は触らない', () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(({ value }) => useDraftWriter('note:p1:a', value), {
      initialProps: { value: 'メモ' as string | null | undefined },
    })
    expect(readDraft('note:p1:a', isText)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(readDraft('note:p1:a', isText)?.value).toBe('メモ')
    rerender({ value: undefined })
    expect(readDraft('note:p1:a', isText)?.value).toBe('メモ')
    rerender({ value: null })
    expect(readDraft('note:p1:a', isText)).toBeNull()
  })

  it('捨てた書きかけは, 外されても書かない', () => {
    const { result, unmount } = renderHook(() => useDraftWriter('launch:p1:', 'x'))
    act(() => result.current())
    unmount()
    expect(readDraft('launch:p1:', isText)).toBeNull()
  })
})
