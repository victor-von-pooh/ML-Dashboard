// README と操作ガイドの画面の図 (実験の一覧と比較) を撮る. e2e/screenshots.sh が
// デモの実験を作ってダッシュボードを起動してから, node で動かす
import os from 'node:os'
import path from 'node:path'

import { chromium, type Page } from '@playwright/test'

const baseURL = process.env.SHOTS_URL ?? 'http://127.0.0.1:8792'
const token = process.env.SHOTS_TOKEN ?? 'shots-token'
const demoDir = process.env.SHOTS_DEMO ?? ''
const imagesDir = path.resolve(import.meta.dirname, '..', '..', 'docs', 'images')
// 図に出すプロジェクトの場所 (作業用のディレクトリの場所を図に写さないため)
const shownDir = '~/ML-Dashboard/demo'
// 写ってはいけない注意 (評価を読めない実験. 図の例として誤解を招くため)
const NOTICE_PATTERN = /出していません|読んでいません|出せない実験/

interface Run {
  id: string
  name: string
}

/** 作業用のディレクトリの場所を, 図に出す場所に置き換える */
async function hidePaths(page: Page): Promise<void> {
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

/** 描き終わるまで (2 回の描画の区切りまで) 待つ */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
}

/**
 * 画面の中で縦に流れる部分ごと写るように, 窓の高さを中身に合わせる (画面は
 * 窓の高さに収め, 中の部分を流すので, fullPage では下が写らないため)
 */
async function fitHeight(page: Page, width: number): Promise<void> {
  const height = (await page.evaluate(
    `Math.max(...[...document.querySelectorAll('*')].map((element) => element.scrollHeight))`,
  )) as number
  await page.setViewportSize({ width, height: Math.max(900, height) })
  await settle(page)
}

/** 写ってはいけない注意があれば止める */
async function assertNoNotice(page: Page): Promise<void> {
  const count = await page.getByText(NOTICE_PATTERN).count()
  if (count > 0) throw new Error('評価を読めない注意が出ているので, 図を撮りません')
}

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
try {
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
  const runs = (await (
    await context.request.get(`/api/projects/${projectId}/runs`)
  ).json()) as Run[]

  // 実験の一覧 (評価の列と守る指標の印. 落ちた実験の印は説明を開く). 評価の列が
  // 収まる幅にする
  const listWidth = 1680
  await page.setViewportSize({ width: listWidth, height: 900 })
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('columnheader', { name: '守る指標' }).waitFor()
  await page.getByText('学習の準備を確かめています').waitFor({ state: 'hidden' })
  await assertNoNotice(page)
  await hidePaths(page)
  await fitHeight(page, listWidth)
  // 窓の大きさを変えると説明は閉じるので, 合わせた後に開く
  const dropped = page.getByRole('button', { name: '守る指標: 落ちた' })
  if ((await dropped.count()) === 0) throw new Error('「落ちた」の印のある実験がありません')
  await dropped.first().click()
  await page.getByText(/^落ちた: /).waitFor()
  // 学習の準備のカード (作業用のディレクトリの環境の注意) と, その下の間より下だけを写す
  const main = await page.getByRole('main').boundingBox()
  const readiness = await page
    .locator('section', { has: page.getByRole('heading', { name: '学習の準備' }) })
    .boundingBox()
  if (!main) throw new Error('一覧の画面が見つかりません')
  const top = readiness ? readiness.y + readiness.height + 12 : main.y
  await page.screenshot({
    path: path.join(imagesDir, 'guide', 'runs.jpg'),
    quality: 85,
    clip: { x: main.x, y: top, width: main.width, height: main.y + main.height - top },
  })

  // 比較 (spiral, spiral_sgd, spiral_small の最新の実験)
  const picked = ['spiral', 'spiral_sgd', 'spiral_small'].map(
    (name) => runs.find((run) => run.name === name)?.id,
  )
  if (picked.some((id) => !id))
    throw new Error('spiral, spiral_sgd, spiral_small の実験がありません')
  const query = new URLSearchParams(picked.map((id): [string, string] => ['run', id!]))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/projects/${projectId}/compare?${query.toString()}`)
  await page.getByRole('heading', { name: 'テスト用の評価' }).waitFor()
  await page
    .getByRole('img', { name: /boundary/ })
    .first()
    .waitFor()
  await assertNoNotice(page)
  await hidePaths(page)
  await fitHeight(page, 1440)
  await page.screenshot({ path: path.join(imagesDir, 'compare.png') })

  console.log(
    `撮った図: ${path.join(imagesDir, 'guide', 'runs.jpg')}, ${path.join(imagesDir, 'compare.png')}`,
  )
} finally {
  await browser.close()
}
