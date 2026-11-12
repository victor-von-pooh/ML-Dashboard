import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { Layout } from './components/Layout'
import { ComparePage } from './features/compare/ComparePage'
import { ProjectsPage } from './features/projects/ProjectsPage'
import { RunDetailPage } from './features/run/RunDetailPage'
import { RunsPage } from './features/runs/RunsPage'
import './index.css'
import { ThemeProvider } from './lib/theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 },
  },
})

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/projects/:projectId', element: <RunsPage /> },
      { path: '/projects/:projectId/compare', element: <ComparePage /> },
      { path: '/projects/:projectId/runs/*', element: <RunDetailPage /> },
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
