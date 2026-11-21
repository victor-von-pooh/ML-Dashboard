import { Play, Terminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router'

import { useBatches, useJob, useJobOutput, useJobs } from '../../api/hooks'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { batchLabels } from '../../lib/batches'
import { BatchCard } from './BatchCard'
import { JobCard } from './JobCard'

/** ダッシュボードから起動した学習の一覧 */
export function JobsPage() {
  const jobs = useJobs()
  const running = jobs.data?.filter((job) => job.status === 'running') ?? []
  const finished = jobs.data?.filter((job) => job.status !== 'running') ?? []
  const batches = useBatches()
  const labels = batchLabels(batches.data ?? [])

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
      {batches.error && <ErrorBox error={batches.error} />}
      {(batches.data?.length ?? 0) > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">候補のまとまり ({batches.data?.length})</h2>
          <div className="space-y-3">
            {batches.data?.map((batch) => (
              <BatchCard key={batch.id} batch={batch} jobs={jobs.data ?? []} />
            ))}
          </div>
        </section>
      )}
      {running.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">実行中 ({running.length})</h2>
          <div className="space-y-3">
            {running.map((job) => (
              <JobCard key={job.id} job={job} batchLabel={labels.get(job.id)} />
            ))}
          </div>
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold">終了 ({finished.length})</h2>
          <div className="space-y-3">
            {finished.map((job) => (
              <JobCard key={job.id} job={job} batchLabel={labels.get(job.id)} />
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
  const following = useRef(true)

  // 学習が終わったら, 最後の出力を読むためにもう一度読み直す
  const wasRunning = useRef(false)
  const refetchOutput = output.refetch
  useEffect(() => {
    if (wasRunning.current && !running) void refetchOutput()
    wasRunning.current = running
  }, [running, refetchOutput])

  // 末尾を見ている場合だけ, 新しい出力に合わせて末尾まで送る
  useEffect(() => {
    const element = consoleRef.current
    if (element && following.current) element.scrollTop = element.scrollHeight
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
          <JobCard job={job.data} detail />
          <Card
            title={
              <span className="flex items-center gap-2">
                <Terminal className="size-4" aria-hidden />
                標準出力 (末尾)
              </span>
            }
            padded={false}
          >
            {output.error && <ErrorBox error={output.error} live={false} />}
            <pre
              ref={consoleRef}
              onScroll={(event) => {
                const element = event.currentTarget
                following.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40
              }}
              tabIndex={0}
              aria-label="学習の標準出力"
              className="max-h-[480px] overflow-auto bg-surface-2/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2"
            >
              {output.isPending ? '読み込み中' : output.data?.text || '(まだ出力はありません)'}
            </pre>
          </Card>
        </div>
      )}
    </>
  )
}
