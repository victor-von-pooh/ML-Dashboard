import { useEffect, useRef, useState } from 'react'

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, type JobInfo, type RunNote } from './client'

export const keys = {
  projects: ['projects'] as const,
  recorded: ['problems', 'projects'] as const,
  project: (id: string) => ['projects', id] as const,
  runs: (projectId: string) => ['projects', projectId, 'runs'] as const,
  run: (projectId: string, runId: string) => ['projects', projectId, 'run', runId] as const,
  history: (projectId: string, runId: string) => ['projects', projectId, 'history', runId] as const,
  log: (projectId: string, runId: string) => ['projects', projectId, 'log', runId] as const,
  results: (projectId: string, runId: string) => ['projects', projectId, 'results', runId] as const,
  config: (projectId: string, path: string) => ['projects', projectId, 'config', path] as const,
  relaunch: (projectId: string, runId: string) =>
    ['projects', projectId, 'relaunch', runId] as const,
  params: (projectId: string) => ['projects', projectId, 'params'] as const,
  notes: (projectId: string) => ['projects', projectId, 'notes'] as const,
  requirements: (projectId: string) => ['projects', projectId, 'requirements'] as const,
  readiness: (projectId: string) => ['projects', projectId, 'readiness'] as const,
  environment: (projectId: string) => ['projects', projectId, 'environment'] as const,
  requires: (projectId: string, text: string, script: string, defaultConfig: string) =>
    ['projects', projectId, 'requires', script, defaultConfig, text] as const,
  jobs: ['jobs'] as const,
  batches: ['batches'] as const,
  modelSpecs: (projectId: string, script: string, defaultConfig: string) =>
    ['projects', projectId, 'model-specs', script, defaultConfig] as const,
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

/** 実験の任意のファイル (task.yaml, evaluations/, samples/). 学習中は見本が増えるので読み直す */
export function useResults(projectId: string, runId: string, live = false) {
  return useQuery({
    queryKey: keys.results(projectId, runId),
    queryFn: () => api.getResults(projectId, runId),
    refetchInterval: live ? LIVE_INTERVAL * 4 : false,
  })
}

/** 複数の実験の指標の推移をまとめて取得する. live に含む (学習中の) 実験は一定の間隔で読み直す */
export function useHistories(projectId: string, runIds: string[], live: Set<string> = new Set()) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: keys.history(projectId, runId),
      queryFn: () => api.getHistory(projectId, runId),
      refetchInterval: live.has(runId) ? LIVE_INTERVAL * 2 : (false as const),
    })),
  })
}

/** 複数の実験の詳細をまとめて取得する. 学習中の実験は画像の一覧なども一定の間隔で読み直す */
export function useRunDetails(projectId: string, runIds: string[]) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: keys.run(projectId, runId),
      queryFn: () => api.getRun(projectId, runId),
      refetchInterval: (query: { state: { data?: { status: string } } }) =>
        query.state.data?.status === 'running' ? LIVE_INTERVAL : false,
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

export function useMoveProject() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => api.moveProject(id, path),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  })
}

/** ML-Pathfinder で書き出した, 登録していないプロジェクト (開いている間だけ読む) */
export function useRecordedProjects(enabled: boolean) {
  return useQuery({ queryKey: keys.recorded, queryFn: api.recordedProjects, enabled })
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

/** 実験と同じ設定でもう一度起動するための設定. runId が null の間は読まない */
export function useRelaunch(projectId: string, runId: string | null) {
  return useQuery({
    queryKey: keys.relaunch(projectId, runId ?? ''),
    queryFn: () => api.getRelaunch(projectId, runId ?? ''),
    enabled: runId !== null,
    // config のファイルを書き換えたらすぐに反映するように, 開くたびに読み直す
    // (起動の画面は開いたときの結果だけを使うので, 画面に戻ったときは読まない)
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}

export function useValidateConfig(projectId: string) {
  return useMutation({
    mutationFn: ({
      text,
      script,
      defaultConfig,
    }: {
      text: string
      script: string
      defaultConfig?: string
    }) => api.validateConfig(projectId, text, script, defaultConfig),
  })
}

export function useCreateJob(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createJob>[1]) => api.createJob(projectId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.jobs }),
  })
}

export function useRerunJob() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.rerunJob,
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
  useRefreshOnJobChange(query.data)
  return query.data?.filter((job) => job.status === 'running').length ?? 0
}

/**
 * ジョブの状態か実験が変わったら, そのプロジェクトの実験の一覧と,
 * プロジェクトの一覧 (サイドバーとプロジェクトの画面の実験の数, 最新の実験) を読み直す
 */
function useRefreshOnJobChange(jobs: JobInfo[] | undefined) {
  const client = useQueryClient()
  const previous = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!jobs) return
    const current = new Map(jobs.map((job) => [job.id, `${job.status}:${job.run_id ?? ''}`]))
    // 最初の読み込みは比べる相手が無いので, 覚えるだけ
    const before = previous.current
    previous.current = current
    if (before === null) return
    const changed = jobs.filter((job) => before.get(job.id) !== current.get(job.id))
    if (changed.length === 0) return
    void client.invalidateQueries({ queryKey: keys.projects, exact: true })
    for (const projectId of new Set(changed.map((job) => job.project_id))) {
      void client.invalidateQueries({ queryKey: keys.runs(projectId) })
    }
  }, [client, jobs])
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
    mutationFn: ({ jobId, force, now = false }: { jobId: string; force: boolean; now?: boolean }) =>
      api.stopJob(jobId, force, now),
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

export function useNotes(projectId: string) {
  return useQuery({ queryKey: keys.notes(projectId), queryFn: () => api.listNotes(projectId) })
}

/** 実験のメモを保存する. 一覧の表示はすぐに変え, 失敗したら元に戻す */
export function useSaveNote(projectId: string) {
  const client = useQueryClient()
  const key = keys.notes(projectId)
  return useMutation({
    // 保存は全体の置き換えなので, 古い保存が後に届かないように 1 つずつ実行
    scope: { id: `notes-${projectId}` },
    mutationKey: ['save-note', projectId],
    mutationFn: ({ runId, note }: { runId: string; note: RunNote }) =>
      api.saveNote(projectId, runId, note),
    onMutate: async ({ runId, note }) => {
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData<Record<string, RunNote>>(key)
      client.setQueryData<Record<string, RunNote>>(key, (current) => ({
        ...current,
        [runId]: note,
      }))
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(key, context.previous)
    },
    // 続けて保存している間は読み直さず, 最後の保存の後にだけ読み直す
    onSettled: () => {
      if (client.isMutating({ mutationKey: ['save-note', projectId] }) <= 1) {
        void client.invalidateQueries({ queryKey: key })
      }
    },
  })
}

/** プロジェクトの Python で確かめた追加の依存 (バックエンドも少しの間覚えておく) */
export function useRequirements(projectId: string) {
  return useQuery({
    queryKey: keys.requirements(projectId),
    queryFn: () => api.getRequirements(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
}

/** 覚えた結果を使わずに確かめ直し, 結果を一覧と起動の画面の両方に反映する */
export function useRecheckRequirements(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.getRequirements(projectId, true),
    onSuccess: (report) => {
      client.setQueryData(keys.requirements(projectId), report)
      void client.invalidateQueries({ queryKey: ['projects', projectId, 'requires'] })
    },
  })
}

/**
 * config の requires に書いた機能のうち足りないもの. 書き換えのたびに呼ばないように,
 * 中身が少しの間変わらなくなってから読む (読む間は前の結果を出し続ける)
 */
export function useRequiresStatus(
  projectId: string,
  text: string,
  script: string,
  defaultConfig: string | undefined,
  enabled: boolean,
) {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), 400)
    return () => window.clearTimeout(timer)
  }, [text])
  const active = enabled && script !== ''
  const queryKey = keys.requires(projectId, settled, script, defaultConfig ?? '')
  const query = useQuery({
    queryKey,
    queryFn: () => api.getRequiresStatus(projectId, settled, script, defaultConfig),
    enabled: active,
    // 前の結果を出し続けるのは, 同じプロジェクト, スクリプト, default で中身だけを
    // 書き換えた場合だけ (別のプロジェクトの結果でボタンを止めないため)
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameRequiresTarget(previousQuery.queryKey, queryKey) ? previous : undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  // 書き換えた中身をまだ確かめていない間 (待つ間, 前の結果を出している間) は確かめ中
  const pending =
    active &&
    (settled !== text || query.isPlaceholderData || (query.isFetching && query.data === undefined))
  return { ...query, data: active ? query.data : undefined, pending }
}

/** requires の問い合わせの鍵が, 中身を除いて同じか */
function sameRequiresTarget(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return [0, 1, 2, 3, 4].every((index) => previous[index] === next[index])
}

/** 学習の準備. 環境のジョブが動いている間は読み直し続ける */
export function useReadiness(projectId: string) {
  return useQuery({
    queryKey: keys.readiness(projectId),
    queryFn: () => api.getReadiness(projectId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
}

/** 環境のジョブ. 動いている間は出力を読み直し, 終わったら準備と Python を読み直す */
export function useEnvironmentJob(projectId: string) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: keys.environment(projectId),
    queryFn: () => api.getEnvironmentJob(projectId),
    refetchInterval: (current) =>
      current.state.data?.status === 'running' ? LIVE_INTERVAL : false,
  })
  const status = query.data?.status
  const previous = useRef(status)
  useEffect(() => {
    // 終わったときは, サーバーが覚えた結果を捨てているので読み直すだけでよい
    if (previous.current === 'running' && status !== 'running') {
      void client.invalidateQueries({ queryKey: keys.readiness(projectId) })
      void client.invalidateQueries({ queryKey: keys.project(projectId), exact: true })
      void client.invalidateQueries({ queryKey: keys.requirements(projectId) })
      void client.invalidateQueries({ queryKey: ['projects', projectId, 'requires'] })
    }
    previous.current = status
  }, [status, projectId, client])
  return query
}

/** 確かめたコマンドで環境のジョブを始める */
export function useStartEnvironmentJob(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (commands: string[][]) => api.startEnvironmentJob(projectId, commands),
    onSuccess: (job) => client.setQueryData(keys.environment(projectId), job),
  })
}

/** 覚えた結果を使わずに学習の準備を確かめ直す */
export function useRecheckReadiness(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.getReadiness(projectId, true),
    onSuccess: (readiness) => client.setQueryData(keys.readiness(projectId), readiness),
  })
}

/** プロジェクトの models/ のモデルの定義の候補 */
export function useModelSpecs(projectId: string, script: string, defaultConfig?: string) {
  return useQuery({
    queryKey: keys.modelSpecs(projectId, script, defaultConfig ?? ''),
    queryFn: () => api.getModelSpecs(projectId, script, defaultConfig),
    enabled: script !== '',
  })
}

/** 候補のまとまりの一覧. 進めている途中のまとまりがある間は一定の間隔で読み直す */
export function useBatches() {
  return useQuery({
    queryKey: keys.batches,
    queryFn: api.listBatches,
    refetchInterval: (query) =>
      query.state.data?.some((batch) => !batch.finished) ? LIVE_INTERVAL : 30_000,
  })
}

export function useCreateBatch(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createBatch>[1]) => api.createBatch(projectId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.batches })
      void client.invalidateQueries({ queryKey: keys.jobs })
    },
  })
}

export function useStopBatch() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.stopBatch,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.batches })
      void client.invalidateQueries({ queryKey: keys.jobs })
    },
  })
}
