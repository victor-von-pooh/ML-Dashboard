import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClipboardList, FolderSearch, Plus } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'

import { useApi, type ProjectCandidate, type RecordedProject } from '../../api/client'
import { keys, useProblemProject, useRecordedProjects, useScanProjects } from '../../api/hooks'
import { describedBy } from '../../components/common-utils'
import { Button, Dialog, ErrorBox, Spinner } from '../../components/ui'
import { problemIdOf, useStage } from '../../lib/stage'

/**
 * ML-Pathfinder の問題の設定に記録された, 登録していないプロジェクトの一覧.
 * 押すとそのプロジェクトを登録する (場所を打たずに済むように)
 */
function RecordedProjects({
  busy,
  onBusy,
}: {
  /** 他の登録の途中か */
  busy: boolean
  /** 登録の途中かを知らせる (途中で閉じないように) */
  onBusy: (busy: boolean) => void
}) {
  const client = useQueryClient()
  const api = useApi()
  const stage = useStage()
  // 殻で選んだ問題が記録したプロジェクト (同じプロジェクトなら選びを移さないため)
  const chosen = useProblemProject(stage.project)
  const recorded = useRecordedProjects(true)
  const titleId = useId()
  const [added, setAdded] = useState<string | null>(null)
  const register = useMutation({
    mutationFn: (item: RecordedProject) => api.addProject({ path: item.path }),
    onMutate: () => {
      setAdded(null)
      onBusy(true)
    },
    onSuccess: (project, item) => {
      setAdded(project.name)
      // 置き場の問題の設定から登録したので, 殻の選びをその問題の設定にする. 同じ識別子と,
      // 殻で選んだ問題も同じプロジェクトを記録している場合は知らせない (一覧は同じ
      // プロジェクトを記録した問題の設定のうち新しい 1 件だけを出すので, 殻の選びを優先する)
      const problem = problemIdOf(item.problem_path)
      if (problem === null || problem === stage.project) return
      if (stage.project !== null && chosen.data?.project_path === item.path) return
      stage.onProjectChange(problem)
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.projects, exact: true }),
        client.invalidateQueries({ queryKey: keys.recorded }),
        client.invalidateQueries({ queryKey: keys.problemProjects }),
      ])
      onBusy(false)
    },
  })
  const list = recorded.data
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h3 id={titleId} className="text-sm font-semibold">
        問題の設定の段階で書き出したプロジェクト
      </h3>
      {recorded.isPending && <Spinner />}
      {recorded.error && <ErrorBox error={recorded.error} live={false} />}
      {list?.error && <p className="text-xs text-critical-text">{list.error}</p>}
      {list?.skipped.map((reason) => (
        <p key={reason} className="text-xs text-warning-text">
          {reason}
        </p>
      ))}
      {list && list.projects.length === 0 && !list.error && (
        <p className="text-xs text-ink-3">
          登録していない書き出したプロジェクトはありません (置き場:{' '}
          <span className="font-mono break-all">{list.root}</span>). 下の欄で場所を書いて探せます.
        </p>
      )}
      {list && list.projects.length > 0 && (
        <ul
          aria-label="登録していない書き出したプロジェクト"
          className="max-h-48 overflow-y-auto rounded-lg border border-line"
        >
          {list.projects.map((item) => (
            <li
              key={item.path}
              className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <ClipboardList className="size-4 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{item.name}</div>
                <div className="truncate font-mono text-xs text-ink-3" title={item.path}>
                  {item.path}
                </div>
                <div className="truncate text-xs text-ink-2">問題: {item.problem}</div>
              </div>
              <Button
                icon={Plus}
                onClick={() => register.mutate(item)}
                disabled={busy || register.isPending}
                aria-label={`${item.name} を登録`}
              >
                登録
              </Button>
            </li>
          ))}
        </ul>
      )}
      {register.error != null && <ErrorBox error={register.error} />}
      <p role="status" className="text-xs text-good-text">
        {added ? `${added} を登録しました` : ''}
      </p>
    </section>
  )
}

/**
 * 問題の設定の段階で書き出したプロジェクトを選んで登録するか, ディレクトリを入力して,
 * その下の ML-Found のプロジェクトをまとめて登録するダイアログ. 開いている間だけ置き,
 * 閉じたら外す (次に開いたときに入力と結果が残らないように)
 */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const scanErrorId = useId()
  const client = useQueryClient()
  const api = useApi()
  const scan = useScanProjects()
  const [path, setPath] = useState('')
  const [candidates, setCandidates] = useState<ProjectCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<unknown>(null)
  // 一覧からの登録の途中か (途中で閉じないように)
  const [registering, setRegistering] = useState(false)
  const busy = adding || registering

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
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.projects, exact: true }),
      client.invalidateQueries({ queryKey: keys.problemProjects }),
    ])
    setAdding(false)
    if (!failed) onClose()
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
    <Dialog title="プロジェクトを登録" onClose={onClose} busy={busy} initialFocus={inputRef}>
      <div className="space-y-4">
        <RecordedProjects busy={busy} onBusy={setRegistering} />
        <hr className="border-line" />
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
            aria-describedby={describedBy(scan.error != null && scanErrorId)}
            placeholder="例: ~/projects/my-experiments"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-sm outline-none focus:border-accent"
          />
          <Button
            type="submit"
            variant="primary"
            icon={FolderSearch}
            disabled={scan.isPending || busy}
          >
            探す
          </Button>
        </form>

        {scan.error && <ErrorBox id={scanErrorId} error={scan.error} live={false} />}
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

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-xs text-ink-3">
          {candidates.length > 0 && `${addable.length} 件中 ${selected.size} 件を選択`}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            やめる
          </Button>
          <Button variant="primary" onClick={onAdd} disabled={selected.size === 0 || busy}>
            {selected.size > 0 ? `${selected.size} 件を登録` : '登録'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
