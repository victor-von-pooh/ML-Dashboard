import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { History } from '../../api/client'
import type { ChartSeries } from '../../components/LineChart'
import { MetricCharts } from './MetricCharts'

// グラフは描かずに, 渡した系列を記録する (jsdom では canvas を描けないため)
const drawn = vi.hoisted(() => new Map<string, ChartSeries[]>())
vi.mock('../../components/LineChart', () => ({
  LineChart: ({ series, label }: { series: ChartSeries[]; label: string }) => {
    drawn.set(label, series)
    return <div role="img" aria-label={label} />
  },
}))

// 5 エポックごとに検証し, FID を数える生成の学習 (ML-Quest の骨組みの形)
const history: History = {
  columns: ['epoch', 'train/loss', 'valid/loss', 'valid/fid', 'lr'],
  rows: Array.from({ length: 10 }, (_, index) => {
    const epoch = index + 1
    const judged = epoch % 5 === 0
    return {
      epoch,
      'train/loss': 1 / epoch,
      'valid/loss': judged ? 1.2 / epoch : null,
      'valid/fid': judged ? 300 / epoch : null,
      lr: 0.001,
    }
  }),
  lr_steps: [],
  named_lr_steps: {},
}

function card(name: string): HTMLElement {
  return screen.getByRole('img', { name: `${name} のエポックごとの推移` }).closest('section')!
}

describe('MetricCharts', () => {
  it('検証のエポックだけの valid/fid は空のエポックを飛ばしてつなぎ, 小さいほど良いと出す', () => {
    render(
      <MetricCharts
        history={history}
        best={{ monitor: 'valid/fid', mode: 'min', epoch: 10, value: 30 }}
        validInterval={5}
      />,
    )

    // 記録のある 5, 10 エポックだけを点で描き, 間をつなぐ
    const fid = drawn.get('fid のエポックごとの推移')!
    expect(fid).toHaveLength(1)
    expect(fid[0]!.sparse).toBe(true)
    expect(fid[0]!.points.filter(([, value]) => value != null).map(([x]) => x)).toEqual([5, 10])
    expect(within(card('fid')).getByText(/valid\/fid は記録のあるエポック/)).toBeInTheDocument()

    // 監視する指標は ML-Found の向き (推測ではない)
    const fidCard = within(card('fid'))
    expect(fidCard.getByText('小さいほど良い')).toBeInTheDocument()
    expect(fidCard.queryByText(/推測/)).not.toBeInTheDocument()
    expect(fidCard.getByText('監視する指標')).toBeInTheDocument()

    // 毎エポックの train/loss はつながず, 損失は名前から推測した向き
    const loss = drawn.get('loss のエポックごとの推移')!
    expect(loss.find((item) => item.name === 'train/loss')!.sparse).toBeUndefined()
    expect(within(card('loss')).getByText(/小さいほど良い/)).toHaveTextContent('(推測)')

    // 学習率には向きを出さない
    expect(within(card('lr')).queryByText(/ほど良い/)).not.toBeInTheDocument()
  })
})
