import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProblemTraining } from '../../api/client'
import { getYamlValue } from '../../lib/yamlEdit'
import { MonitorSection } from './MonitorSection'

const PROJECT = '/work/own'

const SALES: ProblemTraining = {
  problem: '総菜の作る量',
  problem_path: '/home/problems/sales/problem.yaml',
  project_path: PROJECT,
  monitor: 'valid/mae',
  mode: 'min',
  reason: null,
  updated_at: null,
}
const CHURN: ProblemTraining = {
  problem: '解約の引き止め',
  problem_path: '/home/problems/churn/problem.yaml',
  project_path: null,
  monitor: 'valid/acc',
  mode: 'max',
  reason: null,
  updated_at: null,
}
const PRETRAINED: ProblemTraining = {
  problem: '写真の仕分け',
  problem_path: '/home/problems/photo/problem.yaml',
  project_path: null,
  monitor: null,
  mode: null,
  reason: '学習しない (既製のモデルをそのまま使う) 問題なので, 監視する指標がありません',
  updated_at: null,
}

/** 前の実験の記録 (指標の名前だけを使う) */
type RunStub = { final_metrics: Record<string, number>; best: { monitor: string } | null }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 問題の設定の一覧 (ML-Quest が無い場合は 501) と実験の一覧を返す fetch */
function stubTrainings(problems: ProblemTraining[] | null, runs: RunStub[] = []) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/runs')) return json(runs)
    return problems === null
      ? json({ detail: 'ML-Quest が入っていません' }, 501)
      : json({ root: '/home/problems', problems, error: null })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 書き換えた YAML を config に読み直して欄に戻す (画面の確かめの代わり).
 * 「選び直す」で, 起動の画面と同じく config を読み直してフォームを作り直す
 */
function Harness({
  initial,
  monitorInDefault,
  autoFill,
  onText,
}: {
  initial: string
  monitorInDefault: boolean
  autoFill: boolean
  onText: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const [round, setRound] = useState(0)
  const [cleared, setCleared] = useState(false)
  const config = (parse(text) ?? {}) as Record<string, unknown>
  const trainer = (config.trainer ?? {}) as Record<string, unknown>
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setText(initial)
          onText(initial)
          setRound((value) => value + 1)
        }}
      >
        選び直す
      </button>
      <MonitorSection
        key={round}
        projectId="own"
        config={{ trainer: { monitor: null, mode: 'min', ...trainer } }}
        monitorInDefault={monitorInDefault}
        modeWritten={getYamlValue(text, 'trainer.mode') !== undefined}
        projectPath={PROJECT}
        autoFill={autoFill && !cleared}
        onCleared={() => setCleared(true)}
        disabled={false}
        onEdit={(change) =>
          setText((current) => {
            const next = change(current)
            onText(next)
            return next
          })
        }
      />
    </>
  )
}

function setup(options: { initial?: string; monitorInDefault?: boolean; autoFill?: boolean }) {
  const state = { text: options.initial ?? '' }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Harness
        initial={state.text}
        monitorInDefault={options.monitorInDefault ?? false}
        autoFill={options.autoFill ?? true}
        onText={(text) => {
          state.text = text
        }}
      />
    </QueryClientProvider>,
  )
  return state
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MonitorSection (監視する指標)', () => {
  it('このプロジェクトを記録した問題の値を初めに入れ, 出どころを出す', async () => {
    stubTrainings([CHURN, SALES, PRETRAINED])
    const state = setup({})
    await waitFor(() => expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/mae'))
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/mae', mode: 'min' } })
    expect(screen.getByLabelText('向き')).toHaveValue('min')
    expect(screen.getByLabelText('問題から')).toHaveValue(SALES.problem_path)
    expect(screen.getByLabelText('監視する指標')).toHaveAccessibleDescription(
      /問題「総菜の作る量」で選んだ指標から決めた, 監視する指標と向きです/,
    )
    // 渡せない問題の設定は選べず, 理由が出る
    expect(screen.getByRole('option', { name: '写真の仕分け (使えません)' })).toBeDisabled()
    expect(screen.getByText(/写真の仕分け: 学習しない/)).toBeVisible()
  })

  it('別の問題を選ぶと入れ直し, 変えると変えたことを出す', async () => {
    stubTrainings([CHURN, SALES])
    const state = setup({})
    await waitFor(() => expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/mae'))
    fireEvent.change(screen.getByLabelText('問題から'), {
      target: { value: CHURN.problem_path },
    })
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/acc', mode: 'max' } })
    expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/acc')

    // 利用者が変えられる
    const input = screen.getByLabelText('監視する指標')
    fireEvent.change(input, { target: { value: 'valid/f1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/f1', mode: 'max' } })
    expect(input).toHaveAccessibleDescription(
      /問題「解約の引き止め」の値 \(valid\/acc, max\) から変えています/,
    )
    fireEvent.change(screen.getByLabelText('向き'), { target: { value: 'min' } })
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/f1', mode: 'min' } })

    // 空にすると消して ML-Found の既定に戻す
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(parse(state.text)).toEqual({ trainer: { mode: 'min' } })
  })

  it('experiment の config に書いた指標は書き換えない', async () => {
    const fetchMock = stubTrainings([SALES])
    const state = setup({ initial: 'trainer:\n  monitor: valid/loss\n' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await screen.findByLabelText('問題から')
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/loss' } })
    expect(screen.getByLabelText('問題から')).toHaveValue('')
  })

  it('実験の設定でもう一度起動する場合は入れない', async () => {
    stubTrainings([SALES])
    const state = setup({ autoFill: false })
    await screen.findByLabelText('問題から')
    expect(state.text).toBe('')
    expect(screen.getByLabelText('監視する指標')).toHaveValue('')
  })

  it('default の config が指標を書いていれば, 問題を読まない', () => {
    const fetchMock = stubTrainings([SALES])
    setup({ monitorInDefault: true })
    expect(screen.getByLabelText('監視する指標')).toBeVisible()
    expect(screen.queryByLabelText('問題から')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/problems/training', expect.anything())
  })

  it('ML-Quest が無ければ理由を出し, 欄はそのまま使える', async () => {
    stubTrainings(null)
    const state = setup({})
    expect(await screen.findByText(/問題の値は使えません: ML-Quest が入っていません/)).toBeVisible()
    const input = screen.getByLabelText('監視する指標')
    fireEvent.change(input, { target: { value: 'valid/acc' } })
    fireEvent.blur(input)
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/acc' } })
  })

  it('config に向きがあれば, 初めに入れるときは指標だけを書く', async () => {
    stubTrainings([SALES])
    const state = setup({ initial: 'trainer:\n  mode: max\n' })
    await waitFor(() => expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/mae'))
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/mae', mode: 'max' } })
  })

  it('空にした指標は, config を選び直しても入れ直さない', async () => {
    stubTrainings([SALES])
    const state = setup({})
    const input = screen.getByLabelText('監視する指標')
    await waitFor(() => expect(input).toHaveValue('valid/mae'))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(parse(state.text)).toEqual({ trainer: { mode: 'min' } })

    fireEvent.click(screen.getByRole('button', { name: '選び直す' }))
    await screen.findByLabelText('問題から')
    expect(state.text).toBe('')
    expect(screen.getByLabelText('監視する指標')).toHaveValue('')
  })

  // 1 行の欄は改行を落とすので, 空白とタブで確かめる
  it('空白や改行を含む名前は書き込まず, 理由を出す', async () => {
    stubTrainings([])
    const state = setup({ autoFill: false })
    const input = screen.getByLabelText('監視する指標')
    for (const raw of ['valid/ acc', 'valid/acc\tx']) {
      fireEvent.change(input, { target: { value: raw } })
      fireEvent.blur(input)
      expect(state.text).toBe('')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription(/空白や改行を含む名前は使えません/)
    }
  })

  it('前の実験の記録に無い名前は, 止めずに注意を出す', async () => {
    stubTrainings(
      [],
      [{ final_metrics: { 'train/loss': 1, 'valid/acc': 0.5 }, best: { monitor: 'valid/acc' } }],
    )
    const state = setup({ autoFill: false })
    const input = screen.getByLabelText('監視する指標')
    fireEvent.change(input, { target: { value: 'valid/accuracy' } })
    fireEvent.blur(input)
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/accuracy' } })
    await waitFor(() =>
      expect(input).toHaveAccessibleDescription(/前の実験の記録に valid\/accuracy がありません/),
    )
    expect(input).toHaveAttribute('aria-invalid', 'false')

    // 記録にある名前なら注意を出さない
    fireEvent.change(input, { target: { value: 'valid/acc' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByText(/前の実験の記録に/)).toBeNull())
  })
})
