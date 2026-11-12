import clsx from 'clsx'
import { Check, Pencil, Star, Tag, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { RunNote } from '../../api/client'
import { useNotes, useSaveNote } from '../../api/hooks'
import { Button, Card, ErrorBox } from '../../components/ui'

const EMPTY: RunNote = { note: '', tags: [], starred: false }

// タグの数の上限 (サーバーと同じ)
const MAX_TAGS = 20

/** 星のボタン. 一覧と詳細で使う */
export function StarButton({
  starred,
  onToggle,
  label,
}: {
  starred: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={starred}
      aria-label={label}
      title={starred ? '星を外す' : '星を付ける'}
      className="rounded-md p-1 hover:bg-surface-2"
    >
      <Star
        className={clsx('size-4', starred ? 'fill-warning text-warning' : 'text-ink-3')}
        aria-hidden
      />
    </button>
  )
}

/** 実験のメモ, タグ, 星を書く欄. ダッシュボードのデータの置き場に保存する */
export function NotePanel({ projectId, runId }: { projectId: string; runId: string }) {
  const notes = useNotes(projectId)
  const save = useSaveNote(projectId)
  const saved = notes.data?.[runId] ?? EMPTY
  const noteId = useId()
  const tagId = useId()

  // 書きかけのメモとタグの入力 (保存するまで一覧には反映しない)
  const [draft, setDraft] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  // 何も書いていない実験では, 1 行にたたんで学習曲線を押し下げないようにする
  const [open, setOpen] = useState(false)
  const text = draft ?? saved.note
  const dirty = draft !== null && draft !== saved.note

  // 星とタグの変更では書きかけのメモは保存しない (保存のボタンか欄を離れたときだけ)
  const store = (next: Partial<RunNote>) => save.mutate({ runId, note: { ...saved, ...next } })

  // 画面の中で別のページに移る場合は, 書きかけを保存してから閉じる
  const pending = useRef<{ dirty: boolean; note: RunNote }>({ dirty: false, note: saved })
  useEffect(() => {
    pending.current = { dirty, note: { ...saved, note: text } }
  })
  const mutate = save.mutate
  useEffect(
    () => () => {
      if (pending.current.dirty) mutate({ runId, note: pending.current.note })
    },
    [mutate, runId],
  )

  // 書きかけのまま再読み込みやタブを閉じる場合はブラウザで確認
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const addTag = () => {
    const tag = tagInput.replace(/\s+/g, ' ').trim()
    if (!tag || saved.tags.includes(tag)) return setTagInput('')
    if (saved.tags.length >= MAX_TAGS) {
      setTagError(`タグは ${MAX_TAGS} 個までです`)
      return
    }
    setTagError(null)
    store({ tags: [...saved.tags, tag] })
    setTagInput('')
  }

  const onTagKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addTag()
    }
    if (event.key === 'Escape') setTagInput('')
  }

  // 何も書いていない実験は 1 行で表示
  const empty = !saved.note && saved.tags.length === 0 && draft === null
  if (empty && !open) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm">
        <StarButton
          starred={saved.starred}
          onToggle={() => store({ starred: !saved.starred })}
          label="この実験に星を付ける"
        />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-ink-3 hover:text-ink"
        >
          <Pencil className="size-3.5" aria-hidden />
          メモやタグを追加
        </button>
        {save.error && <span className="text-xs text-critical-text">{save.error.message}</span>}
      </div>
    )
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <StarButton
            starred={saved.starred}
            onToggle={() => store({ starred: !saved.starred })}
            label="この実験に星を付ける"
          />
          メモ
        </span>
      }
      actions={
        dirty ? (
          <Button
            variant="primary"
            icon={Check}
            onClick={() => {
              store({ note: text })
              setDraft(null)
            }}
            disabled={save.isPending}
          >
            保存
          </Button>
        ) : (
          <span className="text-xs text-ink-3" aria-live="polite">
            {save.isPending ? '保存中' : save.isSuccess ? '保存しました' : ''}
          </span>
        )
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="size-3.5 text-ink-3" aria-hidden />
          {saved.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-text"
            >
              <span className="truncate" title={tag}>
                {tag}
              </span>
              <button
                type="button"
                onClick={() => store({ tags: saved.tags.filter((item) => item !== tag) })}
                aria-label={`タグ ${tag} を外す`}
                className="-m-1 rounded-full p-1 hover:bg-accent/20"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <label htmlFor={tagId} className="sr-only">
            タグを追加
          </label>
          <input
            id={tagId}
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={onTagKey}
            maxLength={40}
            placeholder="タグを追加 (Enter)"
            className="h-7 w-40 rounded-md border border-line bg-bg px-2 text-xs outline-none focus:border-accent"
          />
        </div>
        <label htmlFor={noteId} className="sr-only">
          メモ
        </label>
        <textarea
          id={noteId}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            // 欄を離れたら書きかけを保存
            if (dirty) {
              store({ note: text })
              setDraft(null)
            }
          }}
          rows={2}
          autoFocus={empty}
          maxLength={20000}
          placeholder="この実験で試したこと, 気付いたことなど"
          className="block w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <p className="text-[11px] text-ink-3">
          ダッシュボードのデータの置き場に保存します (実験のディレクトリには書き込みません).
        </p>
        {tagError && <p className="text-xs text-critical-text">{tagError}</p>}
        {save.error && <ErrorBox error={save.error} />}
      </div>
    </Card>
  )
}
