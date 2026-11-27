import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Card, StatusBadge } from './ui'

test('見出しを持つ欄は見出しを名前にした区域になる', () => {
  render(
    <>
      <Card title="選んだ問題の設定">中身</Card>
      <Card title="学習の準備">別の中身</Card>
    </>,
  )
  expect(screen.getByRole('region', { name: '選んだ問題の設定' })).toHaveTextContent('中身')
  expect(screen.getByRole('region', { name: '学習の準備' })).toHaveTextContent('別の中身')
})

test('見出しの無い欄は名前を持たず, 区域にならない', () => {
  render(<Card>中身だけ</Card>)
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.getByText('中身だけ').closest('section')).not.toHaveAttribute('aria-labelledby')
})

test('name を渡した欄は, 見出しの中のボタンを含めずにその名前の区域になる', () => {
  render(
    <Card
      name="メモ"
      title={
        <span>
          <button type="button">この実験に星を付ける</button>
          メモ
        </span>
      }
    >
      中身
    </Card>,
  )
  expect(screen.getByRole('region', { name: 'メモ' })).toHaveTextContent('中身')
  expect(screen.queryByRole('region', { name: /星を付ける/ })).toBeNull()
})

test('landmark={false} の欄は区域にならず, 見出しは h2 のまま', () => {
  render(
    <Card title="valid/loss" landmark={false}>
      グラフ
    </Card>,
  )
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.getByRole('heading', { level: 2, name: 'valid/loss' })).toBeInTheDocument()
  const section = screen.getByText('グラフ').closest('section')
  expect(section).not.toHaveAttribute('aria-labelledby')
  expect(section).not.toHaveAttribute('aria-label')
})

test('状態の印は「状態: 完了」の名前で選べ, live にしない', () => {
  render(
    <>
      <StatusBadge status="completed" />
      <StatusBadge status="finishing" />
    </>,
  )
  const done = screen.getByRole('img', { name: '状態: 完了' })
  // 見た目の文字は残し, 説明は title から読む
  expect(done).toHaveTextContent('完了')
  expect(done).toHaveAccessibleDescription('最後まで学習しました')
  expect(screen.getByRole('img', { name: '状態: 後の処理中' })).toBeInTheDocument()
  // 動きの知らせ (status, live) にしない
  expect(screen.queryByRole('status')).toBeNull()
  expect(done).not.toHaveAttribute('aria-live')
})
