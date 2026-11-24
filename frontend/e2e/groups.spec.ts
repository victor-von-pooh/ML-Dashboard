import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の群分けの骨組みと同じ形の評価を
// e2e/make_groups.py で書いた確かめ用のプロジェクト (群の数 3 と 4 の実験)
const GROUPS_DIR = path.resolve(import.meta.dirname, '.work', 'groups')
const THREE = 'group_3/2026-11-24/10-00-00'
const FOUR = 'group_3/2026-11-24/10-10-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === GROUPS_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: GROUPS_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('シルエット係数の学習曲線に, 日本語の説明と監視する指標の向きを添える', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${THREE}`)
  const chart = page.getByRole('img', { name: 'silhouette のエポックごとの推移' })
  await expect(chart).toBeVisible()
  const card = page.locator('section').filter({ has: chart })
  await expect(card.getByText('シルエット係数 (群のまとまり. -1 から 1)')).toBeVisible()
  await expect(card.getByText('大きいほど良い', { exact: true })).toBeVisible()
  await expect(card.getByText('監視する指標')).toBeVisible()
})

test('評価のタブで, 群の安定性の差に良し悪しの印を付け, 群の要約を並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${THREE}`)
  await page.getByRole('tab', { name: /評価/ }).click()

  // 群の安定性: 列の特徴をそのまま分けた群との差. 調整ランド指数は同じで,
  // シルエット係数だけがそのままより悪い
  const stability = page.locator('section').filter({ hasText: 'group_stability' })
  await expect(stability.getByText('列の特徴をそのまま k-means で分けた群')).toBeVisible()
  await expect(stability.getByRole('columnheader', { name: /^群の数\s*k$/ })).toBeVisible()
  await expect(
    stability.getByRole('columnheader', {
      name: /調整ランド指数の平均 \(比べる相手との差\)\s*ari_diff/,
    }),
  ).toBeVisible()
  const cells = stability.getByRole('row').nth(1).getByRole('cell')
  await expect(cells.nth(5)).toHaveText(/同じ$/)
  await expect(cells.nth(11)).toHaveText(/^-.*悪い$/)

  // 群の要約: 群ごとの行と最後の全体の行
  const summary = page.locator('section').filter({ hasText: 'group_summary' })
  await expect(summary.getByRole('columnheader', { name: /^行の数\s*rows$/ })).toBeVisible()
  await expect(summary.getByRole('columnheader', { name: /^群の安定性/ })).toBeVisible()
  const rows = summary.getByRole('row')
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(4).getByRole('cell').first()).toHaveText('全体')
})

test('群の数を変えた実験を一覧と比較で並べ, 群の安定性の差と群の数の違いを見る', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}`)
  // 全ての行で数えた群の安定性が一覧の列に出る (群の数 4 は調整ランド指数が悪い)
  await expect(page.getByRole('columnheader', { name: /group_stability/ }).first()).toBeVisible()
  const four = page.getByRole('row', { name: FOUR })
  await expect(four).toContainText('group.k')
  await expect(four.getByText('悪い').first()).toBeVisible()
  const three = page.getByRole('row', { name: THREE })
  await expect(three.getByText('同じ').first()).toBeVisible()

  // 2 つを比べると, config の違い (group.k) と評価の値が並ぶ
  const checkboxes = page.getByRole('checkbox', { name: /を比較に選ぶ/ })
  await expect(checkboxes).toHaveCount(2)
  for (const index of [0, 1]) {
    await checkboxes.nth(index).click()
    await expect(checkboxes.nth(index)).toBeChecked()
  }
  await page.getByRole('button', { name: /^比較/ }).click()
  await expect(page.getByRole('heading', { name: '実験の比較' })).toBeVisible()
  await expect(page.getByText('group.k').first()).toBeVisible()
  const evaluations = page.locator('section', {
    has: page.getByRole('heading', { name: 'テスト用の評価' }),
  })
  await expect(
    evaluations.getByRole('columnheader', { name: /調整ランド指数の平均 \(比べる相手との差\)/ }),
  ).toBeVisible()
  // シルエット係数はどちらもそのままより悪い
  await expect(evaluations.getByRole('row').filter({ hasText: '悪い' })).toHaveCount(2)
})
