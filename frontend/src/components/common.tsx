/**
 * 5 つの段階の画面の共通の部品 (殻の docs/DESIGN.md の R12).
 *
 * 殻の parts/common.tsx が正で, 各アプリは frontend/src/components/common.tsx に
 * そのまま写す (1 字でも違うと殻の CI が差を出す). 部品でない関数は
 * common-utils.ts に置く. 直すときは殻の正を直してから写す. 段階に固有の部品は
 * 各アプリの components/ui.tsx に置き, そこから common を書き出す
 */
import clsx from 'clsx'
import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'

/**
 * 欄の枠の色の形. accent は知らせの欄, warning は決めてほしいことなどの注意を促す
 * 欄, highlight は並びの中で 1 つを目立たせる欄 (色だけで違いを表さず, 文や印と
 * 併せて使う)
 */
export type CardTone = 'default' | 'accent' | 'warning' | 'highlight'

/**
 * 枠で囲んだ欄. 見出し (title) を持つときは, 見出しを名前にした区域 (region) として
 * 読み上げる (欄を見出しの名前で探せるように). 見出しの無い欄は名前を持たない.
 * 見出しにボタンや件数などを含むときは name で変わらない区域の名前を渡す. 数の
 * 決まらない欄は landmark={false} で区域にしない (区域が並び過ぎないように). 枠の
 * 色は tone で決め, className は置き場所と大きさ (余白, 格子の幅など) だけに使う
 */
export function Card({
  title,
  actions,
  children,
  className,
  padded = true,
  name,
  landmark = true,
  tone = 'default',
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
  /** 区域の名前 (省くと見出しを名前にする) */
  name?: string
  /** 区域 (region) にするか. false なら見出しは h2 のままで名前を持たない */
  landmark?: boolean
  /** 枠の色の形 (既定は default) */
  tone?: CardTone
}) {
  const titleId = useId()
  const region = landmark && Boolean(name || title)
  return (
    <section
      aria-label={region && name ? name : undefined}
      aria-labelledby={region && !name ? titleId : undefined}
      className={clsx(
        'rounded-xl shadow-sm shadow-black/[0.03]',
        tone === 'default' && 'border border-line bg-surface',
        tone === 'accent' && 'border border-accent/30 bg-accent-soft',
        tone === 'warning' && 'border border-warning/60 bg-surface',
        tone === 'highlight' && 'border-2 border-accent bg-surface',
        className,
      )}
    >
      {(title || actions) && (
        <header
          className={clsx(
            'flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5',
            tone === 'accent' ? 'border-accent/30' : 'border-line',
          )}
        >
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            {title}
          </h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  )
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** ボタン. 既定は type="button". アイコンだけのボタンは aria-label で名前を付ける */
export function Button({
  variant = 'secondary',
  icon: Icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  icon?: LucideIcon
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent-strong text-white hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' &&
          'border border-line bg-surface text-critical-text hover:bg-critical/10',
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-4" aria-hidden />}
      {children}
    </button>
  )
}

/** 読み込み中の印 (status として読み上げる) */
export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-ink-3">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </div>
  )
}

/**
 * 誤りの表示 (API の誤り). 操作の結果の誤りだけ読み上げ (live) の対象にする. 文の
 * 改行はそのまま出す (複数の誤りを 1 行ずつ読めるように). id を渡すと, 欄の
 * aria-describedby から結べる (結ぶときは live={false} にする. 二度読まれるため)
 */
export function ErrorBox({
  error,
  children,
  live = true,
  id,
}: {
  error: unknown
  children?: ReactNode
  live?: boolean
  /** 要素の id (欄の aria-describedby から結ぶため) */
  id?: string
}) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div
      id={id}
      role={live ? 'alert' : undefined}
      className="flex items-start gap-2 rounded-lg border border-critical/30 bg-critical/5 px-4 py-3 text-sm text-ink"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical-text" aria-hidden />
      <div className="min-w-0">
        <p className="break-words whitespace-pre-line">{message}</p>
        {children}
      </div>
    </div>
  )
}

/**
 * 欄の下の短い誤り (入力の確かめの誤り). 読み上げ (role) は持たず, 欄の
 * aria-describedby から id で結び, 欄に aria-invalid を付ける
 */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-xs text-critical-text">
      {children}
    </p>
  )
}

/**
 * 何も無いときの表示 (見出しと, 次にすることの説明). 見出しの段は level で決める.
 * 画面の h1 の直下と見出しの無い Card の中は既定の 2, 見出しのある Card と Dialog
 * の中は 3 にする (見出しの段を飛ばさないため)
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  level = 2,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  /** 見出しの段 (既定は 2) */
  level?: 2 | 3
}) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <div className="rounded-full bg-accent-soft p-3 text-accent-text">
        <Icon className="size-6" aria-hidden />
      </div>
      <Heading className="text-base font-semibold">{title}</Heading>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  )
}

/** 大きな数値で 1 つの値を見せるタイル */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="truncate text-xs font-medium text-ink-3" title={label}>
        {label}
      </div>
      <div className="tabular-nums mt-1 truncate text-xl font-semibold text-ink">{value}</div>
      {hint && (
        <div className="mt-0.5 truncate text-xs text-ink-3" title={hint}>
          {hint}
        </div>
      )}
    </div>
  )
}

export interface TabItem<T extends string> {
  id: T
  label: string
  count?: number
}

/**
 * タブ. 左右の矢印キーと Home, End で移り, 中身は common-utils の tabPanelProps で
 * 結び付ける
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  idBase,
  label,
}: {
  items: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  idBase: string
  label: string
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  // 狭い画面でも選んだタブが見えるように, 選び直したら横に送る
  useEffect(() => {
    refs.current[value]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.id === value)
    const targets: Record<string, number> = {
      ArrowRight: (index + 1) % items.length,
      ArrowLeft: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }
    const target = targets[event.key]
    if (target === undefined) return
    event.preventDefault()
    const next = items[target]
    if (next) {
      onChange(next.id)
      refs.current[next.id]?.focus()
    }
  }

  // 狭い画面で右に続きがあることが分かるように, 右端を薄くぼかす
  return (
    <div className="relative">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-line pr-6 md:pr-0"
      >
        {items.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[item.id] = element
            }}
            id={`${idBase}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={item.id === value}
            aria-controls={`${idBase}-panel`}
            tabIndex={item.id === value ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={clsx(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              item.id === value
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2',
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="tabular-nums rounded-full bg-surface-2 px-1.5 text-xs text-ink-2">
                {item.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 right-0 bottom-px w-8 bg-gradient-to-l from-bg md:hidden"
      />
    </div>
  )
}

/**
 * 画面の頭の見出し (h1). 段階の頭の画面は段階の名前を title にし, 下の画面は
 * 物の名前を title にして, breadcrumb の頭に段階の頭の画面へのリンクを置く.
 * 読み込み中 (物の名前が分からない間は段階の名前), 開けないとき (「<物>を
 * 開けません」), 知らない経路 (段階の名前) の画面にも置く
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && (
          <nav aria-label="パンくず" className="mb-1 text-xs text-ink-3">
            {breadcrumb}
          </nav>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 truncate text-sm text-ink-3">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * 画面の上に重ねる対話の枠. ブラウザの dialog を showModal で開き, 見出しを名前に
 * する. Esc, 外 (背景), 閉じるのボタンで閉じ, 閉じたら開く前の所へ focus を戻す.
 * busy の間は閉じない (処理の結果を見せるため). 最初の focus は initialFocus の
 * 要素, 無ければブラウザの決まり (autoFocus の要素, 無ければ最初の focus できる
 * 要素). 部品の木の中に置き, portal に出さない (data-stage-root の外に出すと,
 * R9 で中のキーを扱えなくなるため)
 */
export function Dialog({
  title,
  onClose,
  children,
  busy = false,
  initialFocus,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  /** 処理の途中か (途中は閉じない) */
  busy?: boolean
  /** 開いたときに focus を置く要素 */
  initialFocus?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // 押し始めが背景だったか (枠の中で押し始めて外で離したときに閉じないため)
  const downOnBackdrop = useRef(false)
  const titleId = useId()
  // 開く前に操作していた所 (最初の描画のときに覚え, 開発時の 2 回の実行でも
  // 枠の中を覚えない)
  const [before] = useState(() => document.activeElement)
  // 最初の focus の先 (開いたときだけ読む)
  const [focusTarget] = useState(() => initialFocus)
  useEffect(() => {
    ref.current?.showModal()
    focusTarget?.current?.focus()
    return () => {
      // 閉じたら (枠を外したら) そこに戻す. 開いた所を作り直した場合は, 同じ印
      // (data-return) の新しい要素に戻す
      const mark = before instanceof HTMLElement ? before.dataset.return : undefined
      window.requestAnimationFrame(() => {
        if (before instanceof HTMLElement && before.isConnected) before.focus()
        else if (mark) document.querySelector<HTMLElement>(`[data-return="${mark}"]`)?.focus()
      })
    }
  }, [before, focusTarget])
  // 押した位置が枠の矩形の外か
  const outside = (event: MouseEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      // 途中の Esc はブラウザに閉じさせない. 中の対話の知らせは見ない
      onCancel={(event) => {
        if (event.target === ref.current && busy) event.preventDefault()
      }}
      // 中の対話 (ファイルを選ぶなど) の閉じる知らせは, 外の枠を閉じない. 途中に
      // ブラウザが閉じた場合 (Esc を続けて押したなど) は開き直す
      onClose={(event) => {
        if (event.target !== ref.current) return
        if (busy) ref.current.showModal()
        else onClose()
      }}
      onPointerDown={(event) => {
        downOnBackdrop.current = event.target === ref.current
      }}
      // 背景で押し始めて背景で離したときだけ閉じる
      onClick={(event) => {
        const fromBackdrop = downOnBackdrop.current
        downOnBackdrop.current = false
        if (event.target === ref.current && fromBackdrop && outside(event) && !busy) onClose()
      }}
      className="m-auto w-[min(48rem,92vw)] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          閉じる
        </Button>
      </div>
      <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
    </dialog>
  )
}
