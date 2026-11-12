import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { ApiError } from './api/client'
import { Layout } from './components/Layout'
import { NotFound, RouteError } from './components/RouteError'
import { AnalysisPage } from './features/analysis/AnalysisPage'
import { ComparePage } from './features/compare/ComparePage'
import { JobDetailPage, JobsPage } from './features/jobs/JobsPage'
import { LaunchPage } from './features/jobs/LaunchPage'
import { ProjectsPage } from './features/projects/ProjectsPage'
import { RunDetailPage } from './features/run/RunDetailPage'
import { ProjectRunsPage } from './features/runs/RunsPage'
import './index.css'
import { ThemeProvider } from './lib/theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      // 見つからないなどの利用者側のエラーは繰り返さない
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
})

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/projects/:projectId', element: <ProjectRunsPage /> },
      { path: '/projects/:projectId/compare', element: <ComparePage /> },
      { path: '/projects/:projectId/analysis', element: <AnalysisPage /> },
      { path: '/projects/:projectId/launch', element: <LaunchPage /> },
      { path: '/jobs', element: <JobsPage /> },
      { path: '/jobs/:jobId', element: <JobDetailPage /> },
      { path: '/projects/:projectId/runs/*', element: <RunDetailPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
