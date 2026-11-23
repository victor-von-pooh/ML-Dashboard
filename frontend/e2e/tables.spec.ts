import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の表の生成の骨組みと同じ形の評価と見本を
// e2e/make_tables.py で書いた確かめ用のプロジェクト
const TABLES_DIR = path.resolve(import.meta.dirname, '.work', 'tables')
const RUN = 'table/2026-11-22/10-00-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === TABLES_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: TABLES_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('監視の valid/column_distance は小さいほど良く, 最良のエポックが 2', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN}`)
  const chart = page.getByRole('img', { name: 'column_distance のエポックごとの推移' })
  await expect(chart).toBeVisible()
  const card = page.locator('section').filter({ has: chart })
  await expect(card.getByText('小さいほど良い', { exact: true })).toBeVisible()
  await expect(card.getByText('監視する指標')).toBeVisible()
  // 最良は一番小さい 2 エポック目の 0.18 (向きは min)
  await expect(page.getByRole('main')).toContainText(
    /ベスト\s*valid\/column_distance\s*0\.18\s*エポック 2 \(min\)/,
  )
})

test('列ごとの分布の近さの表を, 値の無い欄を「—」にして出す', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN}`)
  await page.getByRole('tab', { name: /評価/ }).click()
  const valid = page.locator('section').filter({ hasText: 'column_distance_valid' })
  const table = valid.getByRole('table')
  await expect(table.getByRole('columnheader', { name: /^distance/ })).toContainText(
    '小さいほど良い',
  )
  const city = table.getByRole('row').filter({ hasText: 'city' })
  await expect(city.getByRole('cell')).toHaveText(['city', 'category', '0.1800', '—', '0.05000'])
  await expect(table.getByRole('row').filter({ hasText: '(全ての列の平均)' })).toBeVisible()
  await expect(page.locator('section').filter({ hasText: 'column_distance_test' })).toBeVisible()
})

test('作った表と本物の表の CSV の見本を表で見て, 並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN}`)
  await page.getByRole('tab', { name: /見本/ }).click()

  // 見本ごとの表 (100 行と列の名前)
  const generated = page.getByRole('table', { name: 'generated の学習の後 (表)' })
  await expect(generated.getByRole('columnheader')).toHaveText(['age', 'income', 'city'])
  await expect(generated.getByRole('row')).toHaveCount(101)
  await expect(page.getByRole('link', { name: /final\.csv をダウンロード/ }).first()).toBeVisible()

  // 作った表と検証用の本物の表を左右に並べる
  await expect(page.getByText('表の見本を並べる')).toBeVisible()
  await expect(page.getByRole('combobox', { name: '左' })).toHaveValue('0')
  await expect(
    page.getByRole('table', { name: 'generated の学習の後 (並べた表)' }).getByRole('columnheader'),
  ).toHaveText(['age', 'income', 'city'])
  await expect(
    page.getByRole('table', { name: 'valid_real の学習の後 (並べた表)' }).getByRole('columnheader'),
  ).toHaveText(['age', 'income', 'city'])
})
