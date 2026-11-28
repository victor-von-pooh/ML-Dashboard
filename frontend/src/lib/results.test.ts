import { describe, expect, it } from 'vitest'

import type { Evaluation, RunFile, Sample } from '../api/client'
import { groupImageSeries } from './images'
import {
  curveSeries,
  formatCell,
  formatPercent,
  groupSamples,
  numericColumns,
  labelOf,
  axisLabel,
  className,
  ROLE_LABELS,
  OUTPUT_LABELS,
  ORIGIN_LABELS,
  sampleEpochLabel,
} from './results'

function sample(name: string, epoch: number | null, path: string, kind = 'image'): Sample {
  return {
    name,
    epoch,
    kind,
    path,
    size: 1,
    split: null,
    caption: null,
    created_at: null,
    newer_version: false,
  }
}

function evaluation(rows: Evaluation['rows'], columns: string[], x: string | null): Evaluation {
  return {
    name: 'curve',
    split: 'test',
    kind: x ? 'curve' : 'table',
    x,
    columns,
    rows,
    description: null,
    baseline: null,
    guard: false,
    better: {},
    epoch: null,
    created_at: null,
    total_rows: rows.length,
  }
}

describe('labelOf', () => {
  it('知っている名前は画面の言葉と名前, 知らない名前はそのまま, 無ければ null', () => {
    expect(labelOf(ROLE_LABELS, 'predict')).toBe('予測する (predict)')
    expect(labelOf(OUTPUT_LABELS, 'action')).toBe('行動 (action)')
    expect(labelOf(ROLE_LABELS, 'future_role')).toBe('future_role')
    expect(labelOf(ROLE_LABELS, 'toString')).toBe('toString')
    expect(labelOf(ROLE_LABELS, null)).toBeNull()
    expect(labelOf(ORIGIN_LABELS, 'self')).toBe('学んだデータそのもの (self)')
    expect(labelOf(ORIGIN_LABELS, 'environment')).toBe('環境の報酬 (environment)')
    expect(labelOf(ORIGIN_LABELS, 'future_origin')).toBe('future_origin')
  })
})

describe('groupSamples', () => {
  it('名前ごとにまとめ, エポックの順で学習の後 (null) を最後にする', () => {
    const groups = groupSamples([
      sample('recon', 10, 'samples/recon/epoch_0010.png'),
      sample('caption', 5, 'samples/caption/epoch_0005.txt', 'text'),
      sample('recon', null, 'samples/recon/final.png'),
      sample('recon', 5, 'samples/recon/epoch_0005.png'),
    ])
    expect(groups.map((group) => group.name)).toEqual(['recon', 'caption'])
    expect(groups[0]!.entries.map((entry) => entry.epoch)).toEqual([5, 10, null])
    expect(sampleEpochLabel(null)).toBe('学習の後')
    expect(sampleEpochLabel(5)).toBe('エポック 5')
  })

  it('同じ名前とエポックは後の項目だけを残す', () => {
    const groups = groupSamples([
      sample('recon', 5, 'samples/recon/epoch_0005.png'),
      sample('recon', 5, 'samples/recon/epoch_0005.jpg'),
    ])
    expect(groups[0]!.entries.map((entry) => entry.path)).toEqual(['samples/recon/epoch_0005.jpg'])
  })
})

describe('画像の推移と見本のディレクトリ', () => {
  it('samples/ の直下の番号付きの画像と名前ごとのディレクトリの画像を別の並びにし, final は入れない', () => {
    const files: RunFile[] = [
      'samples/epoch_010.png',
      'samples/epoch_020.png',
      'samples/recon/epoch_0005.png',
      'samples/recon/epoch_0010.png',
      'samples/recon/final.png',
      'samples/index.json',
    ].map((path) => ({
      path,
      size: 1,
      kind: path.endsWith('.png') ? 'image' : 'text',
      downloadable: true,
    }))
    const series = groupImageSeries(files)
    expect(series.map((item) => [item.name, item.frames.map((frame) => frame.step)])).toEqual([
      ['samples/epoch', [10, 20]],
      ['samples/recon/epoch', [5, 10]],
    ])
  })
})

describe('curveSeries', () => {
  it('x の列を横軸に, 数の列だけを x の順の系列にする', () => {
    const series = curveSeries(
      evaluation(
        [
          { k: 5, recall: 0.8, note: 'b', precision: null },
          { k: 1, recall: 0.5, note: 'a', precision: 0.9 },
          { k: 'x', recall: 1, note: 'c', precision: 1 },
        ],
        ['k', 'recall', 'note', 'precision'],
        'k',
      ),
    )
    expect(series).toEqual([
      {
        column: 'recall',
        points: [
          [1, 0.5],
          [5, 0.8],
        ],
      },
      {
        column: 'precision',
        points: [
          [1, 0.9],
          [5, null],
        ],
      },
    ])
  })

  it('表は系列を作らない', () => {
    expect(curveSeries(evaluation([{ a: 1 }], ['a'], null))).toEqual([])
  })
})

describe('numericColumns', () => {
  it('null を除いて全て数の列だけ', () => {
    const value = evaluation(
      [
        { a: 1, b: 'x', c: null, d: 2 },
        { a: null, b: 2, c: null, d: 3.5 },
      ],
      ['a', 'b', 'c', 'd'],
      null,
    )
    expect([...numericColumns(value)]).toEqual(['a', 'd'])
  })
})

describe('formatCell', () => {
  it('null, 整数, 小数, 真偽値, 文字を出す', () => {
    expect(formatCell(null)).toBe('—')
    expect(formatCell(3)).toBe('3')
    expect(formatCell(0.123456)).toBe('0.1235')
    expect(formatCell(0.00001)).toBe('1.000e-5')
    expect(formatCell(true)).toBe('true')
    expect(formatCell('a')).toBe('a')
  })
})

describe('formatPercent', () => {
  it('0 から 1 の割合を % にし, 小数第 1 位までにする', () => {
    expect(formatPercent(0.3)).toBe('30 %')
    expect(formatPercent(1)).toBe('100 %')
    expect(formatPercent(0.125)).toBe('12.5 %')
    expect(formatPercent(1 / 3)).toBe('33.3 %')
  })

  it('桁の数と符号を選べ, 丸めた -0 は 0 にする', () => {
    expect(formatPercent(1.03427, { digits: 2 })).toBe('103.43 %')
    expect(formatPercent(0.05, { signed: true })).toBe('+5 %')
    expect(formatPercent(-0.1, { signed: true })).toBe('-10 %')
    expect(formatPercent(0, { signed: true })).toBe('0 %')
    expect(formatPercent(-0.0001)).toBe('0 %')
  })
})

describe('className と axisLabel', () => {
  it('名前の無い番号は「名前なし」, 単位は軸の名前に括弧で添える', () => {
    expect(className('road')).toBe('road')
    expect(className(null)).toBe('名前なし')
    expect(axisLabel('x', 'm')).toBe('x (m)')
    expect(axisLabel('y', null)).toBe('y')
  })
})
