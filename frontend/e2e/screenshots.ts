// README と操作ガイドの画面の図 (実験の一覧と比較) を撮る. e2e/screenshots.sh が
// デモの実験を作ってダッシュボードを起動してから, node で動かす
import os from 'node:os'
import path from 'node:path'

import { chromium } from '@playwright/test'

const baseURL = process.env.SHOTS_URL ?? 'http://127.0.0.1:8792'
const token = process.env.SHOTS_TOKEN ?? 'shots-token'
const demoDir = process.env.SHOTS_DEMO ?? ''
const imagesDir = path.resolve(import.meta.dirname, '..', '..', 'docs', 'images')
// 図に出すプロジェクトの場所 (作業用のディレクトリの場所を図に写さないため)
const shownDir = '~/ML-Dashboard/demo'

interface Run {
  id: string
  name: string
  started_at: string | null
}

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 900 },
  colorScheme: 'light',
  extraHTTPHeaders: { 'x-dashboard-token': token },
})
const page = await context.newPage()

// デモのプロジェクトを登録し (登録済みならそのまま), 実験を読む
const listed = (await (await context.request.get('/api/projects')).json()) as {
  id: string
  path: string
}[]
let projectId = listed.find((project) => project.path === demoDir)?.id
if (!projectId) {
  const created = await context.request.post('/api/projects', { data: { path: demoDir } })
  projectId = ((await created.json()) as { id: string }).id
}
const runs = (await (await context.request.get(`/api/projects/${projectId}/runs`)).json()) as Run[]

/** 作業用のディレクトリの場所を, 図に出す場所に置き換える */
async function hidePaths(): Promise<void> {
  const home = demoDir.replace(os.homedir(), '~')
  // ブラウザの中で動かす文 (e2e の型検査は DOM の型を持たないので文字で渡す)
  const paths = JSON.stringify([demoDir, home])
  await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const item of ${paths}) {
        if (node.textContent.includes(item))
          node.textContent = node.textContent.replaceAll(item, ${JSON.stringify(shownDir)})
      }
    }
  })()`)
}

/**
 * 画面の中で縦に流れる部分ごと写るように, 窓の高さを中身に合わせる (画面は
 * 窓の高さに収め, 中の部分を流すので, fullPage では下が写らないため)
 */
async function fitHeight(width: number): Promise<void> {
  const height = (await page.evaluate(
    `Math.max(...[...document.querySelectorAll('*')].map((element) => element.scrollHeight))`,
  )) as number
  await page.setViewportSize({ width, height: Math.max(900, height) })
  // グラフを描き直す
  await page.waitForTimeout(1000)
}

// 実験の一覧 (評価の列と守る指標の印. 落ちた実験の印は説明を開く). 評価の列が
// 収まる幅にする
await page.setViewportSize({ width: 1680, height: 900 })
await page.goto(`/projects/${projectId}`)
await page.getByRole('columnheader', { name: '守る指標' }).waitFor()
await page.getByText('学習の準備を確かめています').waitFor({ state: 'hidden' })
const dropped = page.getByRole('button', { name: '守る指標: 落ちた' })
if ((await dropped.count()) > 0) await dropped.first().click()
await hidePaths()
await fitHeight(1680)
await page.screenshot({ path: path.join(imagesDir, 'guide', 'runs.jpg'), quality: 85 })

// 比較 (spiral, spiral_sgd, spiral_small の最新の実験)
const picked = ['spiral', 'spiral_sgd', 'spiral_small'].map(
  (name) => runs.find((run) => run.name === name)?.id,
)
if (picked.some((id) => !id)) throw new Error('spiral, spiral_sgd, spiral_small の実験がありません')
const query = new URLSearchParams(picked.map((id): [string, string] => ['run', id!]))
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(`/projects/${projectId}/compare?${query.toString()}`)
await page.getByRole('heading', { name: 'テスト用の評価' }).waitFor()
await page
  .getByRole('img', { name: /boundary/ })
  .first()
  .waitFor()
await hidePaths()
await fitHeight(1440)
await page.screenshot({ path: path.join(imagesDir, 'compare.png') })

await browser.close()
