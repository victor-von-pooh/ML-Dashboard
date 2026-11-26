import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の値段を変える判断の骨組みと同じ形の評価を
// e2e/make_price.py で書いた確かめ用のプロジェクト (学習率を変えた 2 つの実験)
const PRICE_DIR = path.resolve(import.meta.dirname, '.work', 'price')
const SLOW = 'units_price/2026-11-26/11-00-00'
const FAST = 'units_price/2026-11-26/11-10-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === PRICE_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: PRICE_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('売れた数の平均絶対誤差の学習曲線に, 監視する指標と小さいほど良いを添える', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${SLOW}`)
  const chart = page.getByRole('img', { name: 'mae のエポックごとの推移' })
  await expect(chart).toBeVisible()
  const card = page.locator('section').filter({ has: chart })
  await expect(card.getByText('小さいほど良い', { exact: true })).toBeVisible()
  await expect(card.getByText('監視する指標')).toBeVisible()
})

test('評価のタブで, 変える割合の候補と上限 (%) と読み方, 日本語の名前と向きを出す', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${SLOW}`)
  await page.getByRole('tab', { name: /評価/ }).click()

  const note = page.getByRole('region', { name: '値段を変える判断の評価の読み方' })
  await expect(note.getByText('変える割合の候補', { exact: true })).toBeVisible()
  await expect(note.getByText('-10 %, -5 %, 0 %, +5 %, +10 %', { exact: true })).toBeVisible()
  await expect(note.getByText('値段を変える幅の上限 (守る指標)', { exact: true })).toBeVisible()
  await expect(note.getByText('10 %', { exact: true })).toBeVisible()
  await expect(note.getByText(/今の値段を 1 % 上げたときに予測した売れた数が何 %/)).toBeVisible()
  await expect(note.getByText(/利益は \(値段 − 原価\) × 売れた数/)).toBeVisible()
  await expect(note.getByText(/予測した売れた数から数えた見込み/)).toBeVisible()

  // 売れた数の予測の誤差と見込みの利益の表 (比と上限は % で書く)
  const table = page.locator('section').filter({ hasText: 'price_test' })
  await expect(table.getByText('売れた数の予測の誤差と見込みの利益')).toBeVisible()
  await expect(
    table.getByRole('columnheader', { name: /^売れた数の平均絶対誤差\s*mae \(小さいほど良い\)$/ }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^見込みの利益の差\s*profit_gain \(大きいほど良い\)$/,
    }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^見込みの利益の比\s*profit_ratio \(大きいほど良い\)$/,
    }),
  ).toBeVisible()
  // 弾力性は向きを持たない読み取りの値
  await expect(
    table.getByRole('columnheader', { name: /^値段の弾力性の平均\s*elasticity$/ }),
  ).toBeVisible()
  await expect(table.getByRole('cell', { name: '103.43 %' })).toBeVisible()
  await expect(table.getByRole('cell', { name: '10 %' })).toBeVisible()
})

test('一覧と比較で, テスト用の売れた数の誤差と見込みの利益の比で実験を並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  // 向きの分かる列 (売れた数の誤差と見込みの利益の差) を, 行の数より先に並べる
  const headers = page.getByRole('columnheader', { name: /price_test/ })
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(0)).toContainText('売れた数の平均絶対誤差')
  await expect(headers.nth(1)).toContainText('売れた数の二乗平均平方根誤差')
  await expect(headers.nth(2)).toContainText('見込みの利益の差')
  // 見出しに良い向きを添える
  await expect(headers.nth(0)).toContainText('(小さいほど良い)')
  await expect(headers.nth(2)).toContainText('(大きいほど良い)')
  await expect(page.getByRole('row', { name: SLOW })).toContainText('1.284')
  await expect(page.getByRole('row', { name: FAST })).toContainText('1.512')

  // 初めに押すと良い順 (誤差は小さい順)
  await headers.nth(0).getByRole('button').click()
  await expect(page).toHaveURL(/sort=ev%3Aprice_test%3Amae/)
  const rows = page.getByRole('row').filter({ hasText: 'units_price' })
  await expect(rows.nth(0)).toContainText('1.284')
  await expect(rows.nth(1)).toContainText('1.512')

  const checkboxes = page.getByRole('checkbox', { name: /を比較に選ぶ/ })
  await expect(checkboxes).toHaveCount(2)
  for (const index of [0, 1]) {
    await checkboxes.nth(index).click()
    await expect(checkboxes.nth(index)).toBeChecked()
  }
  await page.getByRole('button', { name: /^比較/ }).click()
  await expect(page.getByRole('heading', { name: '実験の比較' })).toBeVisible()
  const evaluations = page.locator('section', {
    has: page.getByRole('heading', { name: /^テスト用の評価/ }),
  })
  const ratio = evaluations.getByRole('columnheader', { name: /見込みの利益の比/ })
  await expect(ratio).toBeVisible()
  await expect(ratio).toContainText('(大きいほど良い)')
  await expect(
    evaluations.getByRole('columnheader', { name: /売れた数の平均絶対誤差/ }),
  ).toContainText('(小さいほど良い)')
  await expect(evaluations.locator('[title*="100 % は変わらない"]').first()).toBeVisible()
  // 比較では見込みの利益の比の見出しで良い順 (大きい順) に並べる
  await ratio.getByRole('button').click()
  await expect(ratio).toHaveAttribute('aria-sort', 'descending')
  const compared = evaluations.getByRole('row').filter({ hasText: 'units_price' })
  await expect(compared.nth(0)).toContainText('1.047')
  await expect(compared.nth(1)).toContainText('1.034')
})
