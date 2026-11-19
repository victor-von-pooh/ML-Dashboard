import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { RunTask } from '../../api/client'
import { TaskPanel } from './TaskPanel'

function task(overrides: Partial<RunTask> = {}): RunTask {
  return {
    format_version: 1,
    newer_version: false,
    role: 'predict',
    output: 'shape',
    what: '撮影ごとの物の表面の点群',
    target_kind: 'point_cloud',
    origin: { type: 'process', name: '再構成の処理', settings: { voxel: 0.01 } },
    origin_note: '正解は処理 再構成の処理 の出力',
    method: 'finetune',
    base_experiment: 'outputs/pre/2026-11-08/09-00-00',
    base_weights: null,
    base_run: { project_id: 'demo', run_id: 'pre/2026-11-08/09-00-00' },
    dataset_name: null,
    dataset_path: null,
    ...overrides,
  }
}

function show(value: RunTask) {
  render(
    <MemoryRouter>
      <TaskPanel task={value} />
    </MemoryRouter>,
  )
}

describe('TaskPanel', () => {
  it('処理の出力の正解は「超えられない」を処理の名前と設定と一緒に出す', () => {
    show(task())
    expect(screen.getByText('予測する (predict)')).toBeInTheDocument()
    expect(screen.getByText('撮影ごとの物の表面の点群')).toBeInTheDocument()
    expect(screen.getByText('この処理との一致を測り, この処理を超えられない')).toBeInTheDocument()
    expect(screen.getByText('再構成の処理')).toBeInTheDocument()
    expect(screen.getByText(/"voxel": 0.01/)).toBeInTheDocument()
    // 元にした実験はダッシュボードの実験へのリンク
    expect(screen.getByRole('link', { name: 'pre/2026-11-08/09-00-00' })).toHaveAttribute(
      'href',
      '/projects/demo/runs/pre/2026-11-08/09-00-00',
    )
  })

  it('新しい版は出どころを「分からない (新しい版)」とし, 言い切らない', () => {
    show(
      task({
        newer_version: true,
        origin: { type: 'unknown', name: null, settings: null },
        origin_note: '新しい版の ML-Found が書いた task.yaml',
        base_run: null,
        base_experiment: null,
        base_weights: 'bert-base-uncased',
        method: 'scratch',
      }),
    )
    expect(screen.getByText('分からない (新しい版)')).toBeInTheDocument()
    expect(screen.queryByText(/超えられない/)).not.toBeInTheDocument()
    expect(screen.getByText('bert-base-uncased')).toBeInTheDocument()
  })

  it('元にしたものが無ければ「無し」, 他の出どころは説明の文', () => {
    show(
      task({
        origin: { type: 'annotation', name: '検査員', settings: null },
        origin_note: '正解は人が付けたもの (検査員)',
        base_run: null,
        base_experiment: null,
      }),
    )
    expect(screen.getByText('無し')).toBeInTheDocument()
    expect(screen.getByText('人が付けた (annotation)')).toBeInTheDocument()
    expect(screen.getByText('正解は人が付けたもの (検査員)')).toBeInTheDocument()
  })
})
