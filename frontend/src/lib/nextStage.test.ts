import { describe, expect, it } from 'vitest'

import type { JobInfo } from '../api/client'
import { jobPhaseOf, nextStage } from './nextStage'

const files = (...paths: string[]) => paths.map((path) => ({ path }))

describe('nextStage', () => {
  it('モデルの定義を持つ完了した実験には, 一式が無くても出す', () => {
    expect(
      nextStage({ status: 'completed', model: { name: 'net' }, files: files(), job: 'none' }),
    ).toEqual({
      show: true,
      hasBundle: false,
      finishing: false,
      halted: false,
    })
  })
  it('モデルの定義が無く一式を持つ, run.json の無い実験 (状態が不明) にも出す', () => {
    const run = {
      status: 'unknown' as const,
      model: null,
      files: files('inference/inference.yaml'),
      job: 'none' as const,
    }
    expect(nextStage(run)).toEqual({
      show: true,
      hasBundle: true,
      finishing: false,
      halted: false,
    })
  })
  it('inference/ の下に別のファイルだけがある実験は, 一式とみなさず案内も完了の判定も外す', () => {
    const partial = files('inference/model.pt', 'inference/data/recipe.yaml')
    expect(nextStage({ status: 'unknown', model: null, files: partial, job: 'none' })).toEqual({
      show: false,
      hasBundle: false,
      finishing: false,
      halted: false,
    })
    expect(nextStage({ status: 'completed', model: null, files: partial, job: 'none' }).show).toBe(
      false,
    )
    // モデルの定義を持つ実験は「学習の結果から作る」の案内 (一式なし)
    expect(
      nextStage({ status: 'completed', model: { name: 'net' }, files: partial, job: 'none' }),
    ).toEqual({
      show: true,
      hasBundle: false,
      finishing: false,
      halted: false,
    })
  })
  it('run.json のある不明な実験 (止まった学習) と, 学習中と失敗した実験には出さない', () => {
    const bundle = files('inference/inference.yaml', 'run.json')
    expect(nextStage({ status: 'unknown', model: null, files: bundle, job: 'none' }).show).toBe(
      false,
    )
    expect(
      nextStage({ status: 'running', model: { name: 'net' }, files: bundle, job: 'none' }).show,
    ).toBe(false)
    expect(nextStage({ status: 'failed', model: null, files: bundle, job: 'none' }).show).toBe(
      false,
    )
  })
  it('学習のジョブが動いている間は, 完了した実験でも出さず後の処理の途中とする', () => {
    const run = { status: 'completed' as const, model: { name: 'net' }, files: files('run.json') }
    expect(nextStage({ ...run, job: 'running' })).toEqual({
      show: false,
      hasBundle: false,
      finishing: true,
      halted: false,
    })
    // ジョブの一覧を読む前は, 案内も後の処理の途中も出さない
    expect(nextStage({ ...run, job: null })).toEqual({
      show: false,
      hasBundle: false,
      finishing: false,
      halted: false,
    })
    // ジョブが終わって一式を書き出せば「実験の一覧から登録」の案内
    const done = files('run.json', 'inference/inference.yaml')
    expect(nextStage({ ...run, files: done, job: 'none' })).toEqual({
      show: true,
      hasBundle: true,
      finishing: false,
      halted: false,
    })
    // 学習中の実験は, ジョブが動いていても後の処理の途中ではない
    expect(nextStage({ ...run, status: 'running', job: 'running' }).finishing).toBe(false)
  })
  it('後の処理で失敗したか止めたジョブの実験には出さず, 止まったこととする', () => {
    const run = { status: 'completed' as const, model: { name: 'net' }, files: files('run.json') }
    expect(nextStage({ ...run, job: 'halted' })).toEqual({
      show: false,
      hasBundle: false,
      finishing: false,
      halted: true,
    })
  })
})

describe('jobPhaseOf', () => {
  const job = (extra: Partial<JobInfo>): JobInfo =>
    ({
      id: 'a',
      project_id: 'p1',
      run_id: 'r',
      created_at: '2026-11-28T10:00:00+09:00',
      status: 'finished',
      return_code: 0,
      stop_requested: false,
      force_count: 0,
      run: { status: 'completed' },
      ...extra,
    }) as unknown as JobInfo
  it('この実験のジョブが無い (端末から起動した学習) と none', () => {
    expect(jobPhaseOf([job({ run_id: 'other' })], 'p1', 'r')).toEqual({ phase: 'none', job: null })
    expect(jobPhaseOf([job({ project_id: 'p2' })], 'p1', 'r').phase).toBe('none')
  })
  it('動いているジョブは running, 終了コードが 0 なら none', () => {
    expect(jobPhaseOf([job({ status: 'running', return_code: null })], 'p1', 'r').phase).toBe(
      'running',
    )
    expect(jobPhaseOf([job({})], 'p1', 'r').phase).toBe('none')
  })
  it('実験は完了でも終了コードが 0 でないか止めたジョブは halted', () => {
    expect(jobPhaseOf([job({ return_code: 1 })], 'p1', 'r').phase).toBe('halted')
    expect(
      jobPhaseOf([job({ return_code: null, force_count: 1, stop_requested: true })], 'p1', 'r')
        .phase,
    ).toBe('halted')
  })
  it('同じ実験のジョブが複数あれば最も新しいものを見る', () => {
    const old = job({ id: 'old', return_code: 1, created_at: '2026-11-28T09:00:00+09:00' })
    const latest = job({ id: 'new' })
    expect(jobPhaseOf([old, latest], 'p1', 'r')).toEqual({ phase: 'none', job: latest })
  })
})
