import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が ML-Pathfinder の置き場に記録した, まだ登録していないプロジェクト
const EXPORTED_DIR = path.resolve(import.meta.dirname, '.work', 'exported')

test('ML-Pathfinder で書き出したプロジェクトを, 場所を打たずに一覧から登録する', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'プロジェクトを追加' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'プロジェクトを追加' })

  // 記録のあるプロジェクトだけが並ぶ (記録の無い問題の設定は出ない)
  const list = dialog.getByRole('list', { name: '登録していない書き出したプロジェクト' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText(EXPORTED_DIR)
  await expect(list).toContainText('問題の設定: e2e の売上')
  await expect(dialog).not.toContainText('e2e の下書き')

  // 場所を打つ欄も残る
  await expect(dialog.getByLabel('探すディレクトリのパス')).toBeVisible()

  // 登録すると知らせ, 一覧から外れる
  await list.getByRole('button', { name: 'exported を登録' }).click()
  await expect(dialog.getByRole('status')).toHaveText('exported を登録しました')
  await expect(dialog).toContainText('登録していない書き出したプロジェクトはありません')

  // 閉じるとプロジェクトの一覧にある
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(page.getByRole('main').getByRole('link', { name: /^exported/ })).toBeVisible()
})
