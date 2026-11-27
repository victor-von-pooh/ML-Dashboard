import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../src/index.css'
import { StageApp } from '../../src/StageApp'

// 通しのテスト (e2e/stage.spec.ts) で, 殻の下に載せた形の根の部品を描く.
// 殻で選んだ問題の設定の識別子は URL の project で渡す
const project = new URLSearchParams(window.location.search).get('project')

/** 殻への知らせは受け取らない */
const ignore = () => {}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StageApp
      basename="/train"
      apiBase="/api"
      project={project}
      onProjectChange={ignore}
      onProjectsChange={ignore}
      embedded
    />
  </StrictMode>,
)
