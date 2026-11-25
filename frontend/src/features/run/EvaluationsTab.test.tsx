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
  it('異常の検知の評価は, 先頭に読み方と度合いの決め方, K, 人が確かめる件数の上限を出し, 評価の日本語の名前を添える', () => {
    // ML-Quest の異常の検知の骨組みが書く evaluations/anomaly_test.json の形
    const anomaly: Evaluation = {
      ...table,
      name: 'anomaly_test',
      split: 'test',
      columns: ['rows', 'anomalies', 'k', 'precision_at_k', 'average_precision'],
      rows: [{ rows: 200, anomalies: 9, k: 10, precision_at_k: 0.7, average_precision: 0.741 }],
      description: null,
      baseline: null,
      guard: false,
      better: { precision_at_k: 'higher', average_precision: 'higher' },
      total_rows: 1,
    }
    render(
      <EvaluationsTab
        evaluations={[anomaly]}
        config={{ anomaly: { score: 'distance', k: 10, capacity: 20 } }}
      />,
    )
    const note = screen.getByRole('region', { name: '異常の検知の評価の読み方' })
    expect(within(note).getByText('学習用の正常の行の中心からの距離')).toBeInTheDocument()
    expect(within(note).getByText('10 件')).toBeInTheDocument()
    expect(within(note).getByText('20 件')).toBeInTheDocument()
    expect(screen.getByText('上位 K 件の適合率と PR-AUC')).toBeInTheDocument()
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual([
      '行の数rows',
      '異常の行の数anomalies',
      '上位の件数 Kk',
      '上位 K 件の適合率precision_at_k (大きいほど良い)',
      'PR-AUCaverage_precision (大きいほど良い)',
    ])
  })
  it('config に anomaly の項目が無ければ読み方だけを出し, 異常の検知でない評価には出さない', () => {
    // 上位の行の要約 (行の id の列は名前のまま)
    const top: Evaluation = {
      ...table,
      name: 'anomaly_top_unlabeled',
      columns: ['rank', 'sensor_id', 'score', 'column', 'column_share'],
      rows: [{ rank: 1, sensor_id: 's-1', score: 6.2, column: 'pressure', column_share: 0.88 }],
      guard: false,
      total_rows: 1,
    }
    const { rerender } = render(<EvaluationsTab evaluations={[top]} config={{}} />)
    const note = screen.getByRole('region', { name: '異常の検知の評価の読み方' })
    expect(within(note).queryByText('上位の件数 K')).toBeNull()
    expect(screen.getByText('上位の行の要約')).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '順位rank',
      'sensor_id',
      '異常の度合いscore',
      '最も外れた列column',
      'その列が占める割合column_share',
    ])
    rerender(<EvaluationsTab evaluations={[table]} config={{ anomaly: { k: 10 } }} />)
    expect(screen.queryByRole('region', { name: '異常の検知の評価の読み方' })).toBeNull()
  })
})
