import { ClipboardList, FlaskConical, ListFilter, Play, Plus, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import { useAddProject, useProblemProject } from '../../api/hooks'
import { Button, Card, ErrorBox, Spinner } from '../../components/ui'

// リンクをボタンと同じ見た目にする
const linkClass =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2'

/**
 * 殻で選んだ問題の欄. 記録したプロジェクトを登録していれば開く先を, していなければ
 * 登録して開くボタンを, 開けなければ理由を出す. 一覧の絞りを切り替えるボタンも置く
 */
export function SelectedProblem({
  problemId,
  narrowed,
  onNarrow,
}: {
  /** 殻で選んだ問題の識別子 */
  problemId: string
  /** 一覧を記録したプロジェクトに絞っているか (絞れない問題の設定では null) */
  narrowed: boolean | null
  /** 絞りを切り替える */
  onNarrow: (narrow: boolean) => void
}) {
  const problem = useProblemProject(problemId)
  const add = useAddProject()
  const navigate = useNavigate()
  const pathLabelId = useId()
  const data = problem.data
  // 置き場に無い識別子 (殻の選びが古いなど) は, 誤りの箱でなく文で出す
  const missing = problem.error instanceof ApiError && problem.error.status === 404

  const register = (path: string) =>
    add.mutate({ path }, { onSuccess: (created) => navigate(`/projects/${created.id}`) })

  return (
    <Card
      className="mb-6"
      title={
        <span className="flex items-center gap-2">
          <ClipboardList className="size-4 text-accent" aria-hidden />
          選んだ問題
        </span>
      }
      actions={
        narrowed !== null && (
          <Button variant="secondary" icon={ListFilter} onClick={() => onNarrow(!narrowed)}>
            {narrowed ? '全てのプロジェクトを出す' : 'このプロジェクトだけを出す'}
          </Button>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {problem.isPending && <Spinner />}
        {missing && (
          <p className="flex items-start gap-1.5 text-warning-text">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {/* 見つからない物の文は API が「問題 <識別子> が見つかりません」で返す */}
            <span className="break-all">{problem.error?.message}</span>
          </p>
        )}
        {problem.error && !missing && <ErrorBox error={problem.error} live={false} />}
        {data && (
          <>
            <div>
              <div className="font-medium">{data.problem}</div>
              <div className="font-mono text-xs text-ink-3">{data.id}</div>
              {/* 場所は「記録したプロジェクト」を名前にした組 (group) で読み上げる. Playwright の名前の
                  計算は ARIA 1.3 に従い, term と definition の名前を計算しないため */}
              {data.project_path && (
                <div role="group" aria-labelledby={pathLabelId} className="mt-1 text-xs text-ink-2">
                  <span id={pathLabelId}>記録したプロジェクト</span>
                  <span aria-hidden>:</span>{' '}
                  <span className="font-mono break-all">{data.project_path}</span>
                </div>
              )}
            </div>
            {data.reason && (
              <p className="flex items-start gap-1.5 text-warning-text">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="break-all">{data.reason}</span>
              </p>
            )}
            {data.project_id && (
              <div className="flex flex-wrap gap-2">
                <Link to={`/projects/${data.project_id}`} className={linkClass}>
                  <FlaskConical className="size-4" aria-hidden />
                  実験の一覧を開く
                </Link>
                <Link to={`/projects/${data.project_id}/launch`} className={linkClass}>
                  <Play className="size-4" aria-hidden />
                  学習を起動
                </Link>
              </div>
            )}
            {data.project_path && !data.project_id && (
              <div className="space-y-2">
                <p className="text-ink-2">このプロジェクトはまだ登録していません.</p>
                <Button
                  variant="primary"
                  icon={Plus}
                  onClick={() => register(data.project_path ?? '')}
                  disabled={add.isPending}
                >
                  登録して開く
                </Button>
              </div>
            )}
            {add.error && <ErrorBox error={add.error} />}
          </>
        )}
      </div>
    </Card>
  )
}
