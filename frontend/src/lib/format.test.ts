import { describe, expect, it } from 'vitest'

import {
  compareLabeler,
  formatBytes,
  formatDuration,
  formatLogTime,
  formatMetric,
  formatRelative,
} from './format'

describe('formatDuration', () => {
  it('秒, 分, 時間で表す', () => {
    expect(formatDuration(0.26)).toBe('0.26 秒')
    expect(formatDuration(42.3)).toBe('42.3 秒')
    expect(formatDuration(125)).toBe('2 分 5 秒')
    expect(formatDuration(3 * 3600 + 120)).toBe('3 時間 2 分')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('formatMetric', () => {
  it('桁に合わせて表す', () => {
    expect(formatMetric(1)).toBe('1')
    expect(formatMetric(0.966666)).toBe('0.9667')
    expect(formatMetric(0.0000185)).toBe('1.850e-5')
    expect(formatMetric(1234.56)).toBe('1234.6')
    expect(formatMetric(0)).toBe('0')
    expect(formatMetric(undefined)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('単位を付けて表す', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(31521)).toBe('31 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('formatRelative', () => {
  it('今からの時間で表す', () => {
    const now = new Date('2026-11-12T12:00:00')
    expect(formatRelative('2026-11-12T11:59:30', now)).toBe('たった今')
    expect(formatRelative('2026-11-12T11:30:00', now)).toBe('30 分前')
    expect(formatRelative('2026-11-10T12:00:00', now)).toBe('2 日前')
  })
})

describe('formatLogTime', () => {
  it('最初の記録と同じ日付なら時刻だけ, 違えば月日も付ける', () => {
    expect(formatLogTime('2026-11-12 23:59:58,123', '2026-11-12')).toBe('23:59:58')
    expect(formatLogTime('2026-11-13 00:00:01,000', '2026-11-12')).toBe('11-13 00:00:01')
    expect(formatLogTime(null, '2026-11-12')).toBe('')
  })
})

describe('compareLabeler', () => {
  it('同じ名前の実験が 2 つ以上なら名前と月日と時刻を出す', () => {
    const label = compareLabeler(['spiral/2026-11-20/19-03-26', 'spiral/2026-11-21/08-00-00'])
    expect(label('spiral/2026-11-20/19-03-26')).toBe('spiral 11-20 19-03-26')
    expect(label('spiral/2026-11-21/08-00-00')).toBe('spiral 11-21 08-00-00')
  })

  it('名前が違えば名前と時刻を出す', () => {
    const label = compareLabeler(['spiral/2026-11-20/19-03-26', 'spiral_sgd/2026-11-20/19-05-00'])
    expect(label('spiral/2026-11-20/19-03-26')).toBe('spiral 19-03-26')
    expect(label('spiral_sgd/2026-11-20/19-05-00')).toBe('spiral_sgd 19-05-00')
    expect(compareLabeler(['spiral/2026-11-20/19-03-26'])('spiral/2026-11-20/19-03-26')).toBe(
      'spiral 19-03-26',
    )
  })

  it('名前が 2 種類以上でも, 同じ名前の実験には月日を足す', () => {
    const label = compareLabeler([
      'spiral/2026-11-20/19-03-26',
      'spiral/2026-11-21/19-03-26',
      'spiral_sgd/2026-11-20/19-05-00',
    ])
    expect(label('spiral/2026-11-20/19-03-26')).toBe('spiral 11-20 19-03-26')
    expect(label('spiral/2026-11-21/19-03-26')).toBe('spiral 11-21 19-03-26')
    expect(label('spiral_sgd/2026-11-20/19-05-00')).toBe('spiral_sgd 19-05-00')
  })

  it('形の違う ID はそのまま出す', () => {
    expect(compareLabeler(['odd'])('odd')).toBe('odd')
  })
})
