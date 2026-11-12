import { describe, expect, it } from 'vitest'

import { checkParamValue, deleteYamlValue, formatInput, parseInput, setYamlValue } from './yamlEdit'

describe('setYamlValue', () => {
  it('コメントを残して入れ子の項目を書き込む', () => {
    const text = '# 差分だけを書く\ntrainer:\n  epochs: 10 # 短くする\n'
    const result = setYamlValue(text, 'optimizer.params.lr', 0.01)
    expect(result).toContain('# 差分だけを書く')
    expect(result).toContain('epochs: 10 # 短くする')
    expect(result).toContain('optimizer:\n  params:\n    lr: 0.01')
  })

  it('空の文書やコメントだけの文書にも書き込む', () => {
    expect(setYamlValue('', 'trainer.epochs', 5)).toBe('trainer:\n  epochs: 5\n')
    expect(setYamlValue('# メモ\n', 'trainer.epochs', 5)).toContain('epochs: 5')
  })

  it('1 行の空の辞書に書き足すと複数行の辞書にする', () => {
    const text = 'optimizer:\n  name: Adam\n  params: {}\n'
    expect(setYamlValue(text, 'optimizer.params.lr', 0.01)).toBe(
      'optimizer:\n  name: Adam\n  params:\n    lr: 0.01\n',
    )
  })

  it('壊れた YAML はエラーにする', () => {
    expect(() => setYamlValue('trainer: [', 'trainer.epochs', 5)).toThrow()
  })
})

describe('deleteYamlValue', () => {
  it('項目を消し, 空になった親も消す', () => {
    const text = 'optimizer:\n  params:\n    lr: 0.01\ntrainer:\n  epochs: 3\n'
    expect(deleteYamlValue(text, 'optimizer.params.lr')).toBe('trainer:\n  epochs: 3\n')
  })
})

describe('parseInput', () => {
  it('引数の種類に合わせて値を読む', () => {
    expect(parseInput('float', '1e-3')).toBe(0.001)
    expect(parseInput('int', '3')).toBe(3)
    expect(parseInput('int', '1e-4')).toBe(0.0001)
    expect(parseInput('int', '0x10')).toBeUndefined()
    expect(parseInput('list', '30,60')).toBeUndefined()
    expect(parseInput('bool', 'true')).toBe(true)
    expect(parseInput('list', '[0.9, 0.99]')).toEqual([0.9, 0.99])
    expect(parseInput('required', '[30, 60]')).toEqual([30, 60])
    expect(parseInput('none', 'null')).toBeNull()
    expect(parseInput('str', ' min ')).toBe('min')
    expect(parseInput('float', '')).toBeUndefined()
    expect(formatInput([1, 2])).toBe('[1,2]')
  })
})

describe('checkParamValue', () => {
  it('範囲と整数を確かめ, 数でない値は通す', () => {
    const momentum = { kind: 'float', minimum: 0, maximum: 1 }
    expect(checkParamValue(momentum, 0.9)).toBeNull()
    expect(checkParamValue(momentum, 1)).toBeNull()
    expect(checkParamValue(momentum, -0.1)).toBe('0 以上にしてください')
    expect(checkParamValue(momentum, 1.5)).toBe('1 以下にしてください')
    expect(checkParamValue({ kind: 'int', minimum: 1 }, 2.5)).toBe('整数にしてください')
    expect(checkParamValue({ kind: 'float', minimum: 0 }, [0.1, -1])).toBe('0 以上にしてください')
    expect(checkParamValue({ kind: 'str', minimum: 0 }, 'min')).toBeNull()
    expect(checkParamValue({ kind: 'none' }, null)).toBeNull()
  })
})
