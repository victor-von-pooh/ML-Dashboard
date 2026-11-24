import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の並べるの骨組みと同じ形の評価を
// e2e/make_ranking.py で書いた確かめ用のプロジェクト (監視は valid/loss)
const RANKING_DIR = path.resolve(import.meta.dirname, '.work', 'ranking')
const RUN = 'ranking/2026-11-24/10-00-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === RANKING_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: RANKING_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('監視が損失でも, Recall@K と NDCG の学習曲線は大きいほど良い (推測)', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN}`)
  for (const name of ['recall_at_k', 'ndcg']) {
    const chart = page.getByRole('img', { name: `${name} のエポックごとの推移` })
    await expect(chart).toBeVisible()
    const card = page.locator('section').filter({ has: chart })
    await expect(card.getByText('大きいほど良い (推測)', { exact: true })).toBeVisible()
  }
})

test('評価のタブで, 人気順との差に符号と良し悪しの印を付ける', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN}`)
  await page.getByRole('tab', { name: /評価/ }).click()

  // テスト用はどちらの指標も人気順より良い
  const test = page.locator('section').filter({ hasText: 'ranking_test' })
  await expect(test.getByText('人気順 (学習用の反応の多い順)')).toBeVisible()
  const testCells = test.getByRole('row').nth(1).getByRole('cell')
  await expect(testCells.nth(4)).toHaveText('+0.1296良い')
  await expect(testCells.nth(7)).toHaveText('+0.2456良い')

  // 検証用の NDCG だけ人気順より悪い
  const valid = page.locator('section').filter({ hasText: 'ranking_valid' })
  const validCells = valid.getByRole('row').nth(1).getByRole('cell')
  await expect(validCells.nth(4)).toHaveText('+0.1613良い')
  await expect(validCells.nth(7)).toHaveText('-0.01000悪い')
})

test('実験の一覧に, テスト用の Recall@K と NDCG の人気順との差を出す', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  const row = page.getByRole('row', { name: RUN })
  await expect(row).toContainText('+0.1296')
  await expect(row.getByText('良い').first()).toBeVisible()
})
