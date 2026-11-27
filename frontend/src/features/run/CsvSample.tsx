import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Download } from 'lucide-react'
import { useId, useState } from 'react'

import { useApi, type Sample } from '../../api/client'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { alignColumns, parseCsv, type CsvTable } from '../../lib/csv'
import { formatBytes } from '../../lib/format'
import { sampleEpochLabel, type SampleGroup } from '../../lib/results'

// 表にして見る CSV の大きさの上限と, 出す行の数
const MAX_CSV_BYTES = 2 * 1024 * 1024
const MAX_CSV_ROWS = 200

/** 実験のファイルを文字で読み, CSV の表にする */
async function fetchCsv(url: string): Promise<CsvTable> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`読めませんでした (${response.status})`)
  return parseCsv(await response.text())
}

export function DownloadLink({ url, sample }: { url: string; sample: Sample }) {
  const file = sample.path.slice(sample.path.lastIndexOf('/') + 1)
  return (
    <a
      href={url}
      download={file}
      className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline"
    >
      <Download className="size-4" aria-hidden />
      {file} をダウンロード ({formatBytes(sample.size)})
    </a>
  )
}

/** 表にしない大きな CSV の見本 (ダウンロードと, 表にしない旨) */
function TooLarge({ url, sample }: { url: string; sample: Sample }) {
  return (
    <div className="space-y-1">
      <DownloadLink url={url} sample={sample} />
      <p className="text-xs text-ink-3">大きいので表にしていません (2 MiB まで)</p>
    </div>
  )
}

/** 見本の CSV を読む (上限を超えるファイルは読まない) */
function useCsv(url: string, sample: Sample) {
  const large = sample.size > MAX_CSV_BYTES
  const table = useQuery({
    queryKey: ['sample-csv', url, sample.size, sample.created_at],
    queryFn: () => fetchCsv(url),
    enabled: !large,
    staleTime: Infinity,
  })
  return { large, table }
}

/** CSV の表. columns を渡すとその順に並べる (表に無い列は空) */
function CsvGrid({
  table,
  label,
  columns = table.columns,
}: {
  table: CsvTable
  label: string
  columns?: string[]
}) {
  const shown = table.rows.slice(0, MAX_CSV_ROWS)
  const position = new Map(table.columns.map((column, index) => [column, index]))
  return (
    <div className="space-y-1">
      <div className="max-h-[420px] overflow-auto rounded-lg border border-line">
        <table aria-label={label} className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs text-ink-2">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${index}-${column}`}
                  scope="col"
                  className={clsx(
                    'px-3 py-1.5 font-medium whitespace-nowrap',
                    table.numeric.has(column) && 'text-right',
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index} className="border-t border-line">
                {columns.map((column, place) => {
                  // 揃えた列の順でなければ位置のまま (同じ名前の列があっても値を取り違えない)
                  const at = columns === table.columns ? place : position.get(column)
                  const value = at === undefined ? '' : row[at]!
                  const empty = value.trim() === ''
                  return (
                    <td
                      key={`${place}-${column}`}
                      className={clsx(
                        'px-3 py-1 whitespace-nowrap',
                        table.numeric.has(column) ? 'tabular text-right' : 'text-ink',
                        empty && 'text-ink-3',
                      )}
                    >
                      {empty ? '—' : value}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-3">
        {table.rows.length > MAX_CSV_ROWS
          ? `${table.rows.length.toLocaleString()} 行のうち, 先頭の ${MAX_CSV_ROWS.toLocaleString()} 行を出しています`
          : `${table.rows.length.toLocaleString()} 行`}
        {' · '}
        {table.columns.length.toLocaleString()} 列
      </p>
    </div>
  )
}

/** CSV の見本を表で見る. 大きいファイルはダウンロードだけ */
export function CsvSample({ url, sample, label }: { url: string; sample: Sample; label: string }) {
  const { large, table } = useCsv(url, sample)
  if (large) return <TooLarge url={url} sample={sample} />
  return (
    <div className="space-y-2">
      {table.error && <ErrorBox error={table.error} />}
      {table.isPending && <Spinner />}
      {table.data && <CsvGrid table={table.data} label={label} />}
      <DownloadLink url={url} sample={sample} />
    </div>
  )
}

/** 並べる片方の表 (列の順は 2 つの表で揃える) */
function CompareSide({
  sample,
  projectId,
  runId,
  columns,
}: {
  sample: Sample
  projectId: string
  runId: string
  columns: string[] | undefined
}) {
  const { runFileUrl } = useApi()
  const url = runFileUrl(projectId, runId, sample.path)
  const { large, table } = useCsv(url, sample)
  const label = `${sample.name} の${sampleEpochLabel(sample.epoch)} (並べた表)`
  return (
    <figure className="min-w-0 space-y-1">
      <figcaption className="text-sm">
        <span className="font-mono text-ink">{sample.name}</span>
        {sample.caption && <span className="ml-2 text-xs text-ink-2">{sample.caption}</span>}
      </figcaption>
      {large && <TooLarge url={url} sample={sample} />}
      {table.error && <ErrorBox error={table.error} />}
      {!large && table.isPending && <Spinner />}
      {table.data && <CsvGrid table={table.data} label={label} columns={columns} />}
    </figure>
  )
}

/** 並べる見本の選び */
function SidePicker({
  label,
  groups,
  value,
  onChange,
}: {
  label: string
  groups: SampleGroup[]
  value: number
  onChange: (next: number) => void
}) {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="text-xs text-ink-3">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
      >
        {groups.map((group, index) => (
          <option key={group.name} value={index}>
            {group.name}
          </option>
        ))}
      </select>
    </>
  )
}

/**
 * CSV の見本 (作った表と本物の表など) を横に並べて見る. 名前ごとの最後の見本を
 * 選び, 列は左の表の順に揃える
 */
export function CsvCompare({
  groups,
  projectId,
  runId,
}: {
  groups: SampleGroup[]
  projectId: string
  runId: string
}) {
  const { runFileUrl } = useApi()
  const [left, setLeft] = useState(0)
  const [right, setRight] = useState(1)
  // 一覧が減った場合は範囲の中に戻す
  const leftIndex = Math.min(left, groups.length - 1)
  const rightIndex = Math.min(right, groups.length - 1)
  const leftSample = groups[leftIndex]!.entries.at(-1)!
  const rightSample = groups[rightIndex]!.entries.at(-1)!
  const leftUrl = runFileUrl(projectId, runId, leftSample.path)
  const rightUrl = runFileUrl(projectId, runId, rightSample.path)
  const leftTable = useCsv(leftUrl, leftSample).table.data
  const rightTable = useCsv(rightUrl, rightSample).table.data
  const columns =
    leftTable && rightTable ? alignColumns(leftTable.columns, rightTable.columns) : undefined
  return (
    <Card
      title="表の見本を並べる"
      actions={
        <>
          <SidePicker label="左の表" groups={groups} value={leftIndex} onChange={setLeft} />
          <SidePicker label="右の表" groups={groups} value={rightIndex} onChange={setRight} />
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CompareSide sample={leftSample} projectId={projectId} runId={runId} columns={columns} />
        <CompareSide sample={rightSample} projectId={projectId} runId={runId} columns={columns} />
      </div>
      <p className="mt-2 text-xs text-ink-3">
        同じ名前の見本は, 最後のエポックのものを並べます. 列は左の表の順に揃え,
        片方の表に無い列と空の値は「—」にします.
      </p>
    </Card>
  )
}
