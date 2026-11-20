import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写した強化学習の確かめ用のプロジェクト (学習せずに置いた実験を持つ)
// CI には Gymnasium を入れないので, config の requires: [rl] は足りない
const RL_DIR = path.resolve(import.meta.dirname, '.work', 'rl')
const RUN_ID = 'cartpole/2026-11-20/10-00-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === RL_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: RL_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('強化学習の指標を学習曲線で見て, 方策の守りを確かめる', async ({ page, request }) => {
  await page.goto(`/projects/${projectId}/runs/${RUN_ID}`)
  // source.yaml の無い実験は, もう一度の起動の理由に条件だけを出す
  await expect(page.getByText(/source\.yaml\) が記録されていない実験です$/)).toBeVisible()

  // 報酬, 歩数, 違反, 成功はただの指標として曲線に並び, valid/reward を監視する
  for (const metric of ['reward', 'length', 'violations', 'success']) {
    await expect(page.getByRole('img', { name: `${metric} のエポックごとの推移` })).toBeVisible()
  }
  await expect(page.getByText('監視する指標').first()).toBeVisible()

  // 方策のタブ: 人が承認する旨, 外れたときの動き, 止める条件, 重みの sha256
  await page.getByRole('tab', { name: '方策' }).click()
  await expect(page).toHaveURL(/tab=policy/)
  await expect(page.getByRole('note')).toContainText('実機での実行は道具の外')
  await expect(page.getByRole('note')).toContainText('人が承認')
  await expect(page.getByText('元の制御に戻す (行動を返さない)')).toBeVisible()
  const observation = page.getByRole('table', { name: '観測の要素ごとの範囲と止める条件' })
  await expect(observation.getByRole('row')).toHaveCount(5)
  await expect(observation.getByRole('row').nth(1)).toContainText('-2.4')
  await expect(page.getByText('一致', { exact: true })).toBeVisible()
  await expect(page.locator('pre').filter({ hasText: 'CartPole-v1' })).toBeVisible()

  // 重みは配らない: ファイルの一覧にダウンロードのリンクが無く, API も返さない
  await page.getByRole('tab', { name: /ファイル/ }).click()
  await expect(page.getByText('policy/policy.pt は配りません')).toBeAttached()
  await expect(page.getByRole('link', { name: 'policy/policy.pt をダウンロード' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'policy/policy.json をダウンロード' })).toBeVisible()
  const weights = await request.get(
    `/api/projects/${projectId}/runs/${RUN_ID}/files/policy/policy.pt`,
  )
  expect(weights.status()).toBe(403)
})

test('足りない追加の依存のカードを見て, 学習の開始が止まる', async ({ page }) => {
  // 実験の一覧から追加の依存の一覧を開く
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('link', { name: '追加の依存' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/requirements$`))
  for (const name of ['rl', 'mujoco', 'ros2', 'cuda']) {
    await expect(page.getByRole('region', { name: `追加の依存 ${name}` })).toBeVisible()
  }
  const ros2 = page.getByRole('region', { name: '追加の依存 ros2' })
  await expect(ros2.getByRole('link', { name: /公式の手順/ })).toHaveAttribute(
    'href',
    'https://docs.ros.org/',
  )
  await page.getByRole('button', { name: '確かめ直す' }).click()
  await expect(page.getByRole('button', { name: '確かめ直す' })).toBeEnabled()

  // 学習の起動: requires: [rl] が足りないので, カードと次の一手が出て開始できない
  await page.getByRole('link', { name: '学習を起動' }).click()
  const rl = page.getByRole('region', { name: '追加の依存 rl' })
  await expect(rl).toBeVisible()
  await expect(page.getByText('足りない追加の依存があるので開始できません')).toBeVisible()
  await expect(rl.getByText('pip install "gymnasium>=1.0"')).toBeVisible()
  await expect(rl.getByRole('button', { name: 'rl の pip のコマンド をコピー' })).toBeVisible()
  await expect(page.getByRole('button', { name: '学習を開始' })).toBeDisabled()

  // experiment の config で requires を空にすれば開始できる
  await page.getByLabel('config の中身').fill('requires: []\n')
  await expect(page.getByRole('button', { name: '学習を開始' })).toBeEnabled()
  await expect(rl).toHaveCount(0)

  // 戻すと再び止まり, 確かめのボタンも次の一手を誤りとして出す
  await page.getByLabel('config の中身').fill('requires: [rl]\n')
  await expect(page.getByRole('button', { name: '学習を開始' })).toBeDisabled()
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'pip install' })).toBeVisible()
})
