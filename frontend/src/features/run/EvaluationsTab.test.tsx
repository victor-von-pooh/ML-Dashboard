import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Evaluation } from '../../api/client'
import { EvaluationsTab } from './EvaluationsTab'

const table: Evaluation = {
  name: 'safety',
  split: 'test',
  kind: 'table',
  x: null,
  columns: ['metric', 'value', 'diff'],
  rows: [{ metric: 'miss', value: 0.01, diff: null }],
  description: '見逃し',
  baseline: '今の処理',
  guard: true,
  better: {},
  epoch: 9,
  created_at: null,
  total_rows: 3000,
}

describe('EvaluationsTab', () => {
  it('守る指標の表を印付きで, 列の順と添える情報と一緒に出す', () => {
    render(<EvaluationsTab evaluations={[table]} />)
    expect(screen.getByText('守る指標')).toBeInTheDocument()
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['metric', 'value', 'diff'])
    expect(screen.getByText('見逃し')).toBeInTheDocument()
    expect(screen.getByText('今の処理')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText(/3,000 行のうち/)).toBeInTheDocument()
  })

  it('表を作る課題の列ごとの分布の近さは, 向きを見出しに添え, 値の無い欄を「—」にする', () => {
    // ML-Quest の表の生成の骨組みが書く evaluations/column_distance_valid.json の形
    const distance: Evaluation = {
      name: 'column_distance_valid',
      split: 'valid',
      kind: 'table',
      x: null,
      columns: ['column', 'type', 'distance', 'wasserstein', 'train_distance'],
      rows: [
        { column: 'age', type: 'number', distance: 0.16, wasserstein: 0.21, train_distance: 0.08 },
        {
          column: 'city',
          type: 'category',
          distance: 0.18,
          wasserstein: null,
          train_distance: 0.05,
        },
        {
          column: '(全ての列の平均)',
          type: null,
          distance: 0.17,
          wasserstein: null,
          train_distance: 0.065,
        },
      ],
      description: '作った表と検証用の本物の表の列ごとの分布の近さ',
      baseline: null,
      guard: false,
      better: { distance: 'lower', wasserstein: 'lower' },
      epoch: 2,
      created_at: null,
      total_rows: 3,
    }
    render(<EvaluationsTab evaluations={[distance]} />)
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      'column',
      'type',
      'distance(小さいほど良い)',
      'wasserstein(小さいほど良い)',
      'train_distance',
    ])
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(4)
    expect(
      within(rows[2]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['city', 'category', '0.1800', '—', '0.05000'])
    expect(within(rows[3]!).getAllByRole('cell')[1]).toHaveTextContent('—')
  })
})
