import { useQueryClient } from '@tanstack/react-query'
import { FolderSearch, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { api, type ProjectCandidate } from '../../api/client'
import { keys, useScanProjects } from '../../api/hooks'
import { Button, ErrorBox } from '../../components/ui'

/** ディレクトリを入力して, その下の ML-Found のプロジェクトをまとめて登録するダイアログ */
export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const client = useQueryClient()
  const scan = useScanProjects()
  const [path, setPath] = useState('')
  const [candidates, setCandidates] = useState<ProjectCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<unknown>(null)

  // open に合わせてネイティブのダイアログを開閉し, 開いたら入力欄に移る
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      inputRef.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  // 閉じたら次に開いたときのために入力と結果を消去
  const close = () => {
    setPath('')
    setCandidates([])
    setSelected(new Set())
    setAddError(null)
    scan.reset()
    onClose()
  }

  const onScan = (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    setAddError(null)
    scan.mutate(path.trim(), {
      onSuccess: (found) => {
        setCandidates(found)
        setSelected(new Set(found.filter((item) => !item.registered).map((item) => item.path)))
      },
    })
  }

  // 1 件ずつ登録し, 登録できたものは選択から外して登録済みにする
  const onAdd = async () => {
    setAdding(true)
    setAddError(null)
    let failed = false
    for (const target of selected) {
      try {
        await api.addProject({ path: target })
        setSelected((previous) => {
          const next = new Set(previous)
          next.delete(target)
          return next
        })
        setCandidates((previous) =>
          previous.map((item) => (item.path === target ? { ...item, registered: true } : item)),
        )
      } catch (error) {
        setAddError(error)
        failed = true
        break
      }
    }
    await client.invalidateQueries({ queryKey: keys.projects, exact: true })
    setAdding(false)
    if (!failed) dialogRef.current?.close()
  }

  const toggle = (target: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })

  const addable = candidates.filter((item) => !item.registered)

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        // 登録の途中で閉じられた場合は開き直し, 結果が分かるようにする
        if (adding) dialogRef.current?.showModal()
        else close()
      }}
      onCancel={(event) => {
        if (adding) event.preventDefault()
      }}
      className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          プロジェクトを追加
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          disabled={adding}
          className="rounded-lg p-1 text-ink-3 hover:bg-surface-2"
          aria-label="閉じる"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-ink-2">
          ML-Found のプロジェクト (
          <code className="font-mono text-xs">configs/default/train.yaml</code> を持つディレクトリ)
          か, それを含むディレクトリのパスを入力してください. 3 階層下までまとめて探します
          (隠しディレクトリ, outputs, data などは除きます).
        </p>
        <form onSubmit={onScan} className="flex gap-2">
          <input
            ref={inputRef}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            aria-label="探すディレクトリのパス"
            placeholder="例: ~/projects/my-experiments"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-sm outline-none focus:border-accent"
          />
          <Button
            type="submit"
            variant="primary"
            icon={FolderSearch}
            disabled={scan.isPending || adding}
          >
            探す
          </Button>
        </form>

        {scan.error && <ErrorBox error={scan.error} />}
        {scan.isSuccess && candidates.length === 0 && (
          <p className="text-sm text-ink-3">ML-Found のプロジェクトは見つかりませんでした.</p>
        )}

        {candidates.length > 0 && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
            {candidates.map((item) => (
              <label
                key={item.path}
                className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={item.registered || selected.has(item.path)}
                  disabled={item.registered || adding}
                  onChange={() => toggle(item.path)}
                  className="size-4 accent-[var(--accent)]"
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="truncate font-mono text-xs text-ink-3">{item.path}</div>
                </div>
                {item.registered && <span className="ml-auto text-xs text-ink-3">登録済み</span>}
              </label>
            ))}
          </div>
        )}
        {addError != null && <ErrorBox error={addError} />}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
        <span className="text-xs text-ink-3">
          {candidates.length > 0 && `${addable.length} 件中 ${selected.size} 件を選択`}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => dialogRef.current?.close()} disabled={adding}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={onAdd} disabled={selected.size === 0 || adding}>
            {selected.size > 0 ? `${selected.size} 件を追加` : '追加'}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
