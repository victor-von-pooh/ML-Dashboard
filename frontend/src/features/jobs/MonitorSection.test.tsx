import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProblemTraining } from '../../api/client'
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
  reason: '学習しない (既製のモデルをそのまま使う) 問題の設定なので, 監視する指標がありません',
  updated_at: null,
}

/** 問題の設定の一覧か, ML-Quest が無い場合の 501 を返す fetch */
function stubTrainings(problems: ProblemTraining[] | null) {
  const fetchMock = vi.fn(async () =>
    problems === null
      ? new Response(JSON.stringify({ detail: 'ml_quest が入っていません' }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response(JSON.stringify({ root: '/home/problems', problems, error: null }), {
          headers: { 'Content-Type': 'application/json' },
        }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 書き換えた YAML を config に読み直して欄に戻す (画面の確かめの代わり) */
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
  const config = (parse(text) ?? {}) as Record<string, unknown>
  const trainer = (config.trainer ?? {}) as Record<string, unknown>
  return (
    <MonitorSection
      config={{ trainer: { monitor: null, mode: 'min', ...trainer } }}
      monitorInDefault={monitorInDefault}
      projectPath={PROJECT}
      autoFill={autoFill}
      disabled={false}
      onEdit={(change) =>
        setText((current) => {
          const next = change(current)
          onText(next)
          return next
        })
      }
    />
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
  it('このプロジェクトを記録した問題の設定の値を初めに入れ, 出どころを出す', async () => {
    stubTrainings([CHURN, SALES, PRETRAINED])
    const state = setup({})
    await waitFor(() => expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/mae'))
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/mae', mode: 'min' } })
    expect(screen.getByLabelText('向き')).toHaveValue('min')
    expect(screen.getByLabelText('問題の設定から')).toHaveValue(SALES.problem_path)
    expect(screen.getByLabelText('監視する指標')).toHaveAccessibleDescription(
      /問題の設定「総菜の作る量」の学習で監視する指標と向きです/,
    )
    // 渡せない問題の設定は選べず, 理由が出る
    expect(screen.getByRole('option', { name: '写真の仕分け (渡せません)' })).toBeDisabled()
    expect(screen.getByText(/写真の仕分け: 学習しない/)).toBeVisible()
  })

  it('別の問題の設定を選ぶと入れ直し, 変えると変えたことを出す', async () => {
    stubTrainings([CHURN, SALES])
    const state = setup({})
    await waitFor(() => expect(screen.getByLabelText('監視する指標')).toHaveValue('valid/mae'))
    fireEvent.change(screen.getByLabelText('問題の設定から'), {
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
      /問題の設定「解約の引き止め」の値 \(valid\/acc, max\) から変えています/,
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
    await screen.findByLabelText('問題の設定から')
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/loss' } })
    expect(screen.getByLabelText('問題の設定から')).toHaveValue('')
  })

  it('実験の設定でもう一度起動する場合は入れない', async () => {
    stubTrainings([SALES])
    const state = setup({ autoFill: false })
    await screen.findByLabelText('問題の設定から')
    expect(state.text).toBe('')
    expect(screen.getByLabelText('監視する指標')).toHaveValue('')
  })

  it('default の config が指標を書いていれば, 問題の設定を読まない', () => {
    const fetchMock = stubTrainings([SALES])
    setup({ monitorInDefault: true })
    expect(screen.getByLabelText('監視する指標')).toBeVisible()
    expect(screen.queryByLabelText('問題の設定から')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ML-Quest が無ければ理由を出し, 欄はそのまま使える', async () => {
    stubTrainings(null)
    const state = setup({})
    expect(
      await screen.findByText(/問題の設定の値は使えません: ml_quest が入っていません/),
    ).toBeVisible()
    const input = screen.getByLabelText('監視する指標')
    fireEvent.change(input, { target: { value: 'valid/acc' } })
    fireEvent.blur(input)
    expect(parse(state.text)).toEqual({ trainer: { monitor: 'valid/acc' } })
  })
})
