import { Compass, TriangleAlert } from 'lucide-react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'

import { EmptyState } from './ui'

/** 存在しない URL の画面 */
export function NotFound() {
  return (
    <EmptyState icon={Compass} title="ページが見つかりません">
      <Link to="/" className="text-accent-text hover:underline">
        プロジェクトの一覧に戻る
      </Link>
    </EmptyState>
  )
}

/** 描画中のエラーの画面 */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
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
