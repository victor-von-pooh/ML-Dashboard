import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Quest の異常の検知の骨組みと同じ形の評価を
// e2e/make_anomaly.py で書いた確かめ用のプロジェクト (自己符号化器の実験と,
// run.json と history.csv とモデルの定義の記録が無く推論の一式を持つ, 学習しない
// 距離に基づく度合いの実験)
const ANOMALY_DIR = path.resolve(import.meta.dirname, '.work', 'anomaly')
const AUTOENCODER = 'anomaly_autoencoder/2026-11-25/10-00-00'
const DISTANCE = 'anomaly_distance/2026-11-25/10-10-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === ANOMALY_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: ANOMALY_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('評価のタブで, K と人が確かめる件数の上限と, 度合いの分布と上位の行の要約を出す', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${DISTANCE}`)
  // 学習の記録が無い実験は, 学習曲線の代わりに評価のタブへ案内する
  await expect(
    page.getByText(/学習の記録 \(run\.json と history\.csv\) が無い実験です/),
  ).toBeVisible()
  await page.getByRole('tab', { name: /評価/ }).click()

  const note = page.getByRole('region', { name: '異常の検知の評価の読み方' })
  await expect(note.getByText('学習用の正常の行の中心からの距離')).toBeVisible()
  await expect(note.getByText('上位の件数 K', { exact: true })).toBeVisible()
  await expect(note.getByText('10 件')).toBeVisible()
  await expect(note.getByText('人が 1 回に確かめる件数の上限', { exact: true })).toBeVisible()
  await expect(note.getByText('20 件')).toBeVisible()

  // 異常の行のある分割: 上位 K 件の適合率と PR-AUC (大きいほど良い)
  const test_ = page.locator('section').filter({ hasText: 'anomaly_test' })
  await expect(test_.getByText('上位 K 件の適合率と PR-AUC')).toBeVisible()
  await expect(
    test_.getByRole('columnheader', {
      name: /^上位 K 件の適合率\s*precision_at_k \(大きいほど良い\)$/,
    }),
  ).toBeVisible()
  await expect(
    test_.getByRole('columnheader', { name: /^PR-AUC\s*average_precision \(大きいほど良い\)$/ }),
  ).toBeVisible()
  await expect(test_.getByRole('columnheader', { name: /^上位の件数 K\s*k$/ })).toBeVisible()

  // 異常の正解の無い分割: 度合いの分布の曲線と, 上位 K 行の要約
  const scores = page.locator('section').filter({ hasText: 'anomaly_scores_unlabeled' })
  await expect(scores.getByText('度合いの分布')).toBeVisible()
  await expect(scores.getByRole('img', { name: /anomaly_scores_unlabeled の曲線/ })).toBeVisible()
  const top = page.locator('section').filter({ hasText: 'anomaly_top_unlabeled' })
  await expect(top.getByText('上位の行の要約')).toBeVisible()
  await expect(top.getByRole('columnheader', { name: /^最も外れた列\s*column$/ })).toBeVisible()
  await expect(
    top.getByRole('columnheader', { name: /^その列の分の割合\s*column_share$/ }),
  ).toBeVisible()
  await expect(top.getByRole('row')).toHaveCount(11)
})

test('自己符号化器と距離に基づく度合いを, 一覧と比較で上位 K 件の適合率と PR-AUC で並べる', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}`)
  // 向きの分かる列 (上位 K 件の適合率と PR-AUC) を, 行の数や K より先に並べる
  const headers = page.getByRole('columnheader', { name: /anomaly_test/ })
  await expect(headers).toHaveCount(3)
  await expect(headers.nth(0)).toContainText('上位 K 件の適合率')
  await expect(headers.nth(1)).toContainText('PR-AUC')
  await expect(page.getByRole('row', { name: DISTANCE })).toContainText('0.741')
  await expect(page.getByRole('row', { name: AUTOENCODER })).toContainText('0.664')

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
  await expect(evaluations.getByRole('columnheader', { name: /上位 K 件の適合率/ })).toBeVisible()
  await expect(evaluations.locator('[title*="異常の割合が小さいと低く出る"]')).toBeVisible()
  await expect(evaluations.getByRole('columnheader', { name: /上位の件数 K/ })).toBeVisible()
})

test('モデルの定義が無く推論の一式を持つ実験に, 実験の一覧から登録する案内だけを出す', async ({
  page,
}) => {
  await page.goto(`/projects/${projectId}/runs/${DISTANCE}`)
  await page.getByText('この実験を推論の段階で使うには').click()
  await expect(page.getByText(/ML-Provide の「実験の一覧から登録」で登録できます/)).toBeVisible()
  await expect(page.getByText(/学習の結果から作る/)).toHaveCount(0)
  await expect(page.getByText(/model\.spec は変わりません/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /実験のディレクトリの場所/ })).toBeVisible()
  await expect(page.locator('code').filter({ hasText: new RegExp(`${DISTANCE}$`) })).toBeVisible()
})
