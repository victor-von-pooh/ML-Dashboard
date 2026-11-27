import path from 'node:path'

import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

// e2e/serve.sh が ML-Pathfinder の置き場に記録した, 問題の設定 sales のプロジェクト
const EXPORTED_DIR = path.resolve(import.meta.dirname, '.work', 'exported')

// 単独の起動は殻で選んだ問題の設定を持たないので, 殻の下に載せた形の根の部品を
// 開発用のサーバー (e2e/stage/) で描き, API は起動したダッシュボードへ転送する
let server: ViteDevServer
let stageUrl: string

test.beforeAll(async () => {
  const backend = String(test.info().project.use.baseURL)
  server = await createServer({
    configFile: path.resolve(import.meta.dirname, '..', 'vite.config.ts'),
    root: path.resolve(import.meta.dirname, 'stage'),
    // 手元で動かす開発用のサーバーと前処理の置き場を分ける
    cacheDir: path.resolve(import.meta.dirname, '..', 'node_modules', '.vite-stage'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': backend } },
  })
  await server.listen()
  stageUrl = server.resolvedUrls!.local[0]!
})

test.afterAll(async () => {
  await server?.close()
})

test('殻の下に載せた形で, 記録したプロジェクトの場所を役割と名前で選べる', async ({ page }) => {
  await page.goto(new URL('train?project=sales', stageUrl).href)
  const card = page.getByRole('region', { name: '選んだ問題の設定' })
  await expect(card).toContainText('e2e の売上')

  // 殻の通しの確かめと同じ選び方. 名前は Chromium の読み上げの木から計算する
  const place = card.getByRole('group', { name: '記録したプロジェクト' })
  await expect(place).toBeVisible()
  await expect(place).toHaveText(`記録したプロジェクト: ${EXPORTED_DIR}`)
  // 読み上げではラベルと値を読み, 見た目の区切りの「:」は読まない
  await expect(place).toMatchAriaSnapshot(`
    - group "記録したプロジェクト":
      - text: ${JSON.stringify(`記録したプロジェクト ${EXPORTED_DIR}`)}
  `)
})
