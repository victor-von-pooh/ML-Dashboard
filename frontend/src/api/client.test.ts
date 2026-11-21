import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, COPY_REFUSED_CODE, isCopyRefused, request } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request のエラー', () => {
  it('応答の detail を文に, code をエラーの種類にする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ detail: '起動しません', code: 'model_spec_copy_refused' }, { status: 400 }),
      ),
    )
    const error: unknown = await request('/api/x').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('起動しません')
    // バックエンドの COPY_REFUSED_CODE と同じ値
    expect(COPY_REFUSED_CODE).toBe('model_spec_copy_refused')
    expect(isCopyRefused(error)).toBe(true)
  })

  it('code の無い応答と JSON でない応答は code が null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: '誤り' }, { status: 400 })),
    )
    const plain: unknown = await request('/api/x').catch((caught: unknown) => caught)
    expect((plain as ApiError).code).toBeNull()
    expect(isCopyRefused(plain)).toBe(false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500, statusText: 'Server Error' })),
    )
    const text: unknown = await request('/api/x').catch((caught: unknown) => caught)
    expect((text as ApiError).message).toBe('500 Server Error')
    expect((text as ApiError).code).toBeNull()
  })
})
