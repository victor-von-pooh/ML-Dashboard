import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('CSV の見本は表で出し, 作った表と本物の表を列を揃えて並べられる', async () => {
    // ML-Quest の表の生成の骨組みの形 (作った表と, 見比べる検証用の本物の表)
    const files: Record<string, string> = {
      'generated/final.csv': 'age,income,city\n25,400.5,tokyo\n31,,osaka\n',
      'valid_real/final.csv': 'city,age,income\nnagoya,40,380\n',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const found = Object.entries(files).find(([path]) => url.endsWith(path))
        return new Response(found?.[1] ?? '', { status: found ? 200 : 404 })
      }),
    )
    const samples = [
      sample('generated', 'file', 'samples/generated/final.csv', { caption: '作った表 2 行' }),
      sample('valid_real', 'file', 'samples/valid_real/final.csv', { split: 'valid' }),
      sample('weights', 'file', 'samples/weights/final.bin'),
    ]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="table/2026-11-22/10-00-00" />))

    // 見本ごとの表 (列はファイルの順. 空の値は「—」. 数の列は右に寄せる)
    const generated = await screen.findByRole('table', { name: 'generated の学習の後 (表)' })
    const headers = within(generated).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['age', 'income', 'city'])
    const cells = within(generated)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      )
    expect(cells).toEqual([
      ['25', '400.5', 'tokyo'],
      ['31', '—', 'osaka'],
    ])
    expect(headers[0]).toHaveClass('text-right')
    expect(headers[2]).not.toHaveClass('text-right')
    expect(screen.getByRole('link', { name: /final\.bin をダウンロード/ })).toBeInTheDocument()

    // 並べた表は, 右の表も左の表の列の順に揃える
    const right = await screen.findByRole('table', { name: 'valid_real の学習の後 (並べた表)' })
    await waitFor(() =>
      expect(
        within(right)
          .getAllByRole('columnheader')
          .map((header) => header.textContent),
      ).toEqual(['age', 'income', 'city']),
    )
    expect(
      within(within(right).getAllByRole('row')[1]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['40', '380', 'nagoya'])

    // 左右を選び直せる (CSV の見本だけが候補)
    const leftPicker = screen.getByRole('combobox', { name: '左の表' })
    expect(
      within(leftPicker)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['generated', 'valid_real'])
    fireEvent.change(leftPicker, { target: { value: '1' } })
    expect(
      await screen.findAllByRole('table', { name: 'valid_real の学習の後 (並べた表)' }),
    ).toHaveLength(2)
  })

  it('2 MiB を超える CSV の見本は読まず, ダウンロードと表にしない旨を出す', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const samples = [
      sample('generated', 'file', 'samples/generated/final.csv', { size: 3 * 1024 * 1024 }),
    ]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="table/2026-11-22/10-00-00" />))
    expect(screen.getByRole('link', { name: /final\.csv をダウンロード/ })).toBeInTheDocument()
    expect(screen.getByText('大きいので表にしていません (2 MiB まで)')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('CSV の見本が 1 つだけなら並べる欄を出さない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('a\n1\n', { status: 200 })),
    )
    const samples = [sample('generated', 'file', 'samples/generated/final.csv')]
    render(wrap(<SamplesTab samples={samples} projectId="p" runId="table/2026-11-22/10-00-00" />))
    expect(
      await screen.findByRole('table', { name: 'generated の学習の後 (表)' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('表の見本を並べる')).toBeNull()
  })

  it('選んだエポックの学習用と検証用の指標を見本の横に出し, ベストのエポックに印を付ける', () => {
    const samples = [
      sample('pred', 'text', 'samples/pred/epoch_0001.txt', { epoch: 1, size: 10_000_000 }),
      sample('pred', 'text', 'samples/pred/epoch_0002.txt', { epoch: 2, size: 10_000_000 }),
      sample('pred', 'text', 'samples/pred/epoch_0003.txt', { epoch: 3, size: 10_000_000 }),
    ]
    const history = {
      columns: ['epoch', 'train/loss', 'valid/loss'],
      rows: [
        { epoch: 1, 'train/loss': 0.9, 'valid/loss': 0.6 },
        { epoch: 2, 'train/loss': 0.5, 'valid/loss': 0.3 },
        { epoch: 3, 'train/loss': 0.4, 'valid/loss': null },
      ],
      lr_steps: [],
      named_lr_steps: {},
      x_columns: [],
    }
    render(
      wrap(
        <SamplesTab
          samples={samples}
          projectId="p"
          runId="r"
          history={history}
          best={{ monitor: 'valid/loss', mode: 'min', epoch: 2, value: 0.3 }}
          validInterval={2}
        />,
      ),
    )
    // 開いたときは最後のエポック (検証しないエポック)
    const section = screen.getByRole('region', { name: 'pred の見本と同じエポックの評価' })
    expect(within(section).getByText('エポック 3 の評価')).toBeInTheDocument()
    expect(within(section).getByText('検証なし')).toBeInTheDocument()
    expect(within(section).getByText(/2 エポックおき/)).toBeInTheDocument()
    expect(within(section).getByText('ベストはエポック 2 (valid/loss)')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } })
    expect(within(section).getByText('エポック 2 の評価')).toBeInTheDocument()
    expect(within(section).getByText('ベストのエポック')).toBeInTheDocument()
    const row = within(section).getByRole('row', { name: /loss/ })
    expect(row).toHaveTextContent('0.5')
    expect(row).toHaveTextContent('0.3最良')
    expect(within(row).getByText('小さいほど良い')).toBeInTheDocument()
    expect(within(row).getByText('監視する指標')).toBeInTheDocument()
  })

  it('学習の後の見本はエポックの指標を並べない旨を出す', () => {
    render(
      wrap(
        <SamplesTab
          samples={[sample('pred', 'text', 'samples/pred/final.txt', { size: 10_000_000 })]}
          projectId="p"
          runId="r"
        />,
      ),
    )
    expect(screen.getByText(/学習の後の見本はエポックに結び付かない/)).toBeInTheDocument()
  })
})
