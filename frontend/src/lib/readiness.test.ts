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
    python: '/usr/bin/python3',
    target_python: '/p/.venv/bin/python',
    managed: true,
    environment_exists: false,
    ml_found: null,
    requires: ['eda'],
    missing: ['eda'],
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
