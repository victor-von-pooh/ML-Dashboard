import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import { StageApp } from './StageApp'

/** 単独の起動では, 殻とのやり取りを持たない */
const ignore = () => {}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StageApp
      basename=""
      apiBase="/api"
      project={null}
      onProjectChange={ignore}
      onProjectsChange={ignore}
      embedded={false}
    />
  </StrictMode>,
)
