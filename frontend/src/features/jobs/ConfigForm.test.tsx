import { fireEvent, render, screen } from '@testing-library/react'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { IntegerField } from './ConfigForm'

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
})
