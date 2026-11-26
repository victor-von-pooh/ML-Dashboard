import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の時間をまたぐ量の判断の骨組みと同じ形の評価と発注の数の
// 表を e2e/make_demand.py で書いた確かめ用のプロジェクト (学習率を変えた 2 つの実験)
const DEMAND_DIR = path.resolve(import.meta.dirname, '.work', 'demand')
const SLOW = 'weekly_demand/2026-11-26/09-00-00'
const FAST = 'weekly_demand/2026-11-26/09-10-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === DEMAND_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: DEMAND_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('評価のタブで, 水準と τ と損と上限, 日本語の名前と向き, 発注の数の表を出す', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${SLOW}`)
  await page.getByRole('tab', { name: /評価/ }).click()

  const note = page.getByRole('region', { name: '時間をまたぐ量の判断の評価の読み方' })
  await expect(note.getByText('0.1, 0.5, 0.8, 0.9', { exact: true })).toBeVisible()
  await expect(note.getByText('発注に使う水準 τ', { exact: true })).toBeVisible()
  await expect(note.getByText('0.8', { exact: true })).toBeVisible()
  await expect(note.getByText('発注の数の上限 (守る指標)', { exact: true })).toBeVisible()
  await expect(note.getByText('60', { exact: true })).toBeVisible()
  await expect(note.getByText(/売れる数を在庫の数 \+ 発注の数として/)).toBeVisible()

  // 需要の誤差と発注の数の損の比べ (損の比は % で書く)
  const table = page.locator('section').filter({ hasText: 'demand_test' }).filter({
    hasText: '需要の予測の誤差と発注の数の損',
  })
  await expect(
    table.getByRole('columnheader', { name: /^需要の平均絶対誤差\s*mae \(小さいほど良い\)$/ }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^分位点の損失の平均\s*pinball_loss \(小さいほど良い\)$/,
    }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^発注の数の損の差\s*order_cost_saving \(大きいほど良い\)$/,
    }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^発注の数の損の比\s*order_cost_ratio \(小さいほど良い\)$/,
    }),
  ).toBeVisible()
  // 上限に当たった行の数は向きを持たない
  await expect(
    table.getByRole('columnheader', { name: /^上限に当たった行の数\s*capped$/ }),
  ).toBeVisible()
  await expect(table.getByRole('cell', { name: '76.81 %' })).toBeVisible()

  // 水準ごとの分位点の損失 (水準の数の行)
  const levels = page.locator('section').filter({ hasText: 'demand_levels_test' })
  await expect(levels.getByText('水準ごとの分位点の損失', { exact: true })).toBeVisible()
  await expect(
    levels.getByRole('columnheader', { name: /^分位点の損失\s*loss \(小さいほど良い\)$/ }),
  ).toBeVisible()
  await expect(levels.getByRole('row')).toHaveCount(5)

  // 商品ごとの発注の数の表 (demand_orders.csv)
  const orders = page.getByRole('table', { name: '商品ごとの発注の数' })
  await expect(orders).toBeVisible()
  await expect(orders.getByRole('columnheader', { name: 'order', exact: true })).toBeVisible()
  await expect(orders.getByRole('row')).toHaveCount(4)
  await expect(page.getByRole('link', { name: /demand_orders\.csv をダウンロード/ })).toBeVisible()
})

test('一覧と比較で, テスト用の需要の誤差と発注の数の損の比で実験を並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  // 向きの分かる列 (需要の誤差, 分位点の損失, 発注の数の損) を, 行の数より先に並べる
  const headers = page.getByRole('columnheader', { name: /demand_test/ })
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(0)).toContainText('需要の平均絶対誤差')
  await expect(headers.nth(1)).toContainText('分位点の損失の平均')
  await expect(headers.nth(2)).toContainText('選んだ発注の数での損')
  await expect(headers.nth(0)).toContainText('(小さいほど良い)')
  // 水準ごとの表 (水準の数の行) は列にしない
  await expect(page.getByRole('columnheader', { name: /demand_levels_test/ })).toHaveCount(0)
  await expect(page.getByRole('row', { name: SLOW })).toContainText('3.421')
  await expect(page.getByRole('row', { name: FAST })).toContainText('4.087')

  // 初めに押すと良い順 (誤差は小さい順)
  await headers.nth(0).getByRole('button').click()
  await expect(page).toHaveURL(/sort=ev%3Ademand_test%3Amae/)
  const rows = page.getByRole('row').filter({ hasText: 'weekly_demand' })
  await expect(rows.nth(0)).toContainText('3.421')
  await expect(rows.nth(1)).toContainText('4.087')

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
  const ratio = evaluations.getByRole('columnheader', { name: /発注の数の損の比/ })
  await expect(ratio).toBeVisible()
  await expect(ratio).toContainText('(小さいほど良い)')
  await expect(evaluations.getByRole('columnheader', { name: /発注の数の損の差/ })).toContainText(
    '(大きいほど良い)',
  )
  await expect(evaluations.locator('[title*="100 % は変わらない"]').first()).toBeVisible()
  // 比較では発注の数の損の比の見出しで良い順 (小さい順) に並べる
  await ratio.getByRole('button').click()
  await expect(ratio).toHaveAttribute('aria-sort', 'ascending')
  const compared = evaluations.getByRole('row').filter({ hasText: 'weekly_demand' })
  await expect(compared.nth(0)).toContainText('0.768')
  await expect(compared.nth(1)).toContainText('0.857')
})
