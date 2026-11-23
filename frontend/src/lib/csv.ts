import type { Sample } from '../api/client'

/** CSV の表 (頭の行の列の名前と, 値の行) */
export interface CsvTable {
  columns: string[]
  rows: string[][]
  // 数の値だけを持つ列 (空の値は除いて見る. 右に寄せる)
  numeric: Set<string>
}

/** 表として見る見本か (CSV のファイル. ML-Found は .csv を file の種類で書く) */
export function isCsvSample(sample: Pick<Sample, 'kind' | 'path'>): boolean {
  return (
    (sample.kind === 'file' || sample.kind === 'text') && sample.path.toLowerCase().endsWith('.csv')
  )
}

/**
 * CSV の文字を行と値に分ける (RFC 4180. 引用符で囲んだ値の中の区切り, 改行, 2 つ続けた
 * 引用符を扱う). 終わりの空の行は除く
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  // 先頭の BOM は値に含めない
  const body = text.startsWith('﻿') ? text.slice(1) : text
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      // \r\n は 1 つの改行
      if (char === '\r' && body[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((item) => !(item.length === 1 && item[0] === ''))
}

/** 数として読める値か (空の値は欠損として数えない) */
function isNumberCell(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value))
}

/** CSV の文字を表にする. 頭の行が列の名前で, 行の長さは列の数に揃える */
export function parseCsv(text: string): CsvTable {
  const [head = [], ...body] = parseCsvRows(text)
  const columns = head
  const rows = body.map((row) => columns.map((_, position) => row[position] ?? ''))
  const numeric = new Set(
    columns.filter((_, position) => {
      const values = rows.map((row) => row[position]!).filter((value) => value.trim() !== '')
      return values.length > 0 && values.every(isNumberCell)
    }),
  )
  return { columns, rows, numeric }
}

/**
 * 並べて見る 2 つの表の列の順. 左の列の順に, 右だけにある列を後ろに足す
 * (作った表と本物の表で同じ列が横に揃うように)
 */
export function alignColumns(left: string[], right: string[]): string[] {
  return [...left, ...right.filter((column) => !left.includes(column))]
}
