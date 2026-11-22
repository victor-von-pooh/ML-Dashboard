import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が ML-Pathfinder の置き場に記録した, まだ登録していないプロジェクト
const EXPORTED_DIR = path.resolve(import.meta.dirname, '.work', 'exported')
// 問題の設定に記録の無い, 監視する指標を書かない default の config を持つプロジェクト
const OWN_DIR = path.resolve(import.meta.dirname, '.work', 'own')

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

test('記録した問題の設定の監視する指標と向きが, 学習の起動の欄に初めから入る', async ({
  page,
  request,
}) => {
  // 上の試しで登録した exported (default の config は監視する指標を書いていない)
  const projects = (await (await request.get('/api/projects')).json()) as {
    id: string
    path: string
  }[]
  const exported = projects.find((item) => item.path === EXPORTED_DIR)
  expect(exported).toBeDefined()
  await page.goto(`/projects/${exported!.id}/launch`)

  // ML-Quest の受け渡しの値 (総菜の作る量の見本は平均絶対誤差) と出どころ
  const monitor = page.getByLabel('監視する指標', { exact: true })
  await expect(monitor).toHaveValue('valid/mae')
  await expect(page.getByLabel('向き', { exact: true })).toHaveValue('min')
  await expect(monitor).toHaveAccessibleDescription(
    /問題の設定「e2e の売上」で選んだ指標から決めた, 監視する指標と向きです/,
  )
  const editor = page.getByLabel('config の中身')
  await expect(editor).toHaveValue(/monitor: valid\/mae/)

  // 変えると, 問題の設定の値から変えたことが出る
  await page.getByLabel('向き', { exact: true }).selectOption('max')
  await expect(editor).toHaveValue(/mode: max/)
  await expect(monitor).toHaveAccessibleDescription(
    /「e2e の売上」の値 \(valid\/mae, min\) から変えています/,
  )
})

test('骨組みの外のプロジェクトで, 問題の設定を選んで監視する指標と向きを入れる', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/projects', { data: { path: OWN_DIR } })
  expect(created.ok()).toBeTruthy()
  const { id } = (await created.json()) as { id: string }
  await page.goto(`/projects/${id}/launch`)

  // 記録が無いので初めは入れず, 学習しない問題の設定は選べない
  const monitor = page.getByLabel('監視する指標', { exact: true })
  const picker = page.getByLabel('問題の設定から')
  await expect(picker).toHaveValue('')
  await expect(monitor).toHaveValue('')
  await expect(picker.getByRole('option', { name: 'e2e の写真 (使えません)' })).toBeDisabled()
  await expect(page.getByText(/e2e の写真: 学習しない/)).toBeVisible()

  // 選ぶと入り, ML-Found の確かめで差分になる
  await picker.selectOption({ label: 'e2e の解約 (valid/accuracy, max)' })
  await expect(monitor).toHaveValue('valid/accuracy')
  await expect(page.getByLabel('向き', { exact: true })).toHaveValue('max')
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await expect(page.getByText('trainer.monitor: null → valid/accuracy')).toBeVisible()
  await expect(page.getByText('trainer.mode: min → max')).toBeVisible()
})
