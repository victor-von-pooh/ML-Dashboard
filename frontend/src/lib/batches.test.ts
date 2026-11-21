import { describe, expect, it } from 'vitest'

import type { BatchInfo, JobInfo, ModelSpecInfo } from '../api/client'
import { batchLabels, batchState, chosenCandidates, compareCandidates } from './batches'

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

describe('compareCandidates', () => {
  it('候補のジョブの実験で, 比べられる数までの比較の URL を作る', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      path: `models/m${index}.yaml`,
      name: `m${index}`,
      sha256: 'x',
      state: 'finished',
      job_id: `job${index}`,
    }))
    const batch = {
      project_id: 'demo',
      finished: true,
      candidates,
    } as unknown as BatchInfo
    const jobs = candidates.map((candidate, index) => ({
      id: candidate.job_id,
      run_id: index === 1 ? null : `spiral/2026-11-22/10-00-0${index}`,
    })) as unknown as JobInfo[]
    const { runIds, url } = compareCandidates(batch, jobs)
    expect(runIds).toHaveLength(9)
    const query = new URLSearchParams(url.split('?')[1])
    expect(query.getAll('run')).toHaveLength(8)
    expect(query.getAll('run')[0]).toBe('spiral/2026-11-22/10-00-00')
    expect(url.startsWith('/projects/demo/compare?')).toBe(true)
  })
})

describe('batchState', () => {
  it('進めている途中, 終わった, 取りやめたを見分ける', () => {
    const make = (finished: boolean, state: string) =>
      ({ finished, candidates: [{ state }] }) as unknown as BatchInfo
    expect(batchState(make(false, 'waiting'))).toBe('進めている途中')
    expect(batchState(make(true, 'finished'))).toBe('終わった')
    expect(batchState(make(true, 'cancelled'))).toBe('取りやめた')
  })
})

describe('chosenCandidates', () => {
  const specs = [
    { path: 'models/a.yaml', name: 'a', reason: null },
    { path: 'models/b.yaml', name: 'b', reason: 'シンボリックリンクなので選べません' },
    { path: 'models/c.yaml', name: 'c', reason: null },
  ] as unknown as ModelSpecInfo[]

  it('スクリプトか default を替えたら選び直す', () => {
    expect(
      chosenCandidates({ key: 'train.py:', paths: ['models/a.yaml'] }, 'other.py:', specs),
    ).toEqual([])
  })

  it('消えた定義と選べなくなった定義を外し, 選んだ順を保つ', () => {
    const chosen = {
      key: 'k',
      paths: ['models/c.yaml', 'models/gone.yaml', 'models/b.yaml', 'models/a.yaml'],
    }
    expect(chosenCandidates(chosen, 'k', specs)).toEqual(['models/c.yaml', 'models/a.yaml'])
  })
})
