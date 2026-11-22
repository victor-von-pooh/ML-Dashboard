import { fireEvent, render, screen } from '@testing-library/react'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { IntegerField, PrecisionField } from './ConfigForm'

/** 欄の書き換えを YAML の文字に重ねて, 最後の文字を返せるようにする */
function setup(text: string, config: Record<string, unknown>) {
  const state = { text }
  const onEdit = (change: (current: string) => string) => {
    state.text = change(state.text)
  }
  const view = render(
    <IntegerField
      label="検証の間隔"
      path="trainer.valid_every_n_epochs"
      config={config}
      disabled={false}
      onEdit={onEdit}
      hint="この値で割り切れるエポックと予定の最後のエポックだけ検証"
    />,
  )
  return { state, view, onEdit }
}

describe('IntegerField (検証の間隔)', () => {
  it('config の値を出し, 確定した整数を YAML に書き込む', () => {
    const { state } = setup('trainer:\n  epochs: 7\n', { trainer: { valid_every_n_epochs: 1 } })
    const input = screen.getByLabelText('検証の間隔')
    expect(input).toHaveValue(1)
    expect(input).toHaveAccessibleDescription(
      'この値で割り切れるエポックと予定の最後のエポックだけ検証',
    )
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(parse(state.text)).toEqual({ trainer: { epochs: 7, valid_every_n_epochs: 3 } })
  })

  it.each(['0', '-2', '1.5', ''])('1 以上の整数でない値 (%j) は書き込まず, 理由を出す', (raw) => {
    const before = 'trainer:\n  valid_every_n_epochs: 2\n'
    const { state } = setup(before, { trainer: { valid_every_n_epochs: 2 } })
    const input = screen.getByLabelText('検証の間隔')
    fireEvent.change(input, { target: { value: raw } })
    fireEvent.blur(input)
    expect(state.text).toBe(before)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('1 以上の整数にしてください')).toBeVisible()
  })

  it('YAML の欄で値が変わると, 欄の値を合わせて誤りの表示を消す', () => {
    const { view, onEdit } = setup('', { trainer: { valid_every_n_epochs: 2 } })
    const input = screen.getByLabelText('検証の間隔')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(screen.getByText('1 以上の整数にしてください')).toBeVisible()
    view.rerender(
      <IntegerField
        label="検証の間隔"
        path="trainer.valid_every_n_epochs"
        config={{ trainer: { valid_every_n_epochs: 5 } }}
        disabled={false}
        onEdit={onEdit}
      />,
    )
    expect(screen.getByLabelText('検証の間隔')).toHaveValue(5)
    expect(screen.queryByText('1 以上の整数にしてください')).toBeNull()
  })

  it('同じ値を確定しても YAML は書き換えない', () => {
    const before = 'trainer:\n  valid_every_n_epochs: 4 # コメント\n'
    const { state } = setup(before, { trainer: { valid_every_n_epochs: 4 } })
    const input = screen.getByLabelText('検証の間隔')
    fireEvent.blur(input)
    expect(state.text).toBe(before)
  })

  it('書いたままの値の参照 (環境変数など) を文字のまま出し, 整数で書き換えられる', () => {
    const before = 'trainer:\n  valid_every_n_epochs: ${oc.env:EVERY}\n'
    const { state } = setup(before, { trainer: { valid_every_n_epochs: '${oc.env:EVERY}' } })
    const input = screen.getByLabelText('検証の間隔')
    expect(input).toHaveValue('${oc.env:EVERY}')
    fireEvent.blur(input)
    expect(state.text).toBe(before)
    expect(input).toHaveAttribute('aria-invalid', 'false')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(parse(state.text)).toEqual({ trainer: { valid_every_n_epochs: 2 } })
  })
})

describe('PrecisionField (計算の精度)', () => {
  /** 欄の書き換えを YAML の文字に重ねる */
  function renderField(text: string, config: Record<string, unknown>) {
    const state = { text }
    render(
      <PrecisionField
        config={config}
        disabled={false}
        onEdit={(change) => {
          state.text = change(state.text)
        }}
        hint="mps ではメモリを減らすのは勾配の蓄積の方です"
      />,
    )
    return state
  }

  it('config の値を選び, 選び直した値を YAML に書き込む', () => {
    const state = renderField('trainer:\n  epochs: 7\n', { trainer: { precision: 'fp32' } })
    const select = screen.getByLabelText('計算の精度')
    expect(select).toHaveValue('fp32')
    expect(select).toHaveAccessibleDescription('mps ではメモリを減らすのは勾配の蓄積の方です')
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      'fp32',
      'bf16',
    ])
    fireEvent.change(select, { target: { value: 'bf16' } })
    expect(parse(state.text)).toEqual({ trainer: { epochs: 7, precision: 'bf16' } })
  })

  it('選べる値の外 (環境変数の参照など) は書いたままの値を選択肢に足す', () => {
    const state = renderField('trainer:\n  precision: ${oc.env:PREC}\n', {
      trainer: { precision: '${oc.env:PREC}' },
    })
    const select = screen.getByLabelText('計算の精度')
    expect(select).toHaveValue('${oc.env:PREC}')
    fireEvent.change(select, { target: { value: 'fp32' } })
    expect(parse(state.text)).toEqual({ trainer: { precision: 'fp32' } })
  })
})

describe('IntegerField (勾配の蓄積)', () => {
  it('確定した整数を trainer.accumulate_grad_batches に書き込み, 0 は書き込まない', () => {
    const state = { text: '{}\n' }
    render(
      <IntegerField
        label="勾配の蓄積"
        path="trainer.accumulate_grad_batches"
        config={{ trainer: { accumulate_grad_batches: 1 } }}
        disabled={false}
        onEdit={(change) => {
          state.text = change(state.text)
        }}
      />,
    )
    const input = screen.getByLabelText('勾配の蓄積')
    expect(input).toHaveValue(1)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(state.text).toBe('{}\n')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(parse(state.text)).toEqual({ trainer: { accumulate_grad_batches: 4 } })
  })
})
