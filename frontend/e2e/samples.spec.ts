import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が写し, ML-Found の save_sample で見本を書いた確かめ用のプロジェクト
const SAMPLES_DIR = path.resolve(import.meta.dirname, '.work', 'samples')
const CURRENT_RUN = 'shapes/2026-11-21/10-00-00'
const NEWER_RUN = 'shapes/2026-11-21/11-00-00'

let projectId = ''

test.beforeAll(async ({ request }) => {
  const listed = await request.get('/api/projects')
  const projects = (await listed.json()) as { id: string; path: string }[]
  const found = projects.find((project) => project.path === SAMPLES_DIR)
  if (found) {
    projectId = found.id
    return
  }
  const created = await request.post('/api/projects', { data: { path: SAMPLES_DIR } })
  expect(created.status()).toBe(201)
  projectId = ((await created.json()) as { id: string }).id
})

test('領域の見本を絵と凡例で見る', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${CURRENT_RUN}`)
  await page.getByRole('tab', { name: /見本/ }).click()

  // 色分けした絵が読み込まれ, 番号の表から作った凡例が番号の順に並ぶ
  const image = page.getByRole('img', { name: /^segment のエポック 2 \(領域を色分けした絵\)$/ })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((node: { naturalWidth: number }) => node.naturalWidth))
    .toBe(16)
  const legend = page.getByRole('list', { name: 'segment の領域の凡例' })
  const rows = legend.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('background')
  await expect(rows.nth(1)).toContainText('road')
  await expect(rows.nth(1)).toContainText('#800000')
  await expect(rows.nth(2)).toContainText('名前なし')

  // 名前を渡さなかった見本も, 書いた番号の凡例を出す
  await expect(page.getByRole('list', { name: 'segment_plain の領域の凡例' })).toBeVisible()
})

test('点群の見本を元の座標と正規化した座標で見る', async ({ page, request }) => {
  await page.goto(`/projects/${projectId}/runs/${CURRENT_RUN}`)
  await page.getByRole('tab', { name: /見本/ }).click()

  // 開いたときは元の座標で, 軸に単位を添える
  await expect(
    page.getByRole('img', { name: 'shape の点群を上から見た図 (元の座標)' }),
  ).toBeVisible()
  await expect(page.getByText(/x \(m\) を横, y \(m\) を縦/)).toBeVisible()
  const group = page.getByRole('group', { name: 'shape の点群の座標' })
  await group.getByRole('button', { name: '正規化した座標' }).click()
  await expect(
    page.getByRole('img', { name: 'shape の点群を上から見た図 (正規化した座標)' }),
  ).toBeVisible()
  await expect(group.getByRole('button', { name: '正規化した座標' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // 元の座標は ML-Found の original_coordinates (値 × scale - shift) の値
  const response = await request.get(
    `/api/projects/${projectId}/runs/${CURRENT_RUN}/samples/cloud`,
    { params: { path: 'samples/shape/final.ply' } },
  )
  const cloud = (await response.json()) as {
    points: number[][]
    original: number[][]
    units: string
  }
  expect(cloud.units).toBe('m')
  expect(cloud.points[0]).toEqual([-1, -1, 0])
  expect(cloud.original[0]).toEqual([8, -2, 0])
})

test('新しい版の一覧の点群は, 元の座標に戻せないと出す', async ({ page }) => {
  await page.goto(`/projects/${projectId}/runs/${NEWER_RUN}`)
  await page.getByRole('tab', { name: /見本/ }).click()
  await expect(page.getByText(/元の座標に\s*戻せません/)).toBeVisible()
  await expect(page.getByRole('img', { name: 'shape の点群を上から見た図' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'shape の点群の座標' })).toHaveCount(0)
})
