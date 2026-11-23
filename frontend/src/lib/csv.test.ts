import { describe, expect, it } from 'vitest'

import { alignColumns, isCsvSample, parseCsv, parseCsvRows } from './csv'

describe('CSV の見本', () => {
  it('CSV のファイルの見本だけを表で見る', () => {
    expect(isCsvSample({ kind: 'file', path: 'samples/generated/final.csv' })).toBe(true)
    expect(isCsvSample({ kind: 'file', path: 'samples/table/FINAL.CSV' })).toBe(true)
    expect(isCsvSample({ kind: 'file', path: 'samples/weights/final.bin' })).toBe(false)
    expect(isCsvSample({ kind: 'image', path: 'samples/plot/final.csv' })).toBe(false)
  })

  it('引用符の中の区切り, 改行, 2 つ続けた引用符と, \\r\\n と BOM を扱う', () => {
    const text = '﻿name,note\r\n"a, b","1行目\n2行目"\r\nc,"""引用"""\r\n\r\n'
    expect(parseCsvRows(text)).toEqual([
      ['name', 'note'],
      ['a, b', '1行目\n2行目'],
      ['c', '"引用"'],
    ])
  })

  it('頭の行を列の名前にし, 行の長さを揃え, 数だけの列を見分ける', () => {
    const table = parseCsv('age,income,city\n25,400.5,tokyo\n,1e3,osaka\n31,x,\n')
    expect(table.columns).toEqual(['age', 'income', 'city'])
    expect(table.rows).toEqual([
      ['25', '400.5', 'tokyo'],
      ['', '1e3', 'osaka'],
      ['31', 'x', ''],
    ])
    // 空の値は欠損として数えない. 数でない値を持つ列は数の列にしない
    expect([...table.numeric]).toEqual(['age'])
    expect(parseCsv('a,b\n1\n').rows).toEqual([['1', '']])
    expect(parseCsv('')).toEqual({ columns: [], rows: [], numeric: new Set() })
  })

  it('並べる表の列は左の順に, 右だけの列を後ろに足す', () => {
    expect(alignColumns(['age', 'city'], ['city', 'plan', 'age'])).toEqual(['age', 'city', 'plan'])
  })
})
