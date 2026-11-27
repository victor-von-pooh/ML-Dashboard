import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readDraft, writeDraft } from '../../lib/draft'
import { NotePanel } from './NotePanel'

const RUN = 'demo/2026-01-01/10-00-00'
const PLACE = `note:p1:${RUN}`

const isAny = (value: unknown): value is unknown => value !== undefined

/** 保存したメモを返す fetch (resolve を呼ぶまで待たせられる). PUT の本文を集める */
function stubNotes(note = 'NEW', wait = false) {
  const puts: unknown[] = []
  let release: () => void = () => {}
  const ready = wait ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as unknown
        puts.push(body)
        return Response.json(body)
      }
      if (String(input) === '/api/projects/p1/notes') {
        await ready
        return Response.json({ [RUN]: { note, tags: ['残すタグ'], starred: true } })
      }
      return new Response(null, { status: 404 })
    }),
  )
  return { puts, release: () => release() }
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NotePanel projectId="p1" runId={RUN} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('メモの下書き', () => {
  it('書いたときと同じ保存したメモなら戻し, 手を加えなければ外しても保存しない', async () => {
    const { puts } = stubNotes('NEW')
    writeDraft(PLACE, { text: 'OLD', base: 'NEW' })
    const view = renderPanel()
    expect(await screen.findByRole('textbox', { name: 'メモ' })).toHaveValue('OLD')
    expect(screen.getByText(/下書きから戻しました/)).toBeInTheDocument()
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(puts).toEqual([])
    // 下書きは残る (次に開いたときも戻せる)
    expect(readDraft(PLACE, isAny)).not.toBeNull()
  })

  it('別の所で保存し直したメモには戻さず, 古い下書きを消す', async () => {
    stubNotes('NEWER')
    writeDraft(PLACE, { text: 'OLD', base: 'NEW' })
    renderPanel()
    expect(await screen.findByRole('textbox', { name: 'メモ' })).toHaveValue('NEWER')
    expect(screen.queryByText(/下書きから戻しました/)).not.toBeInTheDocument()
    await waitFor(() => expect(readDraft(PLACE, isAny)).toBeNull())
  })

  it('「下書きを捨てる」で保存したメモに戻し, 下書きを消す', async () => {
    stubNotes('NEW')
    writeDraft(PLACE, { text: 'OLD', base: 'NEW' })
    renderPanel()
    const box = await screen.findByRole('textbox', { name: 'メモ' })
    fireEvent.click(screen.getByRole('button', { name: '下書きを捨てる' }))
    expect(box).toHaveValue('NEW')
    expect(readDraft(PLACE, isAny)).toBeNull()
  })

  it('保存したメモを読む前に外しても, 保存せず下書きも消さない', async () => {
    const { puts, release } = stubNotes('NEW', true)
    writeDraft(PLACE, { text: 'OLD', base: 'NEW' })
    const view = renderPanel()
    view.unmount()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(puts).toEqual([])
    expect(readDraft(PLACE, isAny)).not.toBeNull()
  })

  it('手を加えた書きかけは, 外すときにタグと星を残して保存し, 下書きにも書く', async () => {
    const { puts } = stubNotes('NEW')
    const view = renderPanel()
    const box = await screen.findByRole('textbox', { name: 'メモ' })
    await waitFor(() => expect(box).toHaveValue('NEW'))
    fireEvent.change(box, { target: { value: '書きかけ' } })
    view.unmount()
    await waitFor(() =>
      expect(puts).toEqual([{ note: '書きかけ', tags: ['残すタグ'], starred: true }]),
    )
    expect(readDraft(PLACE, isAny)?.value).toEqual({ text: '書きかけ', base: 'NEW' })
  })
})
