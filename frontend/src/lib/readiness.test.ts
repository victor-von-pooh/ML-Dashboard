import { describe, expect, it } from 'vitest'

import type { ProjectReadiness } from '../api/client'
import { environmentAction, readinessItems } from './readiness'

/** 確かめた結果の例 (.venv が無いプロジェクト) */
function sample(patch: Partial<ProjectReadiness> = {}): ProjectReadiness {
  return {
    dataset: {
      key: 'data.dataset',
      value: 'outputs/dataset',
      path: '/p/outputs/dataset',
      exists: false,
    },
    model_spec: null,
    model_placeholder: false,
    python: '/usr/bin/python3',
    target_python: '/p/.venv/bin/python',
    managed: true,
    environment_exists: false,
    ml_found: null,
    requires: ['eda'],
    missing: ['eda'],
    old_versions: {},
    manual: [],
    unknown: [],
    outdated: [],
    installer: 'uv',
    commands: [
      ['uv', 'venv'],
      ['uv', 'pip', 'install'],
    ],
    switch_python: true,
    ready: false,
    ...patch,
  }
}

describe('readinessItems', () => {
  it('無いデータセットと .venv を足りないものとして並べる', () => {
    const items = readinessItems(sample())
    expect(items.map((item) => [item.label, item.state])).toEqual([
      ['データセット', 'missing'],
      ['学習の環境', 'missing'],
    ])
    expect(items[1]?.text).toContain('.venv')
    expect(environmentAction(sample())).toBe('環境を作る')
  })

  it('モデルの定義を書いたときだけ出し, 書いていないパスは分からないとする', () => {
    const items = readinessItems(
      sample({
        dataset: { key: 'data.dataset' },
        model_spec: { key: 'model.spec', value: 'models/model.yaml', path: '/p/m', exists: true },
      }),
    )
    expect(items.map((item) => [item.label, item.state])).toEqual([
      ['データセット', 'unknown'],
      ['モデルの定義', 'ok'],
      ['学習の環境', 'missing'],
    ])
  })

  it('仮のモデルの目印があれば, 無い定義を知らせるだけにする', () => {
    const spec = { key: 'model.spec', value: 'models/model.yaml', path: '/p/m', exists: false }
    const notice = readinessItems(sample({ model_spec: spec, model_placeholder: true }))
    expect(notice[1]?.state).toBe('notice')
    expect(notice[1]?.text).toContain('仮のモデル')
    expect(notice[1]?.hint).toContain('ML-CreateArchitecture')

    // 目印が無ければ足りない. 目印があっても, 置けばそろっている
    expect(readinessItems(sample({ model_spec: spec }))[1]?.state).toBe('missing')
    const placed = { ...spec, exists: true }
    expect(readinessItems(sample({ model_spec: placed, model_placeholder: true }))[1]?.state).toBe(
      'ok',
    )
  })

  it('入っていれば揃っているとし, ボタンを出さない', () => {
    const ready = sample({
      dataset: { key: 'data.dataset', value: 'd', path: '/p/d', exists: true },
      environment_exists: true,
      ml_found: true,
      missing: [],
      commands: [],
      switch_python: false,
      ready: true,
    })
    const items = readinessItems(ready)
    expect(items.every((item) => item.state === 'ok')).toBe(true)
    expect(items[1]?.text).toContain('eda')
    expect(environmentAction(ready)).toBeNull()
  })

  it('足りない機能は入れるボタン, Python の付け替えだけは .venv を使うボタン', () => {
    const missing = sample({ environment_exists: true, ml_found: true })
    expect(readinessItems(missing)[1]?.text).toBe('足りない機能: eda')
    // 版が古い機能は, 入っている版と下限を添えて入っていない機能と分ける
    const old = sample({
      environment_exists: true,
      ml_found: true,
      requires: ['eda', 'rl'],
      missing: ['eda', 'rl'],
      old_versions: { rl: 'gymnasium 0.29.1, 1.0 以上が要る' },
    })
    expect(readinessItems(old)[1]?.text).toBe(
      '足りない機能: eda. 版が古い機能: rl (gymnasium 0.29.1, 1.0 以上が要る)',
    )
    const onlyOld = { ...old, missing: ['rl'], requires: ['rl'] }
    expect(readinessItems(onlyOld)[1]?.text).toBe(
      '版が古い機能: rl (gymnasium 0.29.1, 1.0 以上が要る)',
    )
    expect(environmentAction(missing)).toBe('足りないものを入れる')
    const switchOnly = sample({
      environment_exists: true,
      ml_found: true,
      missing: [],
      commands: [],
    })
    expect(readinessItems(switchOnly)[1]?.state).toBe('missing')
    expect(environmentAction(switchOnly)).toBe('.venv を使う')
  })
})
