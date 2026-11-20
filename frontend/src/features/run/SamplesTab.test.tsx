import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Sample, SampleCloud } from '../../api/client'
import { ThemeContext } from '../../lib/themeContext'
import { SamplesTab } from './SamplesTab'

function sample(name: string, kind: string, path: string, extra: Partial<Sample> = {}): Sample {
  return {
    name,
    epoch: null,
    kind,
    path,
    size: 100,
    split: null,
    caption: null,
    created_at: null,
    newer_version: false,
    ...extra,
  }
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ThemeContext.Provider value={{ theme: 'light', toggle: () => {} }}>
        {children}
      </ThemeContext.Provider>
    </QueryClientProvider>
  )
}

/** 点群の API の応答を決まった値にする */
function stubCloud(cloud: SampleCloud) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(cloud), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('SamplesTab', () => {
  // jsdom は canvas に描けないので, 描く所は飛ばす (図の名前と説明を確かめる)
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('領域の見本は絵と, 番号の表から作った凡例を出す. 表が無ければ絵だけ', () => {
    const samples = [
      sample('mask', 'mask', 'samples/mask/final.png', {
        classes: [
          { id: 0, name: 'background', color: '#000000' },
          { id: 2, name: null, color: '#008000' },
        ],
      }),
      sample('plain', 'mask', 'samples/plain/final.png', { classes: null }),
    ]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="demo/2026-11-08/10-00-00" />))
    expect(
      screen.getByRole('img', { name: /mask の学習の後 \(領域を色分けした絵\)/ }),
    ).toHaveAttribute('src', expect.stringContaining('/files/samples/mask/final.png'))
    const legend = screen.getByRole('list', { name: 'mask の領域の凡例' })
    const rows = within(legend).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('0background#000000')
    expect(rows[1]).toHaveTextContent('2名前なし#008000')
    expect(screen.getByRole('img', { name: /plain の学習の後/ })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'plain の領域の凡例' })).toBeNull()
  })

  it('点群は元の座標で開き, 正規化した座標に切り替えられ, 元の座標の軸に単位を添える', async () => {
    const fetchMock = stubCloud({
      vertices: 2,
      points: [
        [0, 0.5, 1],
        [1, 0, -1],
      ],
      original: [
        [-1, 1, 5],
        [1, 0, 1],
      ],
      units: 'm',
      reason: null,
    })
    const samples = [sample('cloud', 'point_cloud', 'samples/cloud/final.ply')]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="demo/2026-11-08/10-00-00" />))

    expect(
      await screen.findByRole('img', { name: 'cloud の点群を上から見た図 (元の座標)' }),
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/samples/cloud?path=samples%2Fcloud%2Ffinal.ply'),
      expect.anything(),
    )
    expect(screen.getByText(/x \(m\) を横, y \(m\) を縦/)).toBeInTheDocument()

    const group = screen.getByRole('group', { name: 'cloud の点群の座標' })
    fireEvent.click(within(group).getByRole('button', { name: '正規化した座標' }))
    expect(within(group).getByRole('button', { name: '正規化した座標' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      screen.getByRole('img', { name: 'cloud の点群を上から見た図 (正規化した座標)' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/x を横, y を縦/)).toBeInTheDocument()
  })

  it('新しい版の一覧の点群は, 元の座標に戻せない理由を出し, 切り替えを出さない', async () => {
    stubCloud({
      vertices: 2,
      points: [
        [0, 0.5, 1],
        [1, 0, -1],
      ],
      original: null,
      units: null,
      reason: '見本の一覧 (samples/index.json) の版が新しいので, 元の座標に戻せません',
    })
    const samples = [
      sample('cloud', 'point_cloud', 'samples/cloud/final.ply', { newer_version: true }),
    ]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="demo/2026-11-08/10-00-00" />))
    expect(await screen.findByText(/元の座標に戻せません/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'cloud の点群を上から見た図' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'cloud の点群の座標' })).toBeNull()
  })
})
