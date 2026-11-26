import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('効果を見積もるの評価は, 先頭に読み方と K (%) と配る数の上限を出し, K の欄を % で書く', () => {
    // ML-Quest の効果の見積もりの骨組みが書く evaluations/uplift_test.json の形
    const uplift: Evaluation = {
      ...table,
      name: 'uplift_test',
      columns: ['rows', 'treated', 'control', 'k', 'qini', 'uplift_at_k', 'effect', 'estimated'],
      rows: [
        {
          rows: 400,
          treated: 201,
          control: 199,
          k: 0.3,
          qini: 0.2103,
          uplift_at_k: 0.124,
          effect: 0.048,
          estimated: 0.051,
        },
      ],
      description: null,
      baseline: null,
      guard: false,
      better: { qini: 'higher', uplift_at_k: 'higher' },
      total_rows: 1,
    }
    render(<EvaluationsTab evaluations={[uplift]} config={{ uplift: { k: 0.3, budget: 500 } }} />)
    const note = screen.getByRole('region', { name: '効果の見積もりの評価の読み方' })
    expect(within(note).getByText('上位 30 %')).toBeInTheDocument()
    expect(within(note).getByText('500 件')).toBeInTheDocument()
    expect(within(note).getByText(/上位 30 % の効果の差 \(uplift_at_k\)/)).toBeInTheDocument()
    expect(screen.getByText('Qini の係数と上位 K 割の効果の差')).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '行の数rows',
      '処置の群の行の数treated',
      '対照の群の行の数control',
      '上位の割合 Kk',
      'Qini の係数qini (大きいほど良い)',
      '上位 K 割の効果の差uplift_at_k (大きいほど良い)',
      '全体の効果の差effect',
      '効果の見積もりの平均estimated',
    ])
    expect(
      within(screen.getAllByRole('row')[1]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['400', '201', '199', '上位 30 %', '0.2103', '0.1240', '0.04800', '0.05100'])
  })

  it('config に uplift の項目が無ければ読み方だけを出し, K の書き方を「上位 K 割」にする', () => {
    // 検証用の分割の評価 (uplift_valid)
    const uplift: Evaluation = {
      ...table,
      name: 'uplift_valid',
      split: 'valid',
      columns: ['rows', 'qini'],
      rows: [{ rows: 400, qini: 0.19 }],
      guard: false,
      better: { qini: 'higher' },
      total_rows: 1,
    }
    render(<EvaluationsTab evaluations={[uplift]} config={{ uplift: { k: 0, budget: null } }} />)
    const note = screen.getByRole('region', { name: '効果の見積もりの評価の読み方' })
    expect(within(note).queryByText('上位の割合 K')).toBeNull()
    expect(within(note).queryByText(/配る数の上限 \(守る指標\)/)).toBeNull()
    expect(within(note).getByText(/上位 K 割の効果の差 \(uplift_at_k\)/)).toBeInTheDocument()
  })

  it('値段を変える判断の評価は, 先頭に読み方と候補と上限 (%) を出し, 比と上限の欄を % で書く', () => {
    // ML-Quest の値段を変える判断の骨組みが書く evaluations/price_test.json の形
    const price: Evaluation = {
      ...table,
      name: 'price_test',
      columns: [
        'rows',
        'products',
        'mae',
        'rmse',
        'elasticity',
        'elasticity_counted',
        'profit',
        'current_profit',
        'profit_gain',
        'profit_ratio',
        'changed',
        'max_change',
      ],
      rows: [
        {
          rows: 600,
          products: 40,
          mae: 1.284,
          rmse: 1.731,
          elasticity: -1.62,
          elasticity_counted: 40,
          profit: 5320.5,
          current_profit: 5144.2,
          profit_gain: 176.3,
          profit_ratio: 1.03427,
          changed: 27,
          max_change: 0.1,
        },
      ],
      description: null,
      baseline: null,
      guard: false,
      better: { mae: 'lower', rmse: 'lower', profit_gain: 'higher', profit_ratio: 'higher' },
      total_rows: 1,
    }
    render(
      <EvaluationsTab
        evaluations={[price]}
        config={{ price: { candidates: [-0.1, -0.05, 0, 0.05, 0.1], max_change: 0.1 } }}
      />,
    )
    const note = screen.getByRole('region', { name: '値段を変える判断の評価の読み方' })
    expect(within(note).getByText('-10 %, -5 %, 0 %, +5 %, +10 %')).toBeInTheDocument()
    expect(within(note).getByText('値段を変える幅の上限 (守る指標)')).toBeInTheDocument()
    expect(within(note).getByText('10 %')).toBeInTheDocument()
    expect(within(note).getByText(/値段の弾力性 \(elasticity\)/)).toBeInTheDocument()
    expect(within(note).getByText(/利益は \(値段 − 原価\) × 売れた数/)).toBeInTheDocument()
    expect(screen.getByText('売れた数の予測の誤差と見込みの利益')).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '行の数rows',
      '商品の数products',
      '売れた数の平均絶対誤差mae (小さいほど良い)',
      '売れた数の二乗平均平方根誤差rmse (小さいほど良い)',
      '値段の弾力性の平均elasticity',
      '弾力性を数えた商品の数elasticity_counted',
      '選んだ値段での見込みの利益profit',
      '今の値段での見込みの利益current_profit',
      '見込みの利益の差profit_gain (大きいほど良い)',
      '見込みの利益の比profit_ratio (大きいほど良い)',
      '値段を変える商品の数changed',
      '値段を変える幅の上限max_change',
    ])
    expect(
      within(screen.getAllByRole('row')[1]!)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      '600',
      '40',
      '1.284',
      '1.731',
      '-1.620',
      '40',
      '5321',
      '5144',
      '176.3',
      '103.43 %',
      '27',
      '10 %',
    ])
  })

  it('config の price が無いか読めなければ読み方だけを出す', () => {
    const price: Evaluation = {
      ...table,
      name: 'price_valid',
      split: 'valid',
      columns: ['rows', 'mae', 'profit_ratio'],
      rows: [{ rows: 600, mae: 1.3, profit_ratio: null }],
      guard: false,
      better: { mae: 'lower', profit_ratio: 'higher' },
      total_rows: 1,
    }
    const { rerender } = render(<EvaluationsTab evaluations={[price]} config={{}} />)
    const note = screen.getByRole('region', { name: '値段を変える判断の評価の読み方' })
    expect(within(note).queryByText('変える割合の候補')).toBeNull()
    expect(within(note).queryByText('値段を変える幅の上限 (守る指標)')).toBeNull()
    // 今の利益が 0 以下で比の無い欄は「—」
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[2]).toHaveTextContent('—')
    // 候補に数でない値があるものと負の上限は出さない
    rerender(
      <EvaluationsTab
        evaluations={[price]}
        config={{ price: { candidates: [0, 'up'], max_change: -0.1 } }}
      />,
    )
    expect(within(note).queryByText('変える割合の候補')).toBeNull()
    expect(within(note).queryByText('値段を変える幅の上限 (守る指標)')).toBeNull()
    // 今の値段の 0 を含まない候補は出さない
    rerender(
      <EvaluationsTab
        evaluations={[price]}
        config={{ price: { candidates: [-0.1, 0.1], max_change: 0.1 } }}
      />,
    )
    expect(within(note).queryByText('変える割合の候補')).toBeNull()
    expect(within(note).getByText('値段を変える幅の上限 (守る指標)')).toBeInTheDocument()
    // 名前の形の違う評価 (price_items_test) には読み方を出さない
    rerender(<EvaluationsTab evaluations={[{ ...price, name: 'price_items_test' }]} config={{}} />)
    expect(screen.queryByRole('region', { name: '値段を変える判断の評価の読み方' })).toBeNull()
  })

  describe('時間をまたぐ量の判断', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    // ML-Quest の時間をまたぐ量の判断の骨組みが書く evaluations/demand_test.json と
    // evaluations/demand_levels_test.json の形
    const demand: Evaluation = {
      ...table,
      name: 'demand_test',
      columns: [
        'rows',
        'products',
        'mae',
        'pinball_loss',
        'order_cost',
        'baseline_cost',
        'order_cost_saving',
        'order_cost_ratio',
        'capped',
        'level',
        'max_order',
      ],
      rows: [
        {
          rows: 480,
          products: 24,
          mae: 3.42,
          pinball_loss: 1.18,
          order_cost: 912.5,
          baseline_cost: 1188,
          order_cost_saving: 275.5,
          order_cost_ratio: 0.76809,
          capped: 3,
          level: 0.8,
          max_order: 60,
        },
      ],
      description: null,
      baseline: null,
      guard: false,
      better: {
        mae: 'lower',
        pinball_loss: 'lower',
        order_cost: 'lower',
        baseline_cost: 'lower',
        order_cost_saving: 'higher',
        order_cost_ratio: 'lower',
      },
      total_rows: 1,
    }
    const levels: Evaluation = {
      ...demand,
      name: 'demand_levels_test',
      columns: ['level', 'loss'],
      rows: [
        { level: 0.1, loss: 0.71 },
        { level: 0.5, loss: 1.52 },
        { level: 0.8, loss: 1.31 },
      ],
      better: { loss: 'lower' },
      total_rows: 3,
    }
    const config = {
      demand: { levels: [0.1, 0.5, 0.8] },
      order: { shortage_cost: 4, holding_cost: 1, max_order: 60 },
    }

    it('先頭に読み方と水準, τ, 損, 上限を出し, 日本語の名前と向きと損の比 (%) を書く', () => {
      render(<EvaluationsTab evaluations={[demand, levels]} config={config} />)
      const note = screen.getByRole('region', { name: '時間をまたぐ量の判断の評価の読み方' })
      expect(within(note).getByText('0.1, 0.5, 0.8')).toBeInTheDocument()
      expect(within(note).getByText('発注に使う水準 τ').nextSibling).toHaveTextContent('0.8')
      expect(within(note).getByText('品切れの損 (1 つ足りないとき)').nextSibling).toHaveTextContent(
        '4',
      )
      expect(within(note).getByText('売れ残りの損 (1 つ余ったとき)').nextSibling).toHaveTextContent(
        '1',
      )
      expect(within(note).getByText('発注の数の上限 (守る指標)').nextSibling).toHaveTextContent(
        '60',
      )
      expect(within(note).getByText(/売れる数を在庫の数 \+ 発注の数として/)).toBeInTheDocument()
      expect(screen.getByText('需要の予測の誤差と発注の数の損')).toBeInTheDocument()
      expect(screen.getByText('水準ごとの分位点の損失')).toBeInTheDocument()
      const [summary, perLevel] = screen.getAllByRole('table')
      expect(
        within(summary!)
          .getAllByRole('columnheader')
          .map((cell) => cell.textContent),
      ).toEqual([
        '行の数rows',
        '商品の数products',
        '需要の平均絶対誤差mae (小さいほど良い)',
        '分位点の損失の平均pinball_loss (小さいほど良い)',
        '選んだ発注の数での損order_cost (小さいほど良い)',
        '前の期間と同じ数の発注での損baseline_cost (小さいほど良い)',
        '発注の数の損の差order_cost_saving (大きいほど良い)',
        '発注の数の損の比order_cost_ratio (小さいほど良い)',
        '上限に当たった行の数capped',
        '発注に使う水準 τlevel',
        '発注の数の上限max_order',
      ])
      expect(
        within(within(summary!).getAllByRole('row')[1]!)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual([
        '480',
        '24',
        '3.420',
        '1.180',
        '912.5',
        '1188',
        '275.5',
        '76.81 %',
        '3',
        '0.8000',
        '60',
      ])
      expect(
        within(perLevel!)
          .getAllByRole('columnheader')
          .map((cell) => cell.textContent),
      ).toEqual(['水準level', '分位点の損失loss (小さいほど良い)'])
      expect(within(perLevel!).getAllByRole('row')).toHaveLength(4)
    })

    it('demand_orders.csv があれば商品ごとの発注の数の表を出す', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            'item,date,split,stock,quantile,order,previous,demand\nA,2026-03-01,test,2,11.4,9,10,12\n',
            {
              status: 200,
            },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={client}>
          <EvaluationsTab
            evaluations={[demand]}
            config={config}
            files={[{ path: 'demand_orders.csv', size: 120, kind: 'text', downloadable: true }]}
            projectId="p"
            runId="demand/2026-03-01/10-00-00"
          />
        </QueryClientProvider>,
      )
      const orders = await screen.findByRole('table', { name: '商品ごとの発注の数' })
      expect(within(orders).getAllByRole('columnheader')[5]).toHaveTextContent('order')
      expect(within(orders).getAllByRole('row')[1]).toHaveTextContent('9')
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/p/runs/demand/2026-03-01/10-00-00/files/demand_orders.csv',
      )
      expect(
        screen.getByRole('link', { name: /demand_orders\.csv をダウンロード/ }),
      ).toBeInTheDocument()
    })

    it('config が読めなければ読み方だけを出し, 表のファイルが無ければ表を出さない', () => {
      const { rerender } = render(
        <EvaluationsTab
          evaluations={[demand]}
          config={{ demand: { levels: [0.5, 0.1] }, order: { shortage_cost: 0, max_order: -1 } }}
        />,
      )
      const note = screen.getByRole('region', { name: '時間をまたぐ量の判断の評価の読み方' })
      expect(within(note).queryByText('学んだ水準')).toBeNull()
      expect(within(note).queryByText('発注に使う水準 τ')).toBeNull()
      expect(within(note).queryByText('発注の数の上限 (守る指標)')).toBeNull()
      expect(screen.queryByText('商品ごとの発注の数')).toBeNull()
      // 前の期間の損が 0 で比の無い欄は「—」
      rerender(
        <EvaluationsTab
          evaluations={[{ ...demand, rows: [{ ...demand.rows[0], order_cost_ratio: null }] }]}
        />,
      )
      expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[7]).toHaveTextContent('—')
      // 名前の形の違う評価 (demand_items_test) には読み方を出さない
      rerender(<EvaluationsTab evaluations={[{ ...demand, name: 'demand_items_test' }]} />)
      expect(
        screen.queryByRole('region', { name: '時間をまたぐ量の判断の評価の読み方' }),
      ).toBeNull()
    })
  })
})
