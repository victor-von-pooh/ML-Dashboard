import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が作ったデモのプロジェクト
const DEMO_DIR = path.resolve(import.meta.dirname, '.work', 'demo')

// md (768px) より狭い画面. 左のサイドバーを隠し, 上の帯の移動のメニューで移る
test.use({ viewport: { width: 390, height: 844 } })

test('狭い画面では移動のメニューからジョブの一覧とプロジェクトへ移れる', async ({
  page,
  request,
}) => {
  // デモのプロジェクトを登録 (登録済みならそのまま)
  const listed = (await (await request.get('/api/projects')).json()) as { path: string }[]
  if (!listed.some((project) => project.path === DEMO_DIR)) {
    expect((await request.post('/api/projects', { data: { path: DEMO_DIR } })).status()).toBe(201)
  }

  await page.goto('/')
  // サイドバーは隠れ, 移動の navigation は閉じたメニューの中なので見えない
  await expect(page.getByRole('navigation', { name: '移動' })).toBeHidden()
  const button = page.getByRole('button', { name: /^移動のメニューを開く/ })
  await expect(button).toHaveAttribute('aria-expanded', 'false')

  // キーボードで開くと最初の項目へフォーカスが移り, Tab で次の項目へ移る
  await button.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('navigation', { name: '移動' })
  await expect(menu).toBeVisible()
  await expect(page.getByRole('button', { name: '移動のメニューを閉じる' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(menu.getByRole('link', { name: 'プロジェクト' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(menu.getByRole('link', { name: 'プロジェクト' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu.getByRole('link', { name: /^ジョブ/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/jobs$/)
  await expect(menu).toBeHidden()
  // 選んで閉じたら本文へフォーカスが移る
  await expect(page.getByRole('main')).toBeFocused()

  // 登録したプロジェクトへも移れる
  await page.getByRole('button', { name: /^移動のメニューを開く/ }).click()
  await menu.getByRole('link', { name: /^demo/ }).first().click()
  await expect(page).toHaveURL(/\/projects\/[^/]+$/)
  await expect(menu).toBeHidden()

  // マウスで開いても Esc で閉じてボタンへ戻る
  await page.getByRole('button', { name: /^移動のメニューを開く/ }).click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(page.getByRole('button', { name: /^移動のメニューを開く/ })).toBeFocused()

  // 戻ると閉じる
  await page.getByRole('button', { name: /^移動のメニューを開く/ }).click()
  await expect(menu).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/jobs$/)
  await expect(menu).toBeHidden()
})
