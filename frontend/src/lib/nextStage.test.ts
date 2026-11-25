import { describe, expect, it } from 'vitest'

import { nextStage } from './nextStage'

const files = (...paths: string[]) => paths.map((path) => ({ path }))

describe('nextStage', () => {
  it('モデルの定義を持つ完了した実験には, 一式が無くても出す', () => {
    expect(nextStage({ status: 'completed', model: { name: 'net' }, files: files() })).toEqual({
      show: true,
      hasBundle: false,
    })
  })
  it('モデルの定義が無く一式を持つ, run.json の無い実験 (状態が不明) にも出す', () => {
    const run = {
      status: 'unknown' as const,
      model: null,
      files: files('inference/inference.yaml'),
    }
    expect(nextStage(run)).toEqual({ show: true, hasBundle: true })
  })
  it('inference/ の下に別のファイルだけがある実験は, 一式とみなさず案内も完了の判定も外す', () => {
    const partial = files('inference/model.pt', 'inference/data/recipe.yaml')
    expect(nextStage({ status: 'unknown', model: null, files: partial })).toEqual({
      show: false,
      hasBundle: false,
    })
    expect(nextStage({ status: 'completed', model: null, files: partial }).show).toBe(false)
    // モデルの定義を持つ実験は「学習の結果から作る」の案内 (一式なし)
    expect(nextStage({ status: 'completed', model: { name: 'net' }, files: partial })).toEqual({
      show: true,
      hasBundle: false,
    })
  })
  it('run.json のある不明な実験 (止まった学習) と, 学習中と失敗した実験には出さない', () => {
    const bundle = files('inference/inference.yaml', 'run.json')
    expect(nextStage({ status: 'unknown', model: null, files: bundle }).show).toBe(false)
    expect(nextStage({ status: 'running', model: { name: 'net' }, files: bundle }).show).toBe(false)
    expect(nextStage({ status: 'failed', model: null, files: bundle }).show).toBe(false)
  })
})
