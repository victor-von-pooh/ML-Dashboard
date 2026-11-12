import clsx from 'clsx'
import { Download, ExternalLink, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { runFileUrl, type LogEntry, type RunDetail } from '../../api/client'
import { Card } from '../../components/ui'
import { formatBytes, formatValue } from '../../lib/format'
import { flattenConfig } from '../../lib/metrics'

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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card title="default との差分" padded={false}>
        {changed.size === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-3">default のまま学習しました.</p>
        ) : (
          <table className="w-full text-sm">
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
                    <td className="px-4 py-1.5 font-mono text-xs text-ink-2">{key}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-ink-3 line-through decoration-ink-3/40">
                      {formatValue(item.default)}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs font-medium">
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

export function ModelTab({ run }: { run: RunDetail }) {
  const blocks: [string, string | null | undefined][] = [
    ['モデルの構造', run.model_structure],
    ['Optimizer', run.optimizer],
    ['Scheduler', run.scheduler],
  ]
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {blocks.map(([title, text]) => (
        <Card key={title} title={title} className={title === 'モデルの構造' ? 'lg:row-span-2' : ''}>
          {text ? (
            <pre className="max-h-[520px] overflow-auto font-mono text-xs leading-relaxed text-ink-2">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-ink-3">ログに記録がありません.</p>
          )}
        </Card>
      ))}
    </div>
  )
}

export function EnvTab({ run, projectId }: { run: RunDetail; projectId: string }) {
  const [query, setQuery] = useState('')
  const packages = Object.entries(run.packages).filter(([name]) =>
    name.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="grid gap-4 lg:grid-cols-2">
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
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
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

const LEVELS = ['INFO', 'WARNING', 'ERROR'] as const

export function LogTab({ entries }: { entries: LogEntry[] }) {
  const [query, setQuery] = useState('')
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS))
  const counts = useMemo(() => {
    const result: Record<string, number> = {}
    for (const entry of entries) {
      const level = entry.level === 'CRITICAL' ? 'ERROR' : (entry.level ?? 'INFO')
      result[level] = (result[level] ?? 0) + 1
    }
    return result
  }, [entries])

  const visible = entries.filter((entry) => {
    const level = entry.level === 'CRITICAL' ? 'ERROR' : (entry.level ?? 'INFO')
    return levels.has(level) && entry.message.toLowerCase().includes(query.toLowerCase())
  })

  const toggle = (level: string) =>
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
                  ? 'border-accent/40 bg-accent-soft text-accent'
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
        {visible.map((entry, index) => (
          <div
            key={index}
            className={clsx(
              'flex gap-3 border-l-2 px-4 py-0.5',
              entry.level === 'WARNING' && 'border-warning bg-warning/10',
              (entry.level === 'ERROR' || entry.level === 'CRITICAL') &&
                'border-critical bg-critical/10',
              (entry.level === 'INFO' || !entry.level) && 'border-transparent',
            )}
          >
            <span className="tabular shrink-0 text-ink-3">{entry.time?.slice(11, 19) ?? ''}</span>
            <span className="whitespace-pre-wrap break-all text-ink-2">{entry.message}</span>
          </div>
        ))}
        {visible.length === 0 && <p className="px-4 py-6 text-ink-3">該当する行はありません.</p>}
      </div>
    </Card>
  )
}

export function FilesTab({ run, projectId }: { run: RunDetail; projectId: string }) {
  const images = run.files.filter((file) => file.kind === 'image')
  const [preview, setPreview] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      {images.length > 0 && (
        <Card title={`画像 (${images.length})`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {images.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setPreview(file.path)}
                className="group overflow-hidden rounded-lg border border-line bg-white text-left"
              >
                <img
                  src={runFileUrl(projectId, run.id, file.path)}
                  alt={file.path}
                  loading="lazy"
                  className="aspect-[4/3] w-full object-contain transition group-hover:scale-[1.02]"
                />
                <div className="truncate border-t border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink-2">
                  {file.path}
                </div>
              </button>
            ))}
          </div>
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
                <td className="px-4 py-1.5 font-mono text-xs">{file.path}</td>
                <td className="px-4 py-1.5 text-xs text-ink-3">{file.kind}</td>
                <td className="tabular px-4 py-1.5 text-right text-xs text-ink-2">
                  {formatBytes(file.size)}
                </td>
                <td className="w-10 px-2 py-1.5">
                  <a
                    href={runFileUrl(projectId, run.id, file.path)}
                    download
                    className="inline-flex rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                    aria-label={`${file.path} をダウンロード`}
                  >
                    <Download className="size-3.5" aria-hidden />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {preview && (
        <div
          role="dialog"
          aria-label={preview}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => setPreview(null)}
          onKeyDown={(event) => event.key === 'Escape' && setPreview(null)}
          tabIndex={-1}
        >
          <figure className="max-h-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <img
              src={runFileUrl(projectId, run.id, preview)}
              alt={preview}
              className="max-h-[80vh] w-auto object-contain"
            />
            <figcaption className="bg-surface px-3 py-2 font-mono text-xs text-ink-2">
              {preview}
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}
