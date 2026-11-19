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
})
