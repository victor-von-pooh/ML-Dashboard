import { Play, Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router'

import { useJob, useJobOutput, useJobs } from '../../api/hooks'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { JobCard } from './JobCard'

/** ダッシュボードから起動した学習の一覧 */
export function JobsPage() {
  const jobs = useJobs()
  const running = jobs.data?.filter((job) => job.status === 'running') ?? []
  const finished = jobs.data?.filter((job) => job.status !== 'running') ?? []

  return (
    <>
      <PageHeader
        title="ジョブ"
        subtitle="ダッシュボードから起動した学習の進み具合を確かめ, 止めます"
      />
      {jobs.isPending && <Spinner />}
      {jobs.error && <ErrorBox error={jobs.error} />}
      {jobs.data?.length === 0 && (
        <EmptyState icon={Play} title="まだ学習を起動していません">
          プロジェクトの実験の一覧にある「学習を起動」から, config を選んで学習を始められます.
        </EmptyState>
      )}
      {running.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">実行中 ({running.length})</h2>
          <div className="space-y-3">
            {running.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold">終了 ({finished.length})</h2>
          <div className="space-y-3">
            {finished.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

/** 1 つのジョブの進み具合と標準出力 */
export function JobDetailPage() {
  const { jobId = '' } = useParams()
  const job = useJob(jobId)
  const running = job.data?.status === 'running'
  const output = useJobOutput(jobId, running)
  const consoleRef = useRef<HTMLPreElement>(null)

  // 新しい出力が来たら末尾まで送る
  useEffect(() => {
    const element = consoleRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output.data?.text])

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/jobs" className="hover:text-ink">
            ジョブ
          </Link>
        }
        title={
          job.data ? `${job.data.project_name ?? job.data.project_id} / ${job.data.script}` : jobId
        }
      />
      {job.isPending && <Spinner />}
      {job.error && <ErrorBox error={job.error} />}
      {job.data && (
        <div className="space-y-4">
          <JobCard job={job.data} showDetailLink={false} />
          <Card
            title={
              <span className="flex items-center gap-2">
                <Terminal className="size-4" aria-hidden />
                標準出力 (末尾)
              </span>
            }
            padded={false}
          >
            <pre
              ref={consoleRef}
              tabIndex={0}
              aria-label="学習の標準出力"
              className="max-h-[480px] overflow-auto bg-surface-2/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2"
            >
              {output.data?.text || '(まだ出力はありません)'}
            </pre>
          </Card>
        </div>
      )}
    </>
  )
}
