import { describe, expect, it } from 'vitest'

import { nextStage } from './nextStage'

const files = (...paths: string[]) => paths.map((path) => ({ path }))

describe('nextStage', () => {
  it('モデルの定義を持つ完了した実験には, 一式が無くても出す', () => {
    expect(
      nextStage({ status: 'completed', model: { name: 'net' }, files: files(), jobRunning: false }),
    ).toEqual({
      show: true,
      hasBundle: false,
      finishing: false,
    })
  })
  it('モデルの定義が無く一式を持つ, run.json の無い実験 (状態が不明) にも出す', () => {
    const run = {
      status: 'unknown' as const,
      model: null,
      files: files('inference/inference.yaml'),
      jobRunning: false,
    }
    expect(nextStage(run)).toEqual({ show: true, hasBundle: true, finishing: false })
  })
  it('inference/ の下に別のファイルだけがある実験は, 一式とみなさず案内も完了の判定も外す', () => {
    const partial = files('inference/model.pt', 'inference/data/recipe.yaml')
    expect(
      nextStage({ status: 'unknown', model: null, files: partial, jobRunning: false }),
    ).toEqual({
      show: false,
      hasBundle: false,
      finishing: false,
    })
    expect(
      nextStage({ status: 'completed', model: null, files: partial, jobRunning: false }).show,
    ).toBe(false)
    // モデルの定義を持つ実験は「学習の結果から作る」の案内 (一式なし)
    expect(
      nextStage({ status: 'completed', model: { name: 'net' }, files: partial, jobRunning: false }),
    ).toEqual({
      show: true,
      hasBundle: false,
      finishing: false,
    })
  })
  it('run.json のある不明な実験 (止まった学習) と, 学習中と失敗した実験には出さない', () => {
    const bundle = files('inference/inference.yaml', 'run.json')
    expect(
      nextStage({ status: 'unknown', model: null, files: bundle, jobRunning: false }).show,
    ).toBe(false)
    expect(
      nextStage({ status: 'running', model: { name: 'net' }, files: bundle, jobRunning: false })
        .show,
    ).toBe(false)
    expect(
      nextStage({ status: 'failed', model: null, files: bundle, jobRunning: false }).show,
    ).toBe(false)
  })
  it('学習のジョブが動いている間は, 完了した実験でも出さず後の処理の途中とする', () => {
    const run = { status: 'completed' as const, model: { name: 'net' }, files: files('run.json') }
    expect(nextStage({ ...run, jobRunning: true })).toEqual({
      show: false,
      hasBundle: false,
      finishing: true,
    })
    // ジョブの一覧を読む前は, 案内も後の処理の途中も出さない
    expect(nextStage({ ...run, jobRunning: null })).toEqual({
      show: false,
      hasBundle: false,
      finishing: false,
    })
    // ジョブが終わって一式を書き出せば「実験の一覧から登録」の案内
    const done = files('run.json', 'inference/inference.yaml')
    expect(nextStage({ ...run, files: done, jobRunning: false })).toEqual({
      show: true,
      hasBundle: true,
      finishing: false,
    })
    // 学習中の実験は, ジョブが動いていても後の処理の途中ではない
    expect(nextStage({ ...run, status: 'running', jobRunning: true }).finishing).toBe(false)
  })
})
