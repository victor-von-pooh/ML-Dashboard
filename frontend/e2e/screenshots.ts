// README の画面の図 7 枚 (1600x900 の窓) と操作ガイドの実験の一覧の図を撮る.
// e2e/screenshots.sh がデモの実験を作ってダッシュボードを起動してから, node で動かす
import os from 'node:os'
import path from 'node:path'

import { chromium, type APIRequestContext, type Page } from '@playwright/test'

const baseURL = process.env.SHOTS_URL ?? 'http://127.0.0.1:8792'
const token = process.env.SHOTS_TOKEN ?? 'shots-token'
const demoDir = process.env.SHOTS_DEMO ?? ''
const rlDir = process.env.SHOTS_RL ?? ''
const imagesDir = path.resolve(import.meta.dirname, '..', '..', 'docs', 'images')
// 図に出すプロジェクトの場所 (作業用のディレクトリの場所を図に写さないため)
const shownDirs: [string, string][] = [
  [demoDir, '~/ML-Dashboard/demo'],
  [rlDir, '~/ML-Dashboard/rl'],
  // 学習に使う Python (ダッシュボードの .venv) の場所
  [path.resolve(import.meta.dirname, '..', '..'), '~/ML-Dashboard'],
]
// README の図の窓の大きさ
const WIDTH = 1600
const HEIGHT = 900
// 写ってはいけない注意 (評価を読めない実験. 図の例として誤解を招くため)
const NOTICE_PATTERN = /出していません|読んでいません|出せない実験/

interface Run {
  id: string
  name: string
}

/** 作業用のディレクトリの場所を, 図に出す場所に置き換える */
async function hidePaths(page: Page): Promise<void> {
  // 絶対パスと ~ からのパスの両方を置き換える
  const pairs = shownDirs.flatMap(([dir, shown]) => [
    [dir, shown],
    [dir.replace(os.homedir(), '~'), shown],
  ])
  // ブラウザの中で動かす文 (e2e の型検査は DOM の型を持たないので文字で渡す)
  await page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [item, shown] of ${JSON.stringify(pairs)}) {
        if (node.textContent.includes(item))
          node.textContent = node.textContent.replaceAll(item, shown)
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

/** 窓の大きさを README の図に戻して, 見えている範囲を撮る */
async function shoot(page: Page, name: string): Promise<void> {
  await assertNoNotice(page)
  await hidePaths(page)
  await settle(page)
  await page.screenshot({ path: path.join(imagesDir, name) })
}

/** 実験の詳細のタブの並びを窓の上端まで流し, タブの中身を見せる */
async function showTabs(page: Page): Promise<void> {
  await page.evaluate(`document.querySelector('[role=tablist]').scrollIntoView({ block: 'start' })`)
}

/** プロジェクトを登録し (登録済みならそのまま), id を返す */
async function register(request: APIRequestContext, dir: string): Promise<string> {
  const listed = (await (await request.get('/api/projects')).json()) as {
    id: string
    path: string
  }[]
  const found = listed.find((project) => project.path === dir)
  if (found) return found.id
  const created = await request.post('/api/projects', { data: { path: dir } })
  return ((await created.json()) as { id: string }).id
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
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: 'light',
    extraHTTPHeaders: { 'x-dashboard-token': token },
  })
  const page = await context.newPage()
  const projectId = await register(context.request, demoDir)
  const rlId = await register(context.request, rlDir)
  const runs = (await (
    await context.request.get(`/api/projects/${projectId}/runs`)
  ).json()) as Run[]
  const spiral = runs.find((run) => run.name === 'spiral')
  if (!spiral) throw new Error('spiral の実験がありません')

  // 操作ガイドの実験の一覧 (評価の列と守る指標の印. 落ちた実験の印は説明を開く).
  // 評価の列が収まる幅にし, 高さは中身に合わせる
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
  await page.setViewportSize({ width: WIDTH, height: HEIGHT })

  // 比較 (spiral, spiral_sgd, spiral_small の最新の実験)
  const picked = ['spiral', 'spiral_sgd', 'spiral_small'].map(
    (name) => runs.find((run) => run.name === name)?.id,
  )
  if (picked.some((id) => !id))
    throw new Error('spiral, spiral_sgd, spiral_small の実験がありません')
  const query = new URLSearchParams(picked.map((id): [string, string] => ['run', id!]))
  await page.goto(`/projects/${projectId}/compare?${query.toString()}`)
  await page.getByRole('heading', { name: 'テスト用の評価 (群分けは全ての行で数えた値)' }).waitFor()
  await page
    .getByRole('img', { name: /boundary/ })
    .first()
    .waitFor()
  await shoot(page, 'compare.png')

  // 実験の詳細の評価と見本のタブ (spiral)
  await page.goto(`/projects/${projectId}/runs/${spiral.id}?tab=evaluations`)
  await page.getByRole('img', { name: /threshold の曲線/ }).waitFor()
  await showTabs(page)
  await shoot(page, 'evaluations.png')
  await page.goto(`/projects/${projectId}/runs/${spiral.id}?tab=samples`)
  await page.getByRole('img', { name: 'points の点群を上から見た図' }).waitFor()
  await showTabs(page)
  await shoot(page, 'samples.png')

  // 学習の起動 (T_max: auto と warmup を書いて確かめ, 補う値のお知らせを出す)
  await page.goto(`/projects/${projectId}/launch`)
  await page
    .getByLabel('experiment の config')
    .selectOption('configs/experiment/examples/quick.yaml')
  const editor = page.getByLabel('config の中身')
  await editor.fill(
    'trainer:\n  epochs: 3\nscheduler:\n  name: CosineAnnealingLR\n  interval: step\n' +
      '  params:\n    T_max: auto\n  warmup_ratio: 0.1\n',
  )
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await page.getByText(/読み込めました/).waitFor()
  await shoot(page, 'launch.png')

  // 実行中のジョブ (長い学習を起動し, 数エポック進んだところを撮ってすぐに止める)
  const created = await context.request.post(`/api/projects/${projectId}/jobs`, {
    data: {
      script: 'train.py',
      config_text:
        'experiment:\n  name: spiral_long\ntrainer:\n  epochs: 200\n' +
        'data:\n  train_size: 60000\n',
    },
  })
  if (!created.ok()) throw new Error(`学習を起動できません: ${await created.text()}`)
  const job = (await created.json()) as { id: string }
  try {
    await page.goto(`/jobs/${job.id}`)
    await page
      .getByText(/^[3-9] \/ 200 エポック/)
      .first()
      .waitFor({ timeout: 120_000 })
    await shoot(page, 'jobs.png')
  } finally {
    await context.request.post(`/api/jobs/${job.id}/stop`, {
      data: { force: true },
    })
  }

  // 強化学習の実験の方策のタブと, 追加の依存
  const rlRun = 'cartpole/2026-11-20/10-00-00'
  await page.goto(`/projects/${rlId}/runs/${rlRun}?tab=policy`)
  await page.getByText('一致', { exact: true }).waitFor()
  await page.getByRole('region', { name: '守り付きの評価 guarded_episodes' }).waitFor()
  // 守り付きの評価の割合のカードまで写るように, タブの並びを上端へ
  await showTabs(page)
  await shoot(page, 'policy.png')
  await page.goto(`/projects/${rlId}/requirements`)
  await page.getByRole('region', { name: '追加の依存 cuda' }).waitFor()
  await shoot(page, 'requirements.png')

  console.log(`撮った図: ${imagesDir}`)
} finally {
  await browser.close()
}
