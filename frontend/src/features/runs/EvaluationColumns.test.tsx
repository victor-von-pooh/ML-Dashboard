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
  it('押すと落ちた指標の説明を開き, もう一度押すか Esc か外を押すと閉じる', () => {
    render(
      <>
        <GuardBadge
          guard={{ state: 'dropped', dropped: ['by_class: acc (差 -0.1)'], unknown: [] }}
        />
        <p>外</p>
      </>,
    )
    const badge = screen.getByRole('button', { name: '守る指標: 落ちた' })
    // 開くまでは説明を出さず, title も付けない (読み上げを二重にしない)
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(badge).not.toHaveAttribute('title')
    expect(screen.queryByText(/by_class: acc/)).not.toBeInTheDocument()
    fireEvent.click(badge)
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('落ちた: by_class: acc (差 -0.1)')
    fireEvent.click(badge)
    expect(screen.queryByText(/by_class: acc/)).not.toBeInTheDocument()
    fireEvent.click(badge)
    fireEvent.keyDown(badge, { key: 'Escape' })
    expect(screen.queryByText(/by_class: acc/)).not.toBeInTheDocument()
    fireEvent.click(badge)
    fireEvent.pointerDown(screen.getByText('外'))
    expect(badge).toHaveAttribute('aria-expanded', 'false')
  })
  it('2 つ目を開くと 1 つ目が閉じ, Tab で離れると閉じる', () => {
    render(
      <>
        <GuardBadge guard={{ state: 'dropped', dropped: ['a: acc (差 -0.1)'], unknown: [] }} />
        <GuardBadge guard={{ state: 'unknown', dropped: [], unknown: ['b: 向きが分からない'] }} />
        <button type="button">次</button>
      </>,
    )
    const first = screen.getByRole('button', { name: '守る指標: 落ちた' })
    const second = screen.getByRole('button', { name: '守る指標: 判断できない' })
    fireEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(second)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText(/a: acc/)).not.toBeInTheDocument()
    // 印の外へフォーカスが移ると閉じる
    fireEvent.blur(second, { relatedTarget: screen.getByRole('button', { name: '次' }) })
    expect(second).toHaveAttribute('aria-expanded', 'false')
    // Esc は印にフォーカスが無くても (Safari など) 効く
    fireEvent.click(second)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second).toHaveAttribute('aria-expanded', 'false')
  })
  it('説明の文を押しても (行き先が無いか印を包む要素へのフォーカスの移り) 閉じない', () => {
    render(
      <main tabIndex={-1}>
        <GuardBadge guard={{ state: 'kept', dropped: [], unknown: [] }} />
      </main>,
    )
    const badge = screen.getByRole('button', { name: '守る指標: 保った' })
    fireEvent.click(badge)
    fireEvent.blur(badge, { relatedTarget: null })
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    // 押すとフォーカスが印を包む main に移る場合も閉じない
    fireEvent.blur(badge, { relatedTarget: screen.getByRole('main') })
    fireEvent.focusIn(screen.getByRole('main'))
    expect(badge).toHaveAttribute('aria-expanded', 'true')
  })
  it('説明の文を押した後に Tab で印の外へ移ると閉じる', () => {
    render(
      <main tabIndex={-1}>
        <GuardBadge guard={{ state: 'kept', dropped: [], unknown: [] }} />
        <button type="button">次</button>
      </main>,
    )
    const badge = screen.getByRole('button', { name: '守る指標: 保った' })
    fireEvent.click(badge)
    // 説明の文を押してフォーカスが main に移った後, Tab で次のボタンへ
    fireEvent.blur(badge, { relatedTarget: screen.getByRole('main') })
    fireEvent.focusIn(badge)
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    fireEvent.focusIn(screen.getByRole('button', { name: '次' }))
    expect(badge).toHaveAttribute('aria-expanded', 'false')
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
