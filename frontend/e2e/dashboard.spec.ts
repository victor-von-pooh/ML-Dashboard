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

  // テスト用の評価の列と守る指標の印. 3 エポックの実験は, どちらも比べる相手
  // (先頭 20 点の最近傍の規則) よりクラスの正解率が落ちる
  await expect(page.getByRole('columnheader', { name: '守る指標' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /accuracy_diff/ })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '落ちた' })).toHaveCount(2)
  // 印を押すと, 落ちた指標の説明が開く
  const badge = page.getByRole('button', { name: '守る指標: 落ちた' }).first()
  await badge.click()
  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText(/^落ちた: by_class_test/)).toBeVisible()
  // 説明の文を押しても (文を選ぶため) 閉じない
  await page.getByText(/^落ちた: by_class_test/).click()
  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(badge).toHaveAttribute('aria-expanded', 'false')
  // 守る指標の印と評価の値で絞り込む
  await page.getByRole('button', { name: /^落ちた/ }).click()
  await expect(page).toHaveURL(/guard=dropped/)
  await expect(rows).toHaveCount(2)
  await page.getByRole('button', { name: /^落ちた/ }).click()
  const search = page.getByPlaceholder(/絞り込/).first()
  await search.fill('accuracy_diff>1')
  await expect(page.getByText('条件に合う実験はありません.')).toBeVisible()
  await search.fill('')
  await expect(rows).toHaveCount(2)

  // 絞り込みの文字は URL に残り, 詳細を開いて戻っても同じ
  await page
    .getByRole('searchbox')
    .or(page.getByPlaceholder(/絞り込/))
    .first()
    .fill('sgd')
  await expect(page).toHaveURL(/q=sgd/)
  await page.goBack()
  await page.goForward()
  await expect(
    page
      .getByRole('searchbox')
      .or(page.getByPlaceholder(/絞り込/))
      .first(),
  ).toHaveValue('sgd')
  await page
    .getByRole('searchbox')
    .or(page.getByPlaceholder(/絞り込/))
    .first()
    .fill('')
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

test('学習の準備のカードで, 環境を作る前に動かすコマンドを確かめる', async ({ page }) => {
  await page.goto(`/projects/${projectId}`)
  const card = page.locator('section', {
    has: page.getByRole('heading', { name: '学習の準備' }),
  })
  // デモは .venv を持たないので, 作るボタンが出る (入れるのはネットワークを使うので確かめだけ)
  const items = page.getByRole('list', { name: '学習の準備の項目' })
  await expect(items.getByText('プロジェクトの .venv がまだありません')).toBeVisible()
  await expect(items.getByText(/default の config に data.dataset がありません/)).toBeVisible()
  await page.getByRole('button', { name: '環境を作る' }).click()
  const confirm = page.getByRole('region', { name: '入れる内容の確認' })
  await expect(confirm.getByText(/ml-found @ git\+https/)).toBeVisible()
  await expect(confirm.getByText(/学習に使う Python を/)).toBeVisible()
  await confirm.getByRole('button', { name: 'やめる' }).click()
  await expect(confirm).toBeHidden()
  await expect(card.getByRole('button', { name: '環境を作る' })).toBeVisible()
})

test('何の実験か, データ全体の評価, 見本を見る', async ({ page, request }) => {
  // デモの学習は, 学習の後に task.yaml, evaluations/, samples/ を書く
  const listed = await request.get(`/api/projects/${projectId}/runs`)
  const runs = (await listed.json()) as { id: string }[]
  await page.goto(`/projects/${projectId}/runs/${runs[0]!.id}`)

  await expect(page.getByRole('heading', { name: '何の実験か' })).toBeVisible()
  await expect(page.getByText('予測する (predict)')).toBeVisible()
  await expect(page.getByText('作った正確な正解 (synthetic)')).toBeVisible()

  // 評価: 守る指標の表を先頭に, しきい値の曲線
  await page.getByRole('tab', { name: /評価/ }).click()
  await expect(page.getByText('守る指標').first()).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'acc', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('img', { name: /threshold の曲線/ })).toBeVisible()

  // 見本: 点群を上から見た図と, 学習の後の要約の文
  await page.getByRole('tab', { name: /見本/ }).click()
  await expect(page.getByRole('img', { name: 'points の点群を上から見た図' })).toBeVisible()
  await expect(page.getByText(/を正しく分けた/)).toBeVisible()
  await expect(page.getByText('学習の後の予測の要約')).toBeVisible()
  // 直下の番号付きの画像の置き場所は, 今の形の名前で案内する
  await expect(page.getByText(/samples\/ の直下の番号付きの画像/)).toBeVisible()
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
  // テスト用の評価の値と守る指標の印も並ぶ
  const evaluations = page.locator('section', {
    has: page.getByRole('heading', { name: 'テスト用の評価 (群分けは全ての行で数えた値)' }),
  })
  await expect(evaluations.getByRole('row').filter({ hasText: '落ちた' })).toHaveCount(2)
  // 評価の列の並べ替えは URL に残り, 読み直しても同じ
  const header = evaluations.getByRole('columnheader', { name: /accuracy_diff/ })
  await header.getByRole('button').click()
  await expect(page).toHaveURL(/sort=ev%3A/)
  await expect(header).not.toHaveAttribute('aria-sort', 'none')
  await page.reload()
  await expect(header).not.toHaveAttribute('aria-sort', 'none')
  await expect(page.getByRole('heading', { name: '画像の比較' })).toBeVisible()
  await expect(page.getByRole('img', { name: /boundary \(epoch 3\)/ })).toHaveCount(2)
})

test('実験の詳細から, 同じ設定を入れた学習の起動の画面を開く', async ({ page, request }) => {
  // quick_sgd.yaml で流した実験 (ML-Found の source.yaml から探す)
  const listed = await request.get(`/api/projects/${projectId}/runs`)
  const runs = (await listed.json()) as { id: string; source: { experiment?: string } | null }[]
  const run = runs.find((item) => item.source?.experiment?.endsWith('quick_sgd.yaml'))
  expect(run).toBeDefined()
  await page.goto(`/projects/${projectId}/runs/${run!.id}`)
  await page.getByRole('link', { name: 'この設定でもう一度起動' }).click()

  // スクリプトと config を選んだ状態で開き, URL に実験を残す
  await expect(page).toHaveURL(/\/launch\?run=/)
  await expect(page.getByText(/のスクリプトと experiment の config を入れました/)).toBeVisible()
  await expect(page.getByLabel('experiment の config')).toHaveValue(
    'configs/experiment/examples/quick_sgd.yaml',
  )
  await expect(page.getByLabel('config の中身')).toHaveValue(/name: SGD/)

  // 起動の前の確認は, 実験が元にした default で行う
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await expect(page.getByText('default: configs/default/train.yaml')).toBeVisible()
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
  await expect(page.getByText('0 以上の値にしてください')).toBeVisible()
  await expect(editor).not.toHaveValue(/lr: -1/)
  // 誤りのある欄が残っている間は開始せず, その欄に移る
  await page.getByRole('button', { name: '学習を開始' }).click()
  await expect(page.getByText('フォームに誤りのある欄があります')).toBeVisible()
  await expect(lr).toBeFocused()
  await expect(page).toHaveURL(/\/launch/)
  await lr.fill('0.05')
  await lr.press('Enter')
  await expect(editor).toHaveValue(/lr: 0.05/)

  // ML-Found で確かめてから起動し, ジョブの画面で完了を待つ
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await page.getByRole('button', { name: '学習を開始' }).click()
  await expect(page).toHaveURL(/\/jobs\//)
  await expect(page.getByText('完了', { exact: true }).first()).toBeVisible({ timeout: 45_000 })
  // 終わったジョブには進んだエポックと, 同じ設定でもう一度起動するボタン
  await expect(page.getByText(/3 \/ 3 エポック/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '同じ設定でもう一度' })).toBeVisible()

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

test('混合精度と勾配の蓄積をフォームで変えて起動する', async ({ page, request }) => {
  // 学習のプロセスの起動 (PyTorch の読み込み) を含むので長めに待機
  test.setTimeout(90_000)
  await page.goto(`/projects/${projectId}/launch`)
  await page
    .getByLabel('experiment の config')
    .selectOption('configs/experiment/examples/quick.yaml')
  const editor = page.getByLabel('config の中身')
  await expect(editor).toHaveValue(/epochs: 3/)

  // 既定は fp32 で毎バッチ更新. 説明に mps でメモリを減らす方を添える
  const precision = page.getByLabel('計算の精度')
  await expect(precision).toHaveValue('fp32')
  await expect(precision).toHaveAccessibleDescription(/メモリを減らすのは勾配の蓄積の方/)
  await precision.selectOption('bf16')
  await expect(editor).toHaveValue(/precision: bf16/)
  const accumulate = page.getByLabel('勾配の蓄積')
  await expect(accumulate).toHaveValue('1')
  await accumulate.fill('0')
  await accumulate.press('Enter')
  await expect(page.getByText('1 以上の整数にしてください')).toBeVisible()
  await expect(editor).not.toHaveValue(/accumulate_grad_batches/)
  await accumulate.fill('4')
  await accumulate.press('Enter')
  await expect(editor).toHaveValue(/accumulate_grad_batches: 4/)

  // 組み合わせの誤り (closure を使う Optimizer) は ML-Found の確かめで分かる
  await page.getByRole('combobox', { name: 'Optimizer' }).selectOption('LBFGS')
  await expect(editor).toHaveValue(/name: LBFGS/)
  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/accumulate_grad_batches/).first()).toBeVisible()
  await page.getByRole('combobox', { name: 'Optimizer' }).selectOption('Adam')
  await expect(editor).toHaveValue(/name: Adam/)

  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await page.getByRole('button', { name: '学習を開始' }).click()
  await expect(page).toHaveURL(/\/jobs\//)
  await expect(page.getByText('完了', { exact: true }).first()).toBeVisible({ timeout: 45_000 })

  // 起動した学習の config に 2 つの項目が入る
  const runs = (await (await request.get(`/api/projects/${projectId}/runs`)).json()) as {
    id: string
    started_at: string
  }[]
  const newest = runs.toSorted((a, b) => b.started_at.localeCompare(a.started_at))[0]!
  const detail = (await (
    await request.get(`/api/projects/${projectId}/runs/${newest.id}`)
  ).json()) as { config: { trainer: { precision: string; accumulate_grad_batches: number } } }
  expect(detail.config.trainer.precision).toBe('bf16')
  expect(detail.config.trainer.accumulate_grad_batches).toBe(4)
})

test('検証の間隔をフォームで変え, 検証したエポックだけを点で描く', async ({ page, request }) => {
  // 学習のプロセスの起動 (PyTorch の読み込み) を含むので長めに待機
  test.setTimeout(90_000)
  await page.goto(`/projects/${projectId}/launch`)
  await page
    .getByLabel('experiment の config')
    .selectOption('configs/experiment/examples/quick.yaml')
  const editor = page.getByLabel('config の中身')
  await expect(editor).toHaveValue(/epochs: 3/)

  // 5 エポックで間隔 2 (エポック 2, 4, 5 を検証). 説明も欄に付く
  const epochs = page.getByLabel('エポック数')
  await epochs.fill('5')
  await epochs.press('Enter')
  await expect(editor).toHaveValue(/epochs: 5/)
  const interval = page.getByLabel('検証の間隔')
  await expect(interval).toHaveValue('1')
  await expect(interval).toHaveAccessibleDescription(/patience は検証の回数/)

  // 1 以上の整数でない値は書き込まず, 理由を表示
  await interval.fill('0')
  await interval.press('Enter')
  await expect(page.getByText('1 以上の整数にしてください')).toBeVisible()
  await expect(editor).not.toHaveValue(/valid_every_n_epochs/)
  await interval.fill('2')
  await interval.press('Enter')
  await expect(editor).toHaveValue(/valid_every_n_epochs: 2/)

  // YAML の欄で書き換えた値もフォームに戻る
  await editor.fill(
    (await editor.inputValue()).replace('valid_every_n_epochs: 2', 'valid_every_n_epochs: 3'),
  )
  await expect(interval).toHaveValue('3')
  await editor.fill(
    (await editor.inputValue()).replace('valid_every_n_epochs: 3', 'valid_every_n_epochs: 2'),
  )
  await expect(interval).toHaveValue('2')

  await page.getByRole('button', { name: 'ML-Found で config を確かめる' }).click()
  await expect(page.getByText(/読み込めました/)).toBeVisible()
  await page.getByRole('button', { name: '学習を開始' }).click()
  await expect(page).toHaveURL(/\/jobs\//)
  await expect(page.getByText('完了', { exact: true }).first()).toBeVisible({ timeout: 45_000 })
  await expect(page.getByText(/5 \/ 5 エポック/).first()).toBeVisible()

  // 検証の値は検証したエポックだけにあり, ベストもその中から選ばれる
  const runs = (await (await request.get(`/api/projects/${projectId}/runs`)).json()) as {
    id: string
    started_at: string
  }[]
  const newest = runs.toSorted((a, b) => b.started_at.localeCompare(a.started_at))[0]!
  const base = `/api/projects/${projectId}/runs/${newest.id}`
  const detail = (await (await request.get(base)).json()) as {
    best: { epoch: number }
    final_metrics: Record<string, number | null>
  }
  const history = (await (await request.get(`${base}/history`)).json()) as {
    rows: Record<string, number | null>[]
  }
  const validated = history.rows.filter((row) => row['valid/acc'] != null).map((row) => row.epoch)
  expect(validated).toEqual([2, 4, 5])
  expect([2, 4, 5]).toContain(detail.best.epoch)
  expect(detail.final_metrics['valid/acc']).not.toBeNull()

  // 学習曲線には, 検証の値を点で描いた旨を添える
  await page.goto(`/projects/${projectId}/runs/${newest.id}`)
  await expect(page.getByRole('tab', { name: /学習曲線/ })).toBeVisible()
  await expect(
    page.getByText(/valid\/acc は記録のあるエポック .* を点で示し, 間を線でつないでいます/),
  ).toBeVisible()
  await expect(page.getByText(`エポック ${detail.best.epoch} (max)`)).toBeVisible()
})
