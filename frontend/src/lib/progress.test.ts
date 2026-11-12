import { describe, expect, it } from 'vitest'

import type { JobInfo, Progress } from '../api/client'
import { estimateRemaining, jobStatus, progressRatio } from './progress'

const base: Progress = {
  phase: 'train',
  epoch: 3,
  total_epochs: 10,
  batch: 5,
  total_batches: 10,
  elapsed_sec: 25,
  updated_at: '2026-11-13T01:00:00+09:00',
}

describe('progress', () => {
  it('エポックの中の割合は, 検証中は 1 とする', () => {
    expect(progressRatio(base)).toBe(0.5)
    expect(progressRatio({ ...base, phase: 'valid', batch: 1 })).toBe(1)
    expect(progressRatio({ ...base, total_batches: null })).toBe(0)
  })

  it('これまでの速さから残りの時間を見積もる', () => {
    // 2.5 エポックに 25 秒なので, 残りの 7.5 エポックは 75 秒
    expect(estimateRemaining(base)).toBeCloseTo(75)
    expect(estimateRemaining({ ...base, epoch: 1, batch: 0 })).toBeNull()
  })

  it('ジョブの状態は実験の状態を優先する', () => {
    const job = { status: 'finished', return_code: 1, run: null } as unknown as JobInfo
    expect(jobStatus(job)).toBe('failed')
    expect(jobStatus({ ...job, return_code: 0 })).toBe('completed')
    expect(jobStatus({ ...job, status: 'running' })).toBe('running')
    expect(jobStatus({ ...job, run: { status: 'stopped' } } as unknown as JobInfo)).toBe('stopped')
  })
})
