import clsx from 'clsx'
import { Ban, Download, ExternalLink, Search, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { runFileUrl, type LogEntry, type ModelParam, type RunDetail } from '../../api/client'
import { Button, Card } from '../../components/ui'
import { formatBytes, formatLogTime, formatValue } from '../../lib/format'
import { flattenConfig } from '../../lib/metrics'
import { describeModelSpec } from '../../lib/modelSpec'
import { countParams, filterParams } from '../../lib/modelSummary'
import { SchedulerParams } from './SchedulerParams'

/** 検索できる「項目名 = 値」の表 */
function KeyValueTable({ rows, highlight }: { rows: [string, string][]; highlight?: Set<string> }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([key, value]) => (
          <tr
            key={key}
            className={clsx(
              'border-b border-line last:border-b-0',
              highlight?.has(key) && 'bg-accent-soft/70',
            )}
          >
            <td className="w-2/5 px-4 py-1.5 align-top font-mono text-xs text-ink-2">{key}</td>
            <td className="px-4 py-1.5 font-mono text-xs break-all text-ink">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <Search className="absolute top-2 left-2.5 size-3.5 text-ink-3" aria-hidden />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 w-56 rounded-md border border-line bg-bg pr-2 pl-7 text-xs outline-none focus:border-accent"
      />
    </div>
  )
}

export function ConfigTab({ run }: { run: RunDetail }) {
  const [query, setQuery] = useState('')
  const changed = useMemo(() => new Set(Object.keys(run.diff)), [run.diff])
  const rows = useMemo(() => {
    const flat = Object.entries(flattenConfig(run.config)).map<[string, string]>(([key, value]) => [
      key,
      formatValue(value),
    ])
    const word = query.toLowerCase()
    return flat.filter(([key, value]) => `${key} ${value}`.toLowerCase().includes(word))
  }, [run.config, query])

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card
        title={
          run.source?.default ? `default (${run.source.default}) との差分` : 'default との差分'
        }
        padded={false}
      >
        {run.source && <SourceLine source={run.source} />}
        {changed.size === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-3">default のまま学習しました.</p>
        ) : (
          // 長い値 (リストや入れ子) はカードの中で折り返す
          <table className="w-full table-fixed text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">項目</th>
                <th className="px-4 py-2 font-medium">default</th>
                <th className="px-4 py-2 font-medium">この実験</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(run.diff).map(([key, value]) => {
                const item = (value ?? {}) as { default?: unknown; experiment?: unknown }
                return (
                  <tr key={key} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-1.5 font-mono text-xs break-all text-ink-2">{key}</td>
                    <td className="px-4 py-1.5 font-mono text-xs break-all text-ink-3 line-through decoration-ink-3/40">
                      {formatValue(item.default)}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs font-medium break-all">
                      {formatValue(item.experiment)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title="config 全体"
        padded={false}
        actions={<SearchInput value={query} onChange={setQuery} placeholder="項目を探す" />}
      >
        <div className="max-h-[560px] overflow-y-auto">
          <KeyValueTable rows={rows} highlight={changed} />
        </div>
      </Card>
    </div>
  )
}

/** パラメータとバッファの一覧 (ML-Found の model_summary.csv) */
function ParamTable({ rows, total }: { rows: ModelParam[]; total: number }) {
  const [query, setQuery] = useState('')
  const counts = useMemo(() => countParams(rows), [rows])
  const shown = filterParams(rows, query)
  return (
    <Card
      title={`パラメータの一覧 (${total})`}
      padded={false}
      className="lg:col-span-2"
      actions={<SearchInput value={query} onChange={setQuery} placeholder="名前か層で探す" />}
    >
      <p className="tabular px-4 py-2 text-xs text-ink-2">
        学習するパラメータ {counts.trainable.toLocaleString()} · 学習しないパラメータ{' '}
        {counts.frozen.toLocaleString()} · バッファ {counts.buffer.toLocaleString()}
        {total > rows.length && ` (先頭の ${rows.length} 行で数えた値)`}
      </p>
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="sticky top-0 bg-surface text-left text-xs text-ink-3">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">名前</th>
              <th className="px-4 py-2 font-medium">層</th>
              <th className="px-4 py-2 font-medium">形</th>
              <th className="px-4 py-2 text-right font-medium">要素数</th>
              <th className="px-4 py-2 font-medium">学習</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.name} className="border-b border-line last:border-b-0">
                <td className="px-4 py-1.5 font-mono text-xs break-all">
                  {row.name}
                  {row.same_as && (
                    <span className="block text-[11px] text-ink-3">{row.same_as} と共有</span>
                  )}
                </td>
                <td className="px-4 py-1.5 text-xs text-ink-2">
                  {row.module}
                  {row.kind === 'buffer' && <span className="text-ink-3"> (バッファ)</span>}
                </td>
                <td className="px-4 py-1.5 font-mono text-xs">{row.shape || '-'}</td>
                <td className="tabular px-4 py-1.5 text-right text-xs">
                  {row.numel.toLocaleString()}
                </td>
                <td className="px-4 py-1.5 text-xs">
                  {row.kind === 'buffer' ? '-' : row.requires_grad ? 'する' : 'しない'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** 名前付きの複数の Optimizer の, 名前ごとのクラス, 受け持つ部分, Scheduler */
function OptimizerTable({ optimizers }: { optimizers: NonNullable<RunDetail['optimizers']> }) {
  // Scheduler の引数を出す場合は, 入れ子の表が狭くならないように横幅いっぱいに
  const wide = optimizers.some((item) => item.scheduler && item.scheduler_params)
  return (
    <Card
      title="Optimizer ごとの受け持つ部分"
      padded={false}
      className={clsx(wide && 'lg:col-span-2')}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-ink-3">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                名前
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Optimizer
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                受け持つ部分
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Scheduler
              </th>
            </tr>
          </thead>
          <tbody>
            {optimizers.map((item, index) => (
              <tr
                key={item.name ?? `#${index}`}
                className="border-b border-line align-top last:border-0"
              >
                <th scope="row" className="px-4 py-1.5 font-mono text-xs font-medium">
                  {item.name}
                </th>
                <td className="px-4 py-1.5 font-mono text-xs">{item.optimizer}</td>
                <td className="px-4 py-1.5 font-mono text-xs">
                  {/* 受け持つ部分は 1 つずつ行を分け, 名前の途中で折り返さない */}
                  {(item.modules ?? []).length > 0
                    ? (item.modules ?? []).map((module, position) => (
                        <div key={`${position}-${module}`} className="whitespace-nowrap">
                          {module}
                        </div>
                      ))
                    : '-'}
                </td>
                <td className="px-4 py-1.5 align-top">
                  <div className="font-mono text-xs">{item.scheduler ?? 'なし'}</div>
                  {item.scheduler && item.scheduler_params && (
                    <div className="mt-1.5 min-w-72">
                      <SchedulerParams scheduler={item.scheduler} params={item.scheduler_params} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function ModelTab({ run }: { run: RunDetail }) {
  const blocks: [string, string | null | undefined][] = [
    ['モデルの構造', run.model_structure],
    ['Optimizer', run.optimizer],
    ['Scheduler', run.scheduler],
  ]
  // Optimizer が 1 つの実験の Scheduler の主な引数 (名前付きの場合は下の表に出す)
  const single = run.optimizers?.length === 1 && run.optimizers[0]!.name === null
  const scheduler = single ? run.optimizers![0]! : null
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      {blocks.map(([title, text]) => (
        <Card key={title} title={title} className={title === 'モデルの構造' ? 'lg:row-span-2' : ''}>
          {text ? (
            <pre className="max-h-[520px] overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-ink-3">ログに記録がありません.</p>
          )}
          {title === 'Scheduler' && scheduler?.scheduler && scheduler.scheduler_params && (
            <section aria-label="Scheduler の主な引数" className="mt-3 border-t border-line pt-3">
              <h3 className="text-xs font-medium text-ink-3">
                主な引数 <span className="font-mono">{scheduler.scheduler}</span>
              </h3>
              <div className="mt-1">
                <SchedulerParams
                  scheduler={scheduler.scheduler}
                  params={scheduler.scheduler_params}
                />
              </div>
            </section>
          )}
        </Card>
      ))}
      {run.optimizers?.some((item) => item.name !== null) && (
        <OptimizerTable optimizers={run.optimizers} />
      )}
      {run.model_summary && (
        <ParamTable
          rows={run.model_summary}
          total={run.model_summary_rows ?? run.model_summary.length}
        />
      )}
    </div>
  )
}

export function EnvTab({ run, projectId }: { run: RunDetail; projectId: string }) {
  const [query, setQuery] = useState('')
  const packages = Object.entries(run.packages).filter(([name]) =>
    name.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        {run.env.length === 0 && (
          <p className="text-sm text-ink-3">ログに環境の情報がありません.</p>
        )}
        {run.env.map((section) => (
          <Card key={section.title} title={section.title} padded={false}>
            <KeyValueTable rows={Object.entries(section.items)} />
          </Card>
        ))}
        {run.has_git_diff && (
          <a
            href={runFileUrl(projectId, run.id, 'git_diff.patch')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-accent-text hover:underline"
          >
            <ExternalLink className="size-4" aria-hidden />
            学習時の未コミットの変更 (git_diff.patch)
          </a>
        )}
      </div>
      <Card
        title={`パッケージ (${Object.keys(run.packages).length})`}
        padded={false}
        actions={<SearchInput value={query} onChange={setQuery} placeholder="パッケージを探す" />}
      >
        <div className="max-h-[560px] overflow-y-auto">
          <KeyValueTable rows={packages} />
        </div>
      </Card>
    </div>
  )
}

// 絞り込みに使うレベル. 書式が違う行と DEBUG は INFO と同じ扱い
const LEVELS = ['INFO', 'WARNING', 'ERROR'] as const
type Level = (typeof LEVELS)[number]

/** ログのレベルを絞り込みの区分にまとめる */
function levelGroup(level: string | null | undefined): Level {
  if (level === 'WARNING') return 'WARNING'
  if (level === 'ERROR' || level === 'CRITICAL') return 'ERROR'
  return 'INFO'
}

export function LogTab({ entries }: { entries: LogEntry[] }) {
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<Level>>(new Set(LEVELS))
  const counts = useMemo(() => {
    const result: Record<string, number> = {}
    for (const entry of entries) {
      const group = levelGroup(entry.level)
      result[group] = (result[group] ?? 0) + 1
    }
    return result
  }, [entries])

  // 日付をまたいだ記録だけ, 時刻に日付も付けて表示
  const firstDate = entries.find((entry) => entry.time)?.time?.slice(0, 10)

  const word = query.toLowerCase()
  const visible = entries.filter(
    (entry) => levels.has(levelGroup(entry.level)) && entry.message.toLowerCase().includes(word),
  )

  const toggle = (level: Level) =>
    setLevels((previous) => {
      const next = new Set(previous)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })

  return (
    <Card
      title="train.log"
      padded={false}
      actions={
        <>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggle(level)}
              aria-pressed={levels.has(level)}
              className={clsx(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                levels.has(level)
                  ? 'border-accent/40 bg-accent-soft text-accent-text'
                  : 'border-line text-ink-3',
              )}
            >
              {level} <span className="tabular">{counts[level] ?? 0}</span>
            </button>
          ))}
          <SearchInput value={query} onChange={setQuery} placeholder="ログを探す" />
        </>
      }
    >
      <div className="max-h-[640px] overflow-auto py-1 font-mono text-xs">
        {visible.map((entry, index) => {
          const group = levelGroup(entry.level)
          return (
            <div
              key={index}
              className={clsx(
                'flex gap-3 border-l-2 px-4 py-0.5',
                group === 'WARNING' && 'border-warning bg-warning/10',
                group === 'ERROR' && 'border-critical bg-critical/10',
                group === 'INFO' && 'border-transparent',
              )}
            >
              <span className="tabular shrink-0 text-ink-3" title={entry.time ?? undefined}>
                {formatLogTime(entry.time, firstDate)}
              </span>
              {group !== 'INFO' && (
                <span
                  className={clsx(
                    'shrink-0 font-semibold',
                    group === 'WARNING' ? 'text-warning-text' : 'text-critical-text',
                  )}
                >
                  {entry.level}
                </span>
              )}
              <span className="break-all whitespace-pre-wrap text-ink-2">{entry.message}</span>
            </div>
          )
        })}
        {visible.length === 0 && <p className="px-4 py-6 text-ink-3">該当する行はありません.</p>}
      </div>
    </Card>
  )
}

// ファイルのタブで一度に並べる画像の数
const IMAGE_PAGE = 48

export function FilesTab({ run, projectId }: { run: RunDetail; projectId: string }) {
  const images = run.files.filter((file) => file.kind === 'image')
  // 画像が多い実験 (エポックごとの生成画像など) は, 少しずつ並べる
  const [shown, setShown] = useState(IMAGE_PAGE)
  const [preview, setPreview] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)

  // ネイティブのダイアログで開き, Escape と背景の操作の禁止はブラウザに任せる
  const open = (path: string, opener: HTMLButtonElement) => {
    openerRef.current = opener
    setPreview(path)
    dialogRef.current?.showModal()
  }
  const onClose = () => {
    setPreview(null)
    openerRef.current?.focus()
  }

  return (
    <div className="space-y-4">
      {images.length > 0 && (
        <Card title={`画像 (${images.length})`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {images.slice(0, shown).map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={(event) => open(file.path, event.currentTarget)}
                className="group overflow-hidden rounded-lg border border-line bg-white text-left"
                aria-label={`${file.path} を大きく表示`}
              >
                <img
                  src={runFileUrl(projectId, run.id, file.path)}
                  alt=""
                  loading="lazy"
                  className="aspect-[4/3] w-full object-contain transition group-hover:scale-[1.02]"
                />
                <div className="truncate border-t border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink-2">
                  {file.path}
                </div>
              </button>
            ))}
          </div>
          {images.length > shown && (
            <div className="mt-3 flex items-center gap-3 text-xs text-ink-3">
              <Button variant="secondary" onClick={() => setShown((count) => count + IMAGE_PAGE)}>
                さらに {Math.min(IMAGE_PAGE, images.length - shown)} 枚を表示
              </Button>
              {shown} / {images.length} 枚 (エポックごとの推移は「画像の推移」のタブ)
            </div>
          )}
        </Card>
      )}
      <Card title={`ファイル (${run.files.length})`} padded={false}>
        <table className="w-full text-sm">
          <tbody>
            {run.files.map((file) => (
              <tr
                key={file.path}
                className="border-b border-line last:border-b-0 hover:bg-surface-2/60"
              >
                <td className="px-4 py-1.5 font-mono text-xs break-all">{file.path}</td>
                <td className="px-4 py-1.5 text-xs text-ink-3">{file.kind}</td>
                <td className="tabular px-4 py-1.5 text-right text-xs text-ink-2">
                  {formatBytes(file.size)}
                </td>
                <td className="w-10 px-2 py-1.5">
                  {/* 文字のファイルは新しいタブで開ける */}
                  {file.kind === 'text' && (
                    <a
                      href={runFileUrl(projectId, run.id, file.path)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                      aria-label={`${file.path} を新しいタブで開く`}
                      title="新しいタブで開く"
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </td>
                <td className="w-10 px-2 py-1.5">
                  {/* 方策の一式の重みは配らない (使ってよいかは画面の外で人が決める) */}
                  {file.downloadable ? (
                    <a
                      href={runFileUrl(projectId, run.id, file.path)}
                      download
                      className="inline-flex rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                      aria-label={`${file.path} をダウンロード`}
                    >
                      <Download className="size-3.5" aria-hidden />
                    </a>
                  ) : (
                    <span
                      className="inline-flex rounded p-1 text-ink-3"
                      title="方策の重みは配りません"
                    >
                      <Ban className="size-3.5" aria-hidden />
                      <span className="sr-only">{file.path} は配りません</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <dialog
        ref={dialogRef}
        onClose={onClose}
        aria-label={preview ?? '画像'}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close()
        }}
        className="m-auto max-h-[90vh] max-w-[min(1100px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        {preview && (
          <figure>
            <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
              <figcaption className="truncate font-mono text-xs text-ink-2">{preview}</figcaption>
              <button
                type="button"
                onClick={() => dialogRef.current?.close()}
                className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                aria-label="閉じる"
                autoFocus
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <img
              src={runFileUrl(projectId, run.id, preview)}
              alt={preview}
              className="max-h-[80vh] w-auto bg-white object-contain"
            />
          </figure>
        )}
      </dialog>
    </div>
  )
}

/** 実験の起動のしかた (ML-Found の source.yaml) の 1 行 */
function SourceLine({ source }: { source: NonNullable<RunDetail['source']> }) {
  const items: [string, string][] = []
  if (source.script) items.push(['スクリプト', source.script])
  if (source.experiment) items.push(['experiment', source.experiment])
  if (source.overrides && source.overrides.length > 0) {
    items.push(['上書き', source.overrides.join(', ')])
  }
  if (source.model_spec) items.push(['モデルの定義', describeModelSpec(source.model_spec)])
  if (items.length === 0) return null
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-ink-3">{label}</dt>
          <dd className="font-mono break-all text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
