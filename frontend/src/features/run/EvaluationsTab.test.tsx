import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Evaluation } from '../../api/client'
import { EvaluationsTab } from './EvaluationsTab'

const table: Evaluation = {
  name: 'safety',
  split: 'test',
  kind: 'table',
  x: null,
  columns: ['metric', 'value', 'diff'],
  rows: [{ metric: 'miss', value: 0.01, diff: null }],
  description: '見逃し',
  baseline: '今の処理',
  guard: true,
  better: {},
  epoch: 9,
  created_at: null,
  total_rows: 3000,
}

describe('EvaluationsTab', () => {
  it('守る指標の表を印付きで, 列の順と添える情報と一緒に出す', () => {
    render(<EvaluationsTab evaluations={[table]} />)
    expect(screen.getByText('守る指標')).toBeInTheDocument()
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['metric', 'value', 'diff'])
    expect(screen.getByText('見逃し')).toBeInTheDocument()
    expect(screen.getByText('今の処理')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText(/3,000 行のうち/)).toBeInTheDocument()
  })

  it('表を作る課題の列ごとの分布の近さは, 向きを見出しに添え, 値の無い欄を「—」にする', () => {
    // ML-Quest の表の生成の骨組みが書く evaluations/column_distance_valid.json の形
    const distance: Evaluation = {
      name: 'column_distance_valid',
      split: 'valid',
      kind: 'table',
      x: null,
      columns: ['column', 'type', 'distance', 'wasserstein', 'train_distance'],
      rows: [
        { column: 'age', type: 'number', distance: 0.16, wasserstein: 0.21, train_distance: 0.08 },
        {
          column: 'city',
          type: 'category',
          distance: 0.18,
          wasserstein: null,
          train_distance: 0.05,
        },
        {
          column: '(全ての列の平均)',
          type: null,
          distance: 0.17,
          wasserstein: null,
          train_distance: 0.065,
        },
      ],
      description: '作った表と検証用の本物の表の列ごとの分布の近さ',
      baseline: null,
      guard: false,
      better: { distance: 'lower', wasserstein: 'lower' },
      epoch: 2,
      created_at: null,
      total_rows: 3,
    }
    render(<EvaluationsTab evaluations={[distance]} />)
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      'column',
      'type',
      'distance(小さいほど良い)',
      'wasserstein(小さいほど良い)',
      'train_distance',
    ])
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(4)
    expect(
      within(rows[2]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['city', 'category', '0.1800', '—', '0.05000'])
    expect(within(rows[3]!).getAllByRole('cell')[1]).toHaveTextContent('—')
  })

  it('並べる課題の人気順との差は, 一覧と同じく符号と良し悪しの印を付ける', () => {
    // ML-Quest の並べるの骨組みが書く evaluations/ranking_test.json の形
    const better = 'higher' as const
    const ranking: Evaluation = {
      name: 'ranking_test',
      split: 'test',
      kind: 'table',
      x: null,
      columns: [
        'users',
        'k',
        'recall_at_k',
        'recall_at_k_baseline',
        'recall_at_k_diff',
        'ndcg',
        'ndcg_baseline',
        'ndcg_diff',
      ],
      rows: [
        {
          users: 27,
          k: 10,
          recall_at_k: 0.5679,
          recall_at_k_baseline: 0.4383,
          recall_at_k_diff: 0.1296,
          ndcg: 0.2,
          ndcg_baseline: 0.25,
          ndcg_diff: -0.05,
        },
      ],
      description: 'テスト用の反応で数えた上位 10 件の Recall@K と NDCG',
      baseline: '人気順 (学習用の反応の多い順)',
      guard: false,
      better: {
        recall_at_k: better,
        recall_at_k_baseline: better,
        recall_at_k_diff: better,
        ndcg: better,
        ndcg_baseline: better,
        ndcg_diff: better,
      },
      epoch: 3,
      created_at: null,
      total_rows: 1,
    }
    render(<EvaluationsTab evaluations={[ranking]} />)
    const cells = within(screen.getAllByRole('row')[1]!).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '27',
      '10',
      '0.5679',
      '0.4383',
      '+0.1296良い',
      '0.2000',
      '0.2500',
      '-0.05000悪い',
    ])
    expect(within(cells[4]!).getByTitle('人気順 (学習用の反応の多い順) との差')).toBeVisible()
    // 向きの無い差の列と, <指標> の列が表に無い差の列は数だけ
    render(
      <EvaluationsTab
        evaluations={[
          {
            ...ranking,
            name: 'other',
            columns: ['ndcg_diff', 'mrr_diff'],
            rows: [{ ndcg_diff: 0.1, mrr_diff: 0.2 }],
            better: { mrr_diff: better },
          },
        ]}
      />,
    )
    const other = within(screen.getAllByRole('table')[1]!).getAllByRole('cell')
    expect(other.map((cell) => cell.textContent)).toEqual(['0.1000', '0.2000'])
  })
  it('群分けの群の安定性は, 見出しを日本語の名前にし, 列の特徴をそのまま分けた群との差に良し悪しの印を付ける', () => {
    // ML-Quest の群分けの骨組みが書く evaluations/group_stability.json の形
    const better = 'higher' as const
    const stability: Evaluation = {
      name: 'group_stability',
      split: 'all',
      kind: 'table',
      x: null,
      columns: ['k', 'method', 'repeats', 'ari', 'ari_baseline', 'ari_diff', 'silhouette_diff'],
      rows: [
        {
          k: 3,
          method: 'seed',
          repeats: 5,
          ari: 0.98,
          ari_baseline: 1,
          ari_diff: -0.02,
          silhouette_diff: 0.01,
        },
      ],
      description: null,
      baseline: '列の特徴をそのまま k-means で分けた群',
      guard: false,
      better: { ari: better, ari_baseline: better, ari_diff: better, silhouette_diff: better },
      epoch: 3,
      created_at: null,
      total_rows: 1,
    }
    render(<EvaluationsTab evaluations={[stability]} />)
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers[0]).toBe('群の数k')
    // 日本語の名前を主にし, 英字の名前と向きを小さく添える
    expect(headers[3]).toBe('調整ランド指数の平均ari (大きいほど良い)')
    expect(headers[5]).toBe('調整ランド指数の平均 (比べる相手との差)ari_diff (大きいほど良い)')
    expect(screen.getAllByRole('columnheader')[3]).toHaveAttribute(
      'title',
      '作り直した群との一致. 1 は同じ群, 0 は偶然と同じ',
    )
    // silhouette の列が表に無い差の列は数だけ
    const cells = within(screen.getAllByRole('row')[1]!).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '3',
      'seed',
      '5',
      '0.9800',
      '1',
      '-0.02000悪い',
      '0.01000',
    ])
  })
})
