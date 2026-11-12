import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from './client'

export const keys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  runs: (projectId: string) => ['projects', projectId, 'runs'] as const,
  run: (projectId: string, runId: string) => ['projects', projectId, 'run', runId] as const,
  history: (projectId: string, runId: string) => ['projects', projectId, 'history', runId] as const,
  log: (projectId: string, runId: string) => ['projects', projectId, 'log', runId] as const,
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects })
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) })
}

export function useRuns(projectId: string) {
  return useQuery({ queryKey: keys.runs(projectId), queryFn: () => api.listRuns(projectId) })
}

export function useRun(projectId: string, runId: string) {
  return useQuery({
    queryKey: keys.run(projectId, runId),
    queryFn: () => api.getRun(projectId, runId),
  })
}

export function useHistory(projectId: string, runId: string) {
  return useQuery({
    queryKey: keys.history(projectId, runId),
    queryFn: () => api.getHistory(projectId, runId),
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
