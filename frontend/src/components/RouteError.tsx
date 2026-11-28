import { SearchX, TriangleAlert } from 'lucide-react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'

import { STAGE_NAME } from '../lib/stage'
import { EmptyState, PageHeader } from './ui'

/** 段階の中の知らない経路の画面 (段階の名前の見出しと, 段階の頭の画面へのリンク) */
export function NotFound() {
  return (
    <>
      <PageHeader title={STAGE_NAME} />
      <EmptyState icon={SearchX} title="ページが見つかりません">
        <Link to="/" className="text-accent-text hover:underline">
          プロジェクトの一覧へ戻る
        </Link>
      </EmptyState>
    </>
  )
}

/** 描画中のエラーの画面 (左の欄の枠の外に出すので, 段階の名前の見出しも置く) */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <PageHeader title={STAGE_NAME} />
      <EmptyState icon={TriangleAlert} title="画面を表示できませんでした">
        <p className="mb-4 font-mono text-xs break-all">{message}</p>
        {/* basename の下のプロジェクトの一覧へ (殻の下では根が殻の画面を指すため) */}
        <Link to="/" className="text-accent-text hover:underline">
          プロジェクトの一覧に戻る
        </Link>
      </EmptyState>
    </div>
  )
}
