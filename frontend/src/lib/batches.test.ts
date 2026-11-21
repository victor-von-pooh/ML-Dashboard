import { describe, expect, it } from 'vitest'

import type { BatchInfo } from '../api/client'
import { batchLabels } from './batches'

describe('batchLabels', () => {
  it('候補のジョブに, 定義の名前と何番目かを付ける', () => {
    const batch = {
      id: '0123456789ab',
      candidates: [
        { path: 'models/a.yaml', name: 'a', sha256: 'a', state: 'finished', job_id: 'job1' },
        { path: 'models/b.yaml', name: 'b', sha256: 'b', state: 'waiting', job_id: null },
      ],
    } as unknown as BatchInfo
    const labels = batchLabels([batch])
    expect(labels.get('job1')).toBe('a (1 / 2)')
    expect(labels.size).toBe(1)
  })
})
