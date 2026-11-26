import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { RunDetail } from '../../api/client'
import { formatParam } from '../../lib/schedulerParams'
import { ModelTab } from './RunTabs'

// ML-Found の scheduler_params の形 (自分で渡した SequentialLR. warmup は partial の関数)
const sequential = {
  milestones: [10],
  schedulers: [
    {
      scheduler: 'LambdaLR',
      params: {
        lr_lambdas: [
          {
            function: 'warm',
            args: [],
            keywords: { num_warmup_steps: 10, num_training_steps: 100 },
          },
        ],
      },
    },
    { scheduler: 'MultiStepLR', params: { milestones: [30, 60, 60], gamma: 0.1 } },
  ],
}

// config から作った OneCycleLR (Optimizer に書き込む値はパラメータグループごと)
const oneCycle = {
  total_steps: 100,
  _anneal_func_type: 'cos',
  cycle_momentum: true,
  groups: [{ max_lr: 0.1, min_lr: 4e-7, base_momentum: 0.85, max_momentum: 0.95 }],
}

/** モデルのタブに要る項目だけの実験 */
function runWith(optimizers: RunDetail['optimizers'], scheduler: string | null): RunDetail {
  return {
    model_structure: 'Net()',
    optimizer: 'AdamW (...)',
    scheduler,
    optimizers,
    model_summary: null,
  } as unknown as RunDetail
}

describe('formatParam', () => {
  it('文字はそのまま, partial の関数は Python の書き方, 並びは括弧で出す', () => {
    expect(formatParam('inf')).toBe('inf')
    expect(formatParam(0.1)).toBe('0.1')
    expect(formatParam(null)).toBe('null')
    expect(formatParam([30, 60, 60])).toBe('[30, 60, 60]')
    expect(formatParam('<lambda>')).toBe('<lambda>')
    // function が入れ子の partial でも読む
    expect(
      formatParam({
        function: { function: 'f', args: [1], keywords: {} },
        args: [2],
        keywords: { k: 'inf' },
      }),
    ).toBe('partial(partial(f, 1), 2, k=inf)')
  })
})

describe('ModelTab の Scheduler の引数', () => {
  it('Optimizer が 1 つの実験は, Scheduler の欄に入れ子の Scheduler と partial の関数を出す', () => {
    render(
      <ModelTab
        run={runWith(
          [
            {
              name: null,
              optimizer: 'AdamW',
              modules: null,
              scheduler: 'SequentialLR(LambdaLR, MultiStepLR)',
              scheduler_params: sequential,
            },
          ],
          'SequentialLR (...)',
        )}
      />,
    )
    const region = screen.getByRole('region', { name: 'Scheduler の主な引数' })
    const top = within(region).getByRole('table', {
      name: 'SequentialLR(LambdaLR, MultiStepLR) の引数',
    })
    // 外の SequentialLR の区切り (中の MultiStepLR の milestones より先)
    expect(
      within(top).getAllByRole('rowheader', { name: 'milestones' })[0]!.nextSibling,
    ).toHaveTextContent('[10]')
    expect(within(region).getByText('1. LambdaLR')).toBeInTheDocument()
    const lambda = within(region).getByRole('table', { name: 'LambdaLR の引数' })
    expect(lambda).toHaveTextContent('partial(warm, num_warmup_steps=10, num_training_steps=100)')
    const multi = within(region).getByRole('table', { name: 'MultiStepLR の引数' })
    expect(multi).toHaveTextContent('[30, 60, 60]')
    expect(multi).toHaveTextContent('0.1')
  })

  it('名前付きの Optimizer の表に, Scheduler ごとの引数とパラメータグループを出す', () => {
    render(
      <ModelTab
        run={runWith(
          [
            {
              name: 'actor',
              optimizer: 'SGD',
              modules: ['actor'],
              scheduler: 'OneCycleLR',
              scheduler_params: oneCycle,
            },
            {
              name: 'critic',
              optimizer: 'Adam',
              modules: ['critic'],
              scheduler: 'ReduceLROnPlateau',
              scheduler_params: { min_lrs: [0], eps: 'inf' },
            },
            // 書かない版の ML-Found の実験はクラス名だけ
            { name: 'value', optimizer: 'Adam', modules: ['value'], scheduler: 'StepLR' },
          ],
          null,
        )}
      />,
    )
    // Optimizer が 1 つの欄には出さない
    expect(screen.queryByRole('region', { name: 'Scheduler の主な引数' })).toBeNull()
    const actor = screen.getByRole('table', { name: 'OneCycleLR の引数' })
    expect(within(actor).getByText('パラメータグループ 0')).toBeInTheDocument()
    expect(within(actor).getByRole('table', { name: 'groups 0 の引数' })).toHaveTextContent('4e-7')
    const critic = screen.getByRole('table', { name: 'ReduceLROnPlateau の引数' })
    expect(within(critic).getByRole('rowheader', { name: 'eps' }).nextSibling).toHaveTextContent(
      'inf',
    )
    expect(screen.getByText('StepLR')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'StepLR の引数' })).toBeNull()
  })
})

describe('ModelTab のパラメータの無いモデル', () => {
  it('optimizers が空の実験は, Optimizer と Scheduler の欄に使わない旨を出す', () => {
    render(<ModelTab run={{ ...runWith([], null), optimizer: null }} />)
    expect(
      screen.getByText('パラメータの無いモデルのため, Optimizer は使いません.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('パラメータの無いモデルのため, Scheduler は使いません.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Net()')).toBeInTheDocument()
    expect(screen.queryByText('ログに記録がありません.')).toBeNull()
  })

  it('optimizers を書かない実験は, ログに記録が無い旨のままにする', () => {
    render(<ModelTab run={{ ...runWith(null, null), optimizer: null }} />)
    expect(screen.getAllByText('ログに記録がありません.')).toHaveLength(2)
    expect(screen.queryByText(/パラメータの無いモデル/)).toBeNull()
  })
})
