"use client"

/**
 * Lightweight toast system — a top-right stack of auto-dismissing messages
 * shown when the user fires actions like Enrich / Fetch interests / Fetch
 * employees. Lives inside the dashboard layout; usable from any client
 * component via the useToast() hook.
 *
 * Three flavours: success / error / info. Each toast auto-dismisses after a
 * few seconds (longer for errors so the user has time to read), and is
 * dismissable manually via the × button.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react"

type ToastKind = "success" | "error" | "info"

interface ToastEntry {
  id:          string
  kind:        ToastKind
  title:       string
  description?: string
}

interface ToastApi {
  success: (title: string, description?: string) => string
  error:   (title: string, description?: string) => string
  info:    (title: string, description?: string) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Defensive — return a no-op API rather than throwing, so a misconfigured
    // tree never crashes the page.
    return {
      success: () => "",
      error:   () => "",
      info:    () => "",
      dismiss: () => {},
    }
  }
  return ctx
}

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 3500,
  info:    3500,
  error:   6000,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const counter = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const enqueue = useCallback(
    (kind: ToastKind, title: string, description?: string): string => {
      const id = `t${++counter.current}`
      setToasts((prev) => [...prev, { id, kind, title, description }])
      const ms = AUTO_DISMISS_MS[kind]
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, ms)
      return id
    },
    [],
  )

  const api: ToastApi = {
    success: (title, description) => enqueue("success", title, description),
    error:   (title, description) => enqueue("error",   title, description),
    info:    (title, description) => enqueue("info",    title, description),
    dismiss,
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[]
  onDismiss: (id: string) => void
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastEntry
  onDismiss: () => void
}) {
  const styles = {
    success: {
      ring:  "border-emerald-400/30 bg-emerald-500/[0.10]",
      title: "text-emerald-100",
      desc:  "text-emerald-100/70",
      dot:   "bg-emerald-400",
    },
    error: {
      ring:  "border-rose-400/30 bg-rose-500/[0.10]",
      title: "text-rose-100",
      desc:  "text-rose-100/70",
      dot:   "bg-rose-400",
    },
    info: {
      ring:  "border-[#2BA98B]/30 bg-[#2BA98B]/[0.10]",
      title: "text-white",
      desc:  "text-zinc-200/70",
      dot:   "bg-[#2BA98B]",
    },
  }[toast.kind]

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto rounded-lg border px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur transition-all motion-reduce:transition-none ${styles.ring}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-semibold leading-snug ${styles.title}`}>
            {toast.title}
          </p>
          {toast.description && (
            <p className={`mt-0.5 break-words text-[12px] leading-snug ${styles.desc}`}>
              {toast.description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-m-1 shrink-0 rounded p-1 text-zinc-300/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2BA98B]/60 motion-reduce:transition-none"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
