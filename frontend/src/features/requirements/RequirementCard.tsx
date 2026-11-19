import clsx from 'clsx'
import { Check, CheckCircle2, CircleHelp, Copy, ExternalLink, XCircle } from 'lucide-react'
import { useState } from 'react'

import type { Requirement } from '../../api/client'
import { availability, safeUrl } from '../../lib/requirements'

/** 確かめ方の種類の表示 */
const CHECK_KINDS: Record<string, string> = {
  module: 'モジュール',
  command: 'コマンド',
  function: '関数',
}

/** コマンドをクリップボードに写すボタン. 写せない環境では選んで写すように知らせる */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('クリップボードを使えません')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={`${label} をコピー`}
      >
        {state === 'copied' ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {state === 'copied' ? 'コピーした' : 'コピー'}
      </button>
      <span
        role="status"
        className={clsx(state === 'failed' ? 'text-xs text-warning-text' : 'sr-only')}
      >
        {state === 'copied' && `${label} をコピーしました`}
        {state === 'failed' && 'コピーできませんでした. 選んでコピーしてください'}
      </span>
    </>
  )
}

function CommandLine({ command, label }: { command: string; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs break-all select-all">
        {command}
      </code>
      <CopyButton text={command} label={label} />
    </div>
  )
}

/** 1 つの機能の要るもの, 入っているか, 入れ方のカード (ML-Found の describe_requirements) */
export function RequirementCard({ requirement }: { requirement: Requirement }) {
  const status = availability(requirement.available)
  const StatusIcon = status.icon
  const install = requirement.install
  const url = safeUrl(install.url)
  return (
    <section
      aria-label={`追加の依存 ${requirement.name}`}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-base font-semibold">{requirement.name}</h3>
        <span
          className={clsx(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            status.className,
          )}
        >
          <StatusIcon className="size-3.5" aria-hidden />
          {status.label}
        </span>
      </header>
      <p className="text-ink-2">{requirement.description}</p>

      <div>
        <h4 className="mb-1 text-xs font-medium text-ink-3">
          要るもの ({requirement.match === 'any' ? 'どれか 1 つ' : '全て'})
        </h4>
        <ul className="space-y-0.5 text-xs">
          {requirement.checks.map((check) => (
            <li key={`${check.kind}:${check.name}`} className="flex items-center gap-1.5">
              {check.ok === true ? (
                <CheckCircle2 className="size-3.5 text-good-text" aria-hidden />
              ) : check.ok === false ? (
                <XCircle className="size-3.5 text-critical-text" aria-hidden />
              ) : (
                <CircleHelp className="size-3.5 text-ink-3" aria-hidden />
              )}
              <span className="text-ink-3">{CHECK_KINDS[check.kind] ?? check.kind}</span>
              <span className="font-mono">{check.name}</span>
              <span className="text-ink-3">
                {check.ok === true ? 'ある' : check.ok === false ? '無い' : '確かめていない'}
              </span>
              {check.error && <span className="text-warning-text">({check.error})</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-ink-3">
          {requirement.available === true ? '入れ方' : '次の一手'}
        </h4>
        {install.kind === 'pip' && install.command && (
          <CommandLine command={install.command} label={`${requirement.name} の pip のコマンド`} />
        )}
        {install.kind === 'pip' && install.extra_command && (
          <div className="space-y-1">
            <p className="text-xs text-ink-3">ML-Found の追加の依存として入れる場合</p>
            <CommandLine
              command={install.extra_command}
              label={`${requirement.name} の追加の依存のコマンド`}
            />
          </div>
        )}
        {install.kind !== 'pip' && (
          <p className="text-xs text-ink-2">pip では入りません. 公式の手順に従って入れます.</p>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {install.kind === 'pip' ? '説明' : '公式の手順'}
            <span className="sr-only"> ({requirement.name}, 新しいタブで開く)</span>
          </a>
        )}
      </div>

      {requirement.note && <p className="text-xs text-ink-3">補足: {requirement.note}</p>}
    </section>
  )
}
