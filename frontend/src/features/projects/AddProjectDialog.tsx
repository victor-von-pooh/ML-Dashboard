import { FolderSearch, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { useAddProject, useScanProjects } from '../../api/hooks'
import { Button, ErrorBox } from '../../components/ui'

/** ディレクトリを入力して, その下の ML-Found のプロジェクトをまとめて登録するダイアログ */
export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const scan = useScanProjects()
  const add = useAddProject()
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<unknown>(null)

  // open に合わせてネイティブのダイアログを開閉
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const candidates = scan.data ?? []
  const addable = candidates.filter((item) => !item.registered)

  const onScan = (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    setAddError(null)
    scan.mutate(path.trim(), {
      onSuccess: (found) =>
        setSelected(new Set(found.filter((item) => !item.registered).map((item) => item.path))),
    })
  }

  const onAdd = async () => {
    setAdding(true)
    setAddError(null)
    try {
      for (const target of selected) {
        await add.mutateAsync({ path: target })
      }
      setSelected(new Set())
      scan.reset()
      setPath('')
      onClose()
    } catch (error) {
      setAddError(error)
    } finally {
      setAdding(false)
    }
  }

  const toggle = (target: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="m-auto w-[min(640px,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold">プロジェクトを追加</h2>
        <button
          type="button"
          onClick={onClose}
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
          か, それを含むディレクトリのパスを入力してください. 下の階層からまとめて探します.
        </p>
        <form onSubmit={onScan} className="flex gap-2">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="例: ~/projects/my-experiments"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-sm outline-none focus:border-accent"
            autoFocus
          />
          <Button type="submit" variant="primary" icon={FolderSearch} disabled={scan.isPending}>
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
                  disabled={item.registered}
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
          <Button variant="ghost" onClick={onClose}>
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
