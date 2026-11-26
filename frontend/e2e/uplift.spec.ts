import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の効果の見積もりの骨組みと同じ形の評価を
// e2e/make_uplift.py で書いた確かめ用のプロジェクト (学習率を変えた 2 つの実験)
const UPLIFT_DIR = path.resolve(import.meta.dirname, '.work', 'uplift')
const SLOW = 'purchased_uplift/2026-11-25/11-00-00'
const FAST = 'purchased_uplift/2026-11-25/11-10-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === UPLIFT_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: UPLIFT_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('Qini の係数の学習曲線に, 日本語の説明と監視する指標の向きを添える', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${SLOW}`)
  const chart = page.getByRole('img', { name: 'qini のエポックごとの推移' })
  await expect(chart).toBeVisible()
  const card = page.locator('section').filter({ has: chart })
  await expect(card.getByText(/^Qini の係数 \(効果の見積もりの高い順の並びの良さ/)).toBeVisible()
  await expect(card.getByText('大きいほど良い', { exact: true })).toBeVisible()
  await expect(card.getByText('監視する指標')).toBeVisible()
})

test('評価のタブで, K と配る数の上限と読み方, Qini の曲線とでたらめに配る線を出す', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${SLOW}`)
  await page.getByRole('tab', { name: /評価/ }).click()

  const note = page.getByRole('region', { name: '効果の見積もりの評価の読み方' })
  await expect(note.getByText('上位の割合 K', { exact: true })).toBeVisible()
  await expect(note.getByText('上位 30 %', { exact: true })).toBeVisible()
  await expect(note.getByText('配る数の上限 (守る指標)', { exact: true })).toBeVisible()
  await expect(note.getByText('500 件')).toBeVisible()
  await expect(note.getByText(/処置の群は処置した行, 対照の群は処置しなかった行/)).toBeVisible()
  await expect(note.getByText(/正解の効果は顧客ごとには見えません/)).toBeVisible()

  // Qini の係数と上位 K 割の効果の差の表 (どちらも大きいほど良い. K は % で書く)
  const table = page.locator('section').filter({ hasText: 'uplift_test' })
  await expect(table.getByText('Qini の係数と上位 K 割の効果の差')).toBeVisible()
  await expect(
    table.getByRole('columnheader', { name: /^Qini の係数\s*qini \(大きいほど良い\)$/ }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', {
      name: /^上位 K 割の効果の差\s*uplift_at_k \(大きいほど良い\)$/,
    }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', { name: /^処置の群の行の数\s*treated$/ }),
  ).toBeVisible()
  await expect(
    table.getByRole('columnheader', { name: /^対照の群の行の数\s*control$/ }),
  ).toBeVisible()
  await expect(table.getByRole('cell', { name: '上位 30 %' })).toBeVisible()

  // Qini の曲線: Qini の値とでたらめに配る線 (上位の行の数は目盛りが違うので描かない)
  const curve = page.locator('section').filter({ hasText: 'qini_curve_test' })
  await expect(curve.getByText('Qini の曲線', { exact: true })).toBeVisible()
  await expect(
    curve.getByRole('img', {
      name: 'qini_curve_test の曲線 (横軸 fraction. 系列: Qini の値 (qini), でたらめに配る線 (random))',
    }),
  ).toBeVisible()
})

test('一覧と比較で, テスト用の Qini の係数で実験を並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  // 向きの分かる列 (Qini の係数と上位 K 割の効果の差) を, 行の数より先に並べる
  const headers = page.getByRole('columnheader', { name: /uplift_test/ })
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(0)).toContainText('Qini の係数')
  await expect(headers.nth(1)).toContainText('上位 K 割の効果の差')
  await expect(page.getByRole('row', { name: SLOW })).toContainText('0.2103')
  await expect(page.getByRole('row', { name: FAST })).toContainText('0.1534')

  // 初めに押すと良い順 (大きい順)
  await headers.nth(0).getByRole('button').click()
  await expect(page).toHaveURL(/sort=ev%3Auplift_test%3Aqini/)
  const rows = page.getByRole('row').filter({ hasText: 'purchased_uplift' })
  await expect(rows.nth(0)).toContainText('0.2103')
  await expect(rows.nth(1)).toContainText('0.1534')

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
  const qini = evaluations.getByRole('columnheader', { name: /Qini の係数/ })
  await expect(qini).toBeVisible()
  await expect(evaluations.locator('[title*="1 は理想の並び"]').first()).toBeVisible()
  // 比較でも Qini の係数の見出しで良い順に並べる
  await qini.getByRole('button').click()
  await expect(qini).toHaveAttribute('aria-sort', 'descending')
  const compared = evaluations.getByRole('row').filter({ hasText: 'purchased_uplift' })
  await expect(compared.nth(0)).toContainText('0.2103')
  await expect(compared.nth(1)).toContainText('0.1534')
})
