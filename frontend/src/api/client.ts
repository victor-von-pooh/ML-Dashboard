import type { components } from './schema'

// API の型 (バックエンドの OpenAPI から生成)
type Schemas = components['schemas']
export type ProjectInfo = Schemas['ProjectInfo']
export type ProjectDetail = Schemas['ProjectDetail']
export type ProjectCandidate = Schemas['ProjectCandidate']
export type RecordedProject = Schemas['RecordedProject']
export type RecordedProjects = Schemas['RecordedProjects']
export type ProblemTraining = Schemas['ProblemTraining']
export type ProblemTrainings = Schemas['ProblemTrainings']
export type RunSummary = Schemas['RunSummary']
export type RunDetail = Schemas['RunDetail']
export type RunModelSpec = Schemas['RunModelSpec']
export type RunModel = Schemas['RunModel']
export type ModelSpecList = Schemas['ModelSpecList']
export type ModelSpecInfo = Schemas['ModelSpecInfo']
export type BatchInfo = Schemas['BatchInfo']
export type BatchCandidate = Schemas['BatchCandidate']
export type BatchCreate = Schemas['BatchCreate']
export type ModelParam = Schemas['ModelParam']
export type RunStatus = RunSummary['status']
export type BestValue = Schemas['BestValue']
export type History = Schemas['History']
export type HistoryRow = History['rows'][number]
export type LogEntry = Schemas['LogEntry']
export type RunFile = Schemas['RunFile']
export type Progress = Schemas['Progress']
export type RunResults = Schemas['RunResults']
export type RunTask = Schemas['RunTask']
export type Evaluation = Schemas['Evaluation']
export type RunEvaluations = Schemas['RunEvaluations']
export type EvaluationValue = Schemas['EvaluationValue']
export type GuardCheck = Schemas['GuardCheck']
export type Sample = Schemas['Sample']
export type SampleClass = Schemas['SampleClass']
export type SampleCloud = Schemas['SampleCloud']
export type RunPolicy = Schemas['RunPolicy']
export type PolicySpace = Schemas['PolicySpace']
export type PolicyGuards = Schemas['PolicyGuards']
export type PolicyOutcome = Schemas['PolicyOutcome']
export type PolicyEndShare = Schemas['PolicyEndShare']
export type TrajectoryInfo = Schemas['TrajectoryInfo']
export type PolicyEstimate = Schemas['PolicyEstimate']
export type TargetPolicy = PolicyEstimate['policy']

/** 方策の見積もりの要求 (軌跡の名前, 見積もる方策, ε, 割引率) */
export interface EstimateRequest {
  trajectory: string
  policy: TargetPolicy
  epsilon: number
  gamma: number
}
export type Requirement = Schemas['Requirement']
export type RequirementReport = Schemas['RequirementReport']
export type RequiresStatus = Schemas['RequiresStatus']
export type ProjectReadiness = Schemas['ProjectReadiness']
export type EnvironmentJob = Schemas['EnvironmentJob']
export type ConfigPath = Schemas['ConfigPath']
// 既定値のある項目もサーバーは必ず返すので, 全て必須として扱う
export type RunNote = Required<Schemas['RunNote']>
export type RunParams = Schemas['RunParams']
type ProjectCreate = Schemas['ProjectCreate']
export type JobInfo = Schemas['JobInfo']
export type ValidateResult = Schemas['ValidateResult']
export type ConfigText = Schemas['ConfigText']
export type RelaunchPlan = Schemas['RelaunchPlan']
type JobCreate = Schemas['JobCreate']

// ML-Found の登録簿 (describe_optimizers と describe_schedulers の形)
export type ParamSpec = Schemas['ParamSpec']
export type ClassSpec = Schemas['ClassSpec']
export type Registry = Schemas['Registry']

// 実験に写したモデルの定義を使えずに起動しなかったときの code (バックエンドの COPY_REFUSED_CODE)
export const COPY_REFUSED_CODE = 'model_spec_copy_refused'

/** API がエラーを返したときの例外 */
export class ApiError extends Error {
  readonly status: number
  // 画面が見分けるエラーの種類 (応答の code. 無ければ null)
  readonly code: string | null

  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 実験に写したモデルの定義を使えずに起動しなかったエラーか */
export function isCopyRefused(error: unknown): boolean {
  return error instanceof ApiError && error.code === COPY_REFUSED_CODE
}

/** エラーのレスポンスの code を取り出す. 無ければ null */
function readCode(body: unknown): string | null {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/** エラーのレスポンスから表示する文と code を取り出す */
async function readError(response: Response): Promise<[string, string | null]> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // JSON でない場合は状態の文を使う
    return [`${response.status} ${response.statusText}`, null]
  }
  return [errorText(response, body), readCode(body)]
}

/** エラーの本文から表示する文を取り出す */
function errorText(response: Response, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    // 入力の検証のエラー (422) は, 項目と理由だけを読める形にする
    if (Array.isArray(detail)) {
      return detail
        .map((item: { loc?: unknown[]; msg?: string }) => {
          const field = (item.loc ?? []).filter((part) => part !== 'body').join('.')
          return field ? `${field}: ${item.msg ?? ''}` : (item.msg ?? '')
        })
        .join(' / ')
    }
    return JSON.stringify(detail)
  }
  return `${response.status} ${response.statusText}`
}

/** JSON の API を呼ぶ */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const [message, code] = await readError(response)
    throw new ApiError(response.status, message, code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

/** 実験の ID を URL に入れる形にする (区切りの / は残す) */
export function encodeRunId(runId: string): string {
  return runId.split('/').map(encodeURIComponent).join('/')
}

/** 実験のファイルの URL */
export function runFileUrl(projectId: string, runId: string, path: string): string {
  const file = path.split('/').map(encodeURIComponent).join('/')
  return `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/files/${file}`
}

export const api = {
  listProjects: () => request<ProjectInfo[]>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  addProject: (body: ProjectCreate) =>
    request<ProjectInfo>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  moveProject: (id: string, path: string) =>
    request<ProjectInfo>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ path }),
    }),
  removeProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scanProjects: (path: string) =>
    request<ProjectCandidate[]>('/api/projects/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  /** ML-Pathfinder の問題の設定に記録された, 登録していないプロジェクト */
  recordedProjects: () => request<RecordedProjects>('/api/problems/projects'),
  /** 問題の設定ごとの学習で監視する指標と向き (ML-Quest が無ければ 501) */
  problemTrainings: () => request<ProblemTrainings>('/api/problems/training'),
  listRuns: (projectId: string) =>
    request<RunSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`),
  getRun: (projectId: string, runId: string) =>
    request<RunDetail>(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}`),
  getHistory: (projectId: string, runId: string) =>
    request<History>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/history`,
    ),
  getResults: (projectId: string, runId: string) =>
    request<RunResults>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/results`,
    ),
  getSampleCloud: (projectId: string, runId: string, path: string) =>
    request<SampleCloud>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/samples/cloud?path=${encodeURIComponent(path)}`,
    ),
  /** 記録した軌跡から, 決まった形の方策の良さを見積もる (見積もれない軌跡は 422 と理由) */
  getPolicyEstimate: (projectId: string, runId: string, body: EstimateRequest) =>
    request<PolicyEstimate>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/trajectories/${encodeURIComponent(body.trajectory)}/estimate?${new URLSearchParams(
        { policy: body.policy, epsilon: String(body.epsilon), gamma: String(body.gamma) },
      ).toString()}`,
    ),
  getLog: (projectId: string, runId: string) =>
    request<LogEntry[]>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/log`,
    ),
  getConfig: (projectId: string, path: string) =>
    request<ConfigText>(
      `/api/projects/${encodeURIComponent(projectId)}/configs/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    ),
  getRelaunch: (projectId: string, runId: string) =>
    request<RelaunchPlan>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/relaunch`,
    ),
  // script は元にする default の config を選ぶのに使う (train_hf.py なら configs/default/hf.yaml)
  // defaultConfig を渡すと, スクリプトから選ばずにその default で確かめる
  validateConfig: (projectId: string, text: string, script?: string, defaultConfig?: string) =>
    request<ValidateResult>(`/api/projects/${encodeURIComponent(projectId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        script: script || undefined,
        default_config: defaultConfig || undefined,
      }),
    }),
  rerunJob: (jobId: string) =>
    request<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}/rerun`, { method: 'POST' }),
  createJob: (projectId: string, body: JobCreate) =>
    request<JobInfo>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listParams: (projectId: string) =>
    request<RunParams[]>(`/api/projects/${encodeURIComponent(projectId)}/params`),
  listNotes: (projectId: string) =>
    request<Record<string, RunNote>>(`/api/projects/${encodeURIComponent(projectId)}/notes`),
  saveNote: (projectId: string, runId: string, note: RunNote) =>
    request<RunNote>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/note`,
      { method: 'PUT', body: JSON.stringify(note) },
    ),
  getRegistry: () => request<Registry>('/api/registry'),
  // refresh は覚えた結果を使わずにプロジェクトの Python で確かめ直す
  getRequirements: (projectId: string, refresh = false) =>
    request<RequirementReport>(
      `/api/projects/${encodeURIComponent(projectId)}/requirements${refresh ? '?refresh=true' : ''}`,
    ),
  // config の requires に書いた機能のうち足りないもの (開始のボタンを止めるのに使う)
  getRequiresStatus: (projectId: string, text: string, script?: string, defaultConfig?: string) =>
    request<RequiresStatus>(`/api/projects/${encodeURIComponent(projectId)}/requires`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        script: script || undefined,
        default_config: defaultConfig || undefined,
      }),
    }),
  // 学習の準備 (データセット, モデルの定義, 環境). refresh は環境を確かめ直す
  getReadiness: (projectId: string, refresh = false) =>
    request<ProjectReadiness>(
      `/api/projects/${encodeURIComponent(projectId)}/readiness${refresh ? '?refresh=true' : ''}`,
    ),
  getEnvironmentJob: (projectId: string) =>
    request<EnvironmentJob | null>(`/api/projects/${encodeURIComponent(projectId)}/environment`),
  // 利用者が確かめたコマンド (学習の準備の commands) で環境を作るか足りないものを入れる
  startEnvironmentJob: (projectId: string, commands: string[][]) =>
    request<EnvironmentJob>(`/api/projects/${encodeURIComponent(projectId)}/environment`, {
      method: 'POST',
      body: JSON.stringify({ commands }),
    }),
  listJobs: () => request<JobInfo[]>('/api/jobs'),
  getJob: (jobId: string) => request<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}`),
  // now はエポックの途中でも止める (ML-Found が途中のエポックを捨てる), force はプロセスに割り込む
  stopJob: (jobId: string, force: boolean, now = false) =>
    request<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ force, now }),
    }),
  getJobOutput: (jobId: string) =>
    request<{ text: string }>(`/api/jobs/${encodeURIComponent(jobId)}/output`),
  // script と defaultConfig は, 候補の欄を出すかを決める default の config を選ぶのに使う
  getModelSpecs: (projectId: string, script?: string, defaultConfig?: string) => {
    const query = new URLSearchParams()
    if (script) query.set('script', script)
    if (defaultConfig) query.set('default_config', defaultConfig)
    return request<ModelSpecList>(
      `/api/projects/${encodeURIComponent(projectId)}/model-specs?${query.toString()}`,
    )
  },
  createBatch: (projectId: string, body: BatchCreate) =>
    request<BatchInfo>(`/api/projects/${encodeURIComponent(projectId)}/batches`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listBatches: () => request<BatchInfo[]>('/api/batches'),
  // force は, 別のプロセスが持ち主で応答しないまとまりも取りやめる
  stopBatch: (batchId: string, force = false) =>
    request<BatchInfo>(
      `/api/batches/${encodeURIComponent(batchId)}/stop${force ? '?force=true' : ''}`,
      { method: 'POST' },
    ),
  // 終わったまとまりの記録と候補の config を消す (候補のジョブと実験は残る)
  deleteBatch: (batchId: string) =>
    request<void>(`/api/batches/${encodeURIComponent(batchId)}`, { method: 'DELETE' }),
}
