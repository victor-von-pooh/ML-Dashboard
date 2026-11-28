import { Clock, FlaskConical, FolderKanban, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import type { ProjectInfo } from '../../api/client'
import { useMoveProject, useProblemProject, useProjects, useRemoveProject } from '../../api/hooks'
import { Button, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { STAGE_NAME, useStage } from '../../lib/stage'
import { AddProjectDialog } from './AddProjectDialog'
import { SelectedProblem } from './SelectedProblem'

function ProjectCard({ project }: { project: ProjectInfo }) {
  const remove = useRemoveProject()
  const move = useMoveProject()

  const onRemove = () => {
    if (
      window.confirm(
        `「${project.name}」の登録を外しますか? 実験のファイルは消えませんが, この段階で付けたメモ, タグ, 星は消えます (ディレクトリを移した場合は「場所を変える」でメモを残せます).`,
      )
    ) {
      remove.mutate(project.id)
    }
  }
  // ディレクトリを移した場合に, 登録 (メモ, タグ, 星) を残したまま場所を変える
  const onMove = () => {
    const typed = window.prompt(`「${project.name}」の新しいディレクトリ`, project.path)
    // 前後の空白と引用符 (ターミナルから貼ったパスなど) を除く
    const path = typed?.trim().replace(/^['"]|['"]$/g, '')
    if (path && path !== project.path) move.mutate({ id: project.id, path })
  }

  // カード全体を押せるように, リンクの疑似要素を広げ, 削除のボタンはその上に重ねる
  return (
    <div className="group relative flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-accent-soft p-2 text-accent-text">
          <FolderKanban className="size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">
            <Link
              to={`/projects/${project.id}`}
              className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
            >
              {project.name}
            </Link>
          </h3>
          <p
            className="truncate font-mono text-xs text-ink-3 [direction:rtl] text-left"
            title={project.path}
          >
            <bdi>{project.path}</bdi>
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={remove.isPending}
          className="relative z-10 rounded-md p-1 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:bg-critical/10 hover:text-critical-text focus-visible:opacity-100"
          aria-label={`${project.name} の登録を外す`}
          title="登録を外す"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-4 text-xs text-ink-2">
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <FlaskConical className="size-3.5" aria-hidden />
          <span className="tabular-nums">{project.run_count}</span> 実験
        </span>
        {project.latest_run && (
          <span className="flex min-w-0 items-center gap-1">
            <Clock className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular-nums truncate">最新 {project.latest_run}</span>
          </span>
        )}
      </div>
      {project.error && (
        <div className="relative z-10 space-y-1">
          <p className="flex items-start gap-1 text-xs text-critical-text">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="break-all">{project.error}</span>
          </p>
          {/* ディレクトリが見つからない場合だけ (移した場合. API の文は「ディレクトリ <場所> が見つかりません」) */}
          {/^ディレクトリ .+ が見つかりません$/s.test(project.error) && (
            <Button
              variant="secondary"
              onClick={onMove}
              disabled={move.isPending}
              aria-label={`${project.name} の場所を変える`}
            >
              場所を変える
            </Button>
          )}
        </div>
      )}
      {move.error && (
        <div className="relative z-10">
          <ErrorBox error={move.error} />
        </div>
      )}
      {remove.error && (
        <div className="relative z-10">
          <ErrorBox error={remove.error} />
        </div>
      )}
    </div>
  )
}

export function ProjectsPage() {
  const projects = useProjects()
  const [open, setOpen] = useState(false)
  // 殻で選んだ問題 (記録したプロジェクトを開けるなら, 一覧をそれに絞る)
  const { project: problemId } = useStage()
  const problem = useProblemProject(problemId)
  // 絞りを外したか (殻が選び直したら, また絞る)
  const [showAll, setShowAll] = useState(false)
  const [seenProblem, setSeenProblem] = useState(problemId)
  if (seenProblem !== problemId) {
    setSeenProblem(problemId)
    setShowAll(false)
  }
  const narrowable = problemId !== null && Boolean(problem.data?.project_path)
  const narrowed = narrowable && !showAll
  const shown = narrowed
    ? projects.data?.filter((item) => item.id === problem.data?.project_id)
    : projects.data

  return (
    <>
      <PageHeader
        title={STAGE_NAME}
        subtitle="ML-Found で学習したプロジェクトの実験を確かめます"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            プロジェクトを登録
          </Button>
        }
      />
      {problemId !== null && (
        <SelectedProblem
          problemId={problemId}
          narrowed={narrowable ? narrowed : null}
          onNarrow={(narrow) => setShowAll(!narrow)}
        />
      )}
      <h2 className="mb-3 text-sm font-semibold">プロジェクト</h2>
      {projects.isPending && <Spinner />}
      {projects.error && <ErrorBox error={projects.error} live={false} />}
      {projects.data?.length === 0 && (
        <EmptyState icon={FolderKanban} title="プロジェクトがありません" level={3}>
          <p>
            ML-Found を使っているディレクトリ (<code>configs/default/train.yaml</code> を持つもの)
            を登録すると, その実験の一覧と学習曲線を見られます.
          </p>
          <Button variant="primary" icon={Plus} className="mt-4" onClick={() => setOpen(true)}>
            プロジェクトを登録
          </Button>
        </EmptyState>
      )}
      {narrowed && projects.data && projects.data.length > 0 && shown?.length === 0 && (
        <p className="text-sm text-ink-3">
          選んだ問題のプロジェクトは登録していません. 上の「登録して開く」で登録するか,
          「全てのプロジェクトを出す」で登録したプロジェクトを見られます.
        </p>
      )}
      {shown && shown.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      {open && <AddProjectDialog onClose={() => setOpen(false)} />}
    </>
  )
}
