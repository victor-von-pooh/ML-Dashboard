import path from 'node:path'

import { expect, test, type APIRequestContext } from '@playwright/test'

// e2e/serve.sh が作ったデモのプロジェクト
const DEMO_DIR = path.resolve(import.meta.dirname, '.work', 'demo')

/** デモのプロジェクトを登録し (登録済みならそのまま), id を返す */
async function registerDemo(request: APIRequestContext): Promise<string> {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === DEMO_DIR)
  if (found) return found.id
  const created = await request.post('/api/projects', { data: { path: DEMO_DIR } })
  expect(created.status()).toBe(201)
  return ((await created.json()) as { id: string }).id
}

// 3 つ目のテストは実験を 1 つ足すので, 書いた順に実行
test.describe.configure({ mode: 'serial' })

let projectId = ''

test.beforeAll(async ({ request }) => {
  projectId = await registerDemo(request)
})

test('プロジェクトから実験の一覧と詳細を開く', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('main').getByRole('link', { name: /^demo/ }).first().click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`))

  // デモの 2 つの実験が完了の状態で並ぶ
  const rows = page.getByRole('checkbox', { name: /を比較に選ぶ/ })
  await expect(rows).toHaveCount(2)
  await expect(page.getByText('完了', { exact: true }).first()).toBeVisible()

  // 実験の詳細では学習曲線と, エポックごとの決定境界の画像を見られる
  await page
    .getByRole('link', { name: /spiral/ })
    .first()
    .click()
  await expect(page.getByRole('tab', { name: /学習曲線/ })).toBeVisible()
  await page.getByRole('tab', { name: /画像の推移/ }).click()
  await expect(page.getByRole('img', { name: /boundary の epoch 3/ })).toBeVisible()
  await page.getByRole('button', { name: '前の画像' }).click()
  await expect(page.getByRole('img', { name: /boundary の epoch 2/ })).toBeVisible()
})

test('2 つの実験を比べ, config の違いと同じエポックの画像を並べる', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  const checkboxes = page.getByRole('checkbox', { name: /を比較に選ぶ/ })
  await expect(checkboxes).toHaveCount(2)
  // 選んだ実験は URL に残すので, 状態は描き直しの後に変わる
  for (const index of [0, 1]) {
    await checkboxes.nth(index).click()
    await expect(checkboxes.nth(index)).toBeChecked()
  }
  await page.getByRole('button', { name: /^比較/ }).click()

  await expect(page.getByRole('heading', { name: '実験の比較' })).toBeVisible()
  await expect(page.getByText('optimizer.name')).toBeVisible()
  await expect(page.getByRole('heading', { name: '画像の比較' })).toBeVisible()
  await expect(page.getByRole('img', { name: /boundary \(epoch 3\)/ })).toHaveCount(2)
})

test('フォームで config を変え, 学習を起動して完了まで見届ける', async ({ page, request }) => {
  // 学習のプロセスの起動 (PyTorch の読み込み) を含むので長めに待機
  test.setTimeout(90_000)
  await page.goto(`/projects/${projectId}/launch`)
  await page
    .getByLabel('experiment の config')
    .selectOption('configs/experiment/examples/quick.yaml')

  // フォームで Optimizer を変えると YAML の欄に書き込まれる
  const editor = page.getByLabel('config の中身')
  await expect(editor).toHaveValue(/epochs: 3/)
  await page.getByRole('combobox', { name: 'Optimizer' }).selectOption('SGD')
  await expect(editor).toHaveValue(/name: SGD/)

  // 範囲の外の値は書き込まず, 理由を表示
  const lr = page.getByLabel('lr', { exact: true })
  await lr.fill('-1')
  await lr.press('Enter')
  await expect(page.getByText('0 以上にしてください')).toBeVisible()
  await expect(editor).not.toHaveValue(/lr: -1/)
  await lr.fill('0.05')
  await lr.press('Enter')
  await expect(editor).toHaveValue(/lr: 0.05/)

  // ML-Found で確かめてから起動し, ジョブの画面で完了を待つ
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await page.getByRole('button', { name: '学習を開始' }).click()
  await expect(page).toHaveURL(/\/jobs\//)
  await expect(page.getByText('完了', { exact: true }).first()).toBeVisible({ timeout: 45_000 })

  // 起動した学習が実験の一覧に加わり, フォームで変えた Optimizer で学習している
  await page.goto(`/projects/${projectId}`)
  await expect(page.getByRole('checkbox', { name: /を比較に選ぶ/ })).toHaveCount(3)
  const runs = (await (await request.get(`/api/projects/${projectId}/runs`)).json()) as {
    id: string
    started_at: string
  }[]
  const newest = runs.toSorted((a, b) => b.started_at.localeCompare(a.started_at))[0]!
  const detail = (await (
    await request.get(`/api/projects/${projectId}/runs/${newest.id}`)
  ).json()) as { config: { optimizer: { name: string } } }
  expect(detail.config.optimizer.name).toBe('SGD')
})
