import { describe, expect, it } from 'vitest'

import { describeModelSpec, modelSpecStatus } from './modelSpec'

describe('モデルの定義の写し', () => {
  it('写した定義は写しのファイルと sha256 の先頭を添える', () => {
    const spec = {
      path: 'models/model.yaml',
      status: 'copied',
      sha256: 'abcdef0123456789'.repeat(4),
    }
    expect(describeModelSpec(spec)).toBe(
      'models/model.yaml (写した: model_spec.yaml, sha256 abcdef012345)',
    )
  })

  it('写さなかった理由を言葉にし, 知らない値は写していないものとして値のまま出す', () => {
    expect(modelSpecStatus({ path: 'm.yaml', status: 'missing', sha256: null })).toBe(
      '写していない: 定義のファイルが無い',
    )
    expect(modelSpecStatus({ status: 'renamed' })).toBe('写していない: renamed')
    expect(modelSpecStatus({ status: 'toString' })).toBe('写していない: toString')
    expect(modelSpecStatus({ path: 'm.yaml' })).toBe('写したか分からない')
    expect(describeModelSpec({ status: 'link' })).toBe(
      '場所が分からない (写していない: 定義の場所がシンボリックリンク)',
    )
  })
})
