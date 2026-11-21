import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { EvaluationValue } from '../../api/client'
import { collectColumns } from '../../lib/evaluations'
import { EvaluationCell, EvaluationColumnPicker, GuardBadge } from './EvaluationColumns'

const diff: EvaluationValue = {
  evaluation: 'baseline_test',
  column: 'accuracy_diff',
  value: -0.05,
  guard: false,
  diff: true,
  better: 'higher',
  baseline: '最近傍',
}

describe('GuardBadge', () => {
  it('落ちた守る指標を文字と説明で出す', () => {
    render(
      <GuardBadge
        guard={{ state: 'dropped', dropped: ['by_class: acc (差 -0.1)'], unknown: [] }}
      />,
    )
    expect(screen.getByText('落ちた')).toBeInTheDocument()
    expect(screen.getByText(/by_class: acc \(差 -0.1\)/)).toBeInTheDocument()
  })
  it('守る指標の表が無い実験には印を出さない', () => {
    render(<GuardBadge guard={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('EvaluationCell', () => {
  it('悪い向きの差に「悪い」を付ける', () => {
    render(<EvaluationCell value={diff} />)
    expect(screen.getByText('悪い')).toBeInTheDocument()
    expect(screen.getByTitle('最近傍 との差')).toHaveTextContent('-0.05')
  })
  it('良い向きの差には符号と「良い」を付ける', () => {
    render(<EvaluationCell value={{ ...diff, value: 0.02 }} />)
    expect(screen.getByText('良い')).toBeInTheDocument()
    expect(screen.getByTitle('最近傍 との差')).toHaveTextContent('+0.02')
  })
  it('向きの分からない差は値だけ', () => {
    render(<EvaluationCell value={{ ...diff, better: null }} />)
    expect(screen.queryByText('悪い')).not.toBeInTheDocument()
    expect(screen.getByText('-0.05')).toBeInTheDocument()
  })
})

describe('EvaluationColumnPicker', () => {
  it('上限まで選ぶと他の列を選べない', () => {
    const columns = collectColumns([
      {
        values: [
          { ...diff, column: 'accuracy', value: 0.9, diff: false },
          diff,
          { ...diff, evaluation: 'other', column: 'score', value: 1, diff: false },
        ],
      },
    ])
    const onChange = vi.fn()
    render(
      <EvaluationColumnPicker
        columns={columns}
        chosen={columns.slice(0, 2)}
        limit={2}
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('checkbox', { name: 'other:score' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'baseline_test:accuracy' }))
    expect(onChange).toHaveBeenCalledWith(['baseline_test:accuracy_diff'])
    fireEvent.change(screen.getByRole('textbox', { name: '評価の列を名前で探す' }), {
      target: { value: 'score' },
    })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })
})
