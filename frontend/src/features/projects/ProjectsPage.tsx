import { Clock, FlaskConical, FolderKanban, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import type { ProjectInfo } from '../../api/client'
import { useProjects, useRemoveProject } from '../../api/hooks'
import { Button, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { AddProjectDialog } from './AddProjectDialog'

function ProjectCard({ project }: { project: ProjectInfo }) {
  const remove = useRemoveProject()

  const onRemove = () => {
    if (window.confirm(`「${project.name}」の登録を外しますか? 実験のファイルは消えません.`)) {
      remove.mutate(project.id)
    }
  }

  // カード全体を押せるように, リンクの疑似要素を広げ, 削除のボタンはその上に重ねる
  return (
    <div className="group relative flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-accent-soft p-2 text-accent-strong">
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
          <p className="truncate font-mono text-xs text-ink-3" title={project.path}>
            {project.path}
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
        <span className="flex items-center gap-1">
          <FlaskConical className="size-3.5" aria-hidden />
          <span className="tabular">{project.run_count}</span> 実験
        </span>
        {project.latest_run && (
          <span className="flex min-w-0 items-center gap-1">
            <Clock className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular truncate">最新 {project.latest_run}</span>
          </span>
        )}
      </div>
      {project.error && (
        <p className="flex items-start gap-1 text-xs text-critical-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-all">{project.error}</span>
        </p>
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

  return (
    <>
      <PageHeader
        title="プロジェクト"
        subtitle="ML-Found で学習したプロジェクトの実験を確かめます"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            プロジェクトを追加
          </Button>
        }
      />
      {projects.isPending && <Spinner />}
      {projects.error && <ErrorBox error={projects.error} />}
      {projects.data?.length === 0 && (
        <EmptyState icon={FolderKanban} title="プロジェクトがありません">
          <p>
            ML-Found を使っているディレクトリ (<code>configs/default/train.yaml</code> を持つもの)
            を追加すると, その実験の一覧と学習曲線を見られます.
          </p>
          <Button variant="primary" icon={Plus} className="mt-4" onClick={() => setOpen(true)}>
            プロジェクトを追加
          </Button>
        </EmptyState>
      )}
      {projects.data && projects.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      <AddProjectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
