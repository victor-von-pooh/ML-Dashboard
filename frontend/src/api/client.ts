import type { components } from './schema'

// API の型 (バックエンドの OpenAPI から生成)
type Schemas = components['schemas']
export type ProjectInfo = Schemas['ProjectInfo']
export type ProjectDetail = Schemas['ProjectDetail']
export type ProjectCandidate = Schemas['ProjectCandidate']
export type RunSummary = Schemas['RunSummary']
export type RunDetail = Schemas['RunDetail']
export type RunStatus = RunSummary['status']
export type BestValue = Schemas['BestValue']
export type History = Schemas['History']
export type HistoryRow = History['rows'][number]
export type LogEntry = Schemas['LogEntry']
export type RunFile = Schemas['RunFile']
export type Progress = Schemas['Progress']
// 既定値のある項目もサーバーは必ず返すので, 全て必須として扱う
export type RunNote = Required<Schemas['RunNote']>
export type RunParams = Schemas['RunParams']
type ProjectCreate = Schemas['ProjectCreate']
export type JobInfo = Schemas['JobInfo']
export type ValidateResult = Schemas['ValidateResult']
export type ConfigText = Schemas['ConfigText']
type JobCreate = Schemas['JobCreate']

/** ML-Found の登録簿の引数の仕様 (describe_optimizers の形) */
export interface ParamSpec {
  name: string
  kind: string
  default: unknown
  required: boolean
  advanced: boolean
  description: string
  minimum: number | null
  maximum: number | null
}

/** ML-Found の登録簿のクラスの仕様 */
export interface ClassSpec {
  name: string
  description: string
  params: ParamSpec[]
  supported: boolean
  note: string
}

export interface Registry {
  optimizers: ClassSpec[]
  schedulers: ClassSpec[]
}

/** API がエラーを返したときの例外 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** エラーのレスポンスから表示する文を取り出す */
async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
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
  } catch {
    // JSON でない場合は状態の文を使う
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
    throw new ApiError(response.status, await readError(response))
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
  removeProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scanProjects: (path: string) =>
    request<ProjectCandidate[]>('/api/projects/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  listRuns: (projectId: string) =>
    request<RunSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`),
  getRun: (projectId: string, runId: string) =>
    request<RunDetail>(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}`),
  getHistory: (projectId: string, runId: string) =>
    request<History>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeRunId(runId)}/history`,
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
  validateConfig: (projectId: string, text: string) =>
    request<ValidateResult>(`/api/projects/${encodeURIComponent(projectId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
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
  listJobs: () => request<JobInfo[]>('/api/jobs'),
  getJob: (jobId: string) => request<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}`),
  stopJob: (jobId: string, force: boolean) =>
    request<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  getJobOutput: (jobId: string) =>
    request<{ text: string }>(`/api/jobs/${encodeURIComponent(jobId)}/output`),
}
