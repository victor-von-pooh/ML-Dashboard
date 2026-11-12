import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, type JobInfo } from './client'

export const keys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  runs: (projectId: string) => ['projects', projectId, 'runs'] as const,
  run: (projectId: string, runId: string) => ['projects', projectId, 'run', runId] as const,
  history: (projectId: string, runId: string) => ['projects', projectId, 'history', runId] as const,
  log: (projectId: string, runId: string) => ['projects', projectId, 'log', runId] as const,
  config: (projectId: string, path: string) => ['projects', projectId, 'config', path] as const,
  params: (projectId: string) => ['projects', projectId, 'params'] as const,
  jobs: ['jobs'] as const,
  job: (jobId: string) => ['jobs', jobId] as const,
  jobOutput: (jobId: string) => ['jobs', jobId, 'output'] as const,
}

// 学習中の表示を更新する間隔 (ミリ秒)
const LIVE_INTERVAL = 1500

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects })
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) })
}

export function useRuns(projectId: string) {
  return useQuery({
    queryKey: keys.runs(projectId),
    queryFn: () => api.listRuns(projectId),
    // 学習中の実験がある間だけ, 一定の間隔で読み直す
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'running') ? LIVE_INTERVAL : false,
  })
}

export function useRun(projectId: string, runId: string) {
  return useQuery({
    queryKey: keys.run(projectId, runId),
    queryFn: () => api.getRun(projectId, runId),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? LIVE_INTERVAL : false),
  })
}

export function useHistory(projectId: string, runId: string, live = false) {
  return useQuery({
    queryKey: keys.history(projectId, runId),
    queryFn: () => api.getHistory(projectId, runId),
    refetchInterval: live ? LIVE_INTERVAL * 2 : false,
  })
}

/** 複数の実験の指標の推移をまとめて取得する */
export function useHistories(projectId: string, runIds: string[]) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: keys.history(projectId, runId),
      queryFn: () => api.getHistory(projectId, runId),
    })),
  })
}

/** 複数の実験の詳細をまとめて取得する */
export function useRunDetails(projectId: string, runIds: string[]) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: keys.run(projectId, runId),
      queryFn: () => api.getRun(projectId, runId),
    })),
  })
}

export function useLog(projectId: string, runId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.log(projectId, runId),
    queryFn: () => api.getLog(projectId, runId),
    enabled,
  })
}

export function useAddProject() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.addProject,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  })
}

export function useRemoveProject() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.removeProject,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  })
}

export function useScanProjects() {
  return useMutation({ mutationFn: api.scanProjects })
}

export function useConfig(projectId: string, path: string | null) {
  return useQuery({
    queryKey: keys.config(projectId, path ?? ''),
    queryFn: () => api.getConfig(projectId, path ?? ''),
    enabled: path !== null,
    staleTime: 0,
  })
}

export function useValidateConfig(projectId: string) {
  return useMutation({ mutationFn: (text: string) => api.validateConfig(projectId, text) })
}

export function useCreateJob(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createJob>[1]) => api.createJob(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

export function useJobs() {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: api.listJobs,
    // 実行中が無い間は, サイドバーの数が大まかに合っていればよいので間隔を空ける
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === 'running') ? LIVE_INTERVAL : 30_000,
  })
}

/** サイドバー用に, 実行中のジョブの数だけを取り出す */
export function useRunningJobCount() {
  const query = useJobs()
  return query.data?.filter((job) => job.status === 'running').length ?? 0
}

export function useJob(jobId: string) {
  return useQuery({
    queryKey: keys.job(jobId),
    queryFn: () => api.getJob(jobId),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? LIVE_INTERVAL : false),
  })
}

export function useJobOutput(jobId: string, live: boolean) {
  return useQuery({
    queryKey: keys.jobOutput(jobId),
    queryFn: () => api.getJobOutput(jobId),
    refetchInterval: live ? LIVE_INTERVAL : false,
  })
}

export function useStopJob() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ jobId, force }: { jobId: string; force: boolean }) => api.stopJob(jobId, force),
    onSuccess: (job) => {
      // 一覧の表示もすぐに更新し, 止めるボタンを続けて押せないようにする
      client.setQueryData(keys.job(job.id), job)
      client.setQueryData<JobInfo[]>(keys.jobs, (list) =>
        list?.map((item) => (item.id === job.id ? job : item)),
      )
      void client.invalidateQueries({ queryKey: keys.jobs, exact: true })
    },
  })
}

export function useRunParams(projectId: string) {
  return useQuery({ queryKey: keys.params(projectId), queryFn: () => api.listParams(projectId) })
}
