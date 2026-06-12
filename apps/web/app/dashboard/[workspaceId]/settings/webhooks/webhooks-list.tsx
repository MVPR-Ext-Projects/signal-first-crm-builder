"use client"

/**
 * WebhooksList — render each integration's webhook destination URL with a
 * copy-to-clipboard button + the per-integration setup notes.
 *
 * Uses the navigator clipboard API; falls back to selecting the input text
 * so the user can copy manually if clipboard write is blocked.
 */

import { useState } from "react"

interface Endpoint {
  key:         "teamfluence" | "hubspot" | "dripify" | "calendly"
  name:        string
  url:         string
  description: string
  auth:        string
  tip:         string
  /** When set, the card renders a signing-secret editor that PATCHes
   *  webhookSecrets.<secretKey> on the workspace config. */
  secretKey?:        "calendly" | "dripify" | "unipile"
  /** True if the workspace already has a value stored under that key.
   *  Drives the "Configured / Not set" badge on the editor. */
  secretConfigured?: boolean
}

export function WebhooksList({ workspaceId, endpoints }: { workspaceId: string; endpoints: Endpoint[] }) {
  return (
    <div className="space-y-4">
      {endpoints.map(e => (
        <EndpointCard key={e.key} workspaceId={workspaceId} endpoint={e} />
      ))}
    </div>
  )
}

function EndpointCard({ workspaceId, endpoint }: { workspaceId: string; endpoint: Endpoint }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fall back to select-on-click — user can press Cmd/Ctrl+C themselves.
      const input = document.getElementById(`webhook-url-${endpoint.key}`) as HTMLInputElement | null
      input?.select()
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold text-white">{endpoint.name}</h2>
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">
          POST · application/json
        </span>
      </header>

      <p className="mb-3 text-[13px] leading-[20px] text-zinc-300">{endpoint.description}</p>

      <div className="flex gap-2">
        <input
          id={`webhook-url-${endpoint.key}`}
          type="text"
          readOnly
          value={endpoint.url}
          onFocus={e => e.currentTarget.select()}
          className="flex-1 rounded-xl border border-white/12 bg-black/30 px-3 py-2 font-mono text-[12px] text-zinc-100 focus:border-[#2BA98B]/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-xl border border-white/14 bg-white/[0.04] px-4 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
          aria-label={`Copy ${endpoint.name} webhook URL`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {endpoint.secretKey && (
        <SecretEditor
          workspaceId={workspaceId}
          secretKey={endpoint.secretKey}
          name={endpoint.name}
          initiallyConfigured={endpoint.secretConfigured ?? false}
        />
      )}

      <details className="mt-3 group">
        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500 transition-colors hover:text-zinc-300 motion-reduce:transition-none">
          Setup notes
        </summary>
        <dl className="mt-2 space-y-2 text-[12px] leading-[18px] text-zinc-400">
          <div>
            <dt className="font-semibold text-zinc-300">Auth</dt>
            <dd>{endpoint.auth}</dd>
          </div>
          <div>
            <dt className="font-semibold text-zinc-300">Tip</dt>
            <dd>{endpoint.tip}</dd>
          </div>
        </dl>
      </details>
    </section>
  )
}

function SecretEditor({
  workspaceId,
  secretKey,
  name,
  initiallyConfigured,
}: {
  workspaceId: string
  secretKey: NonNullable<Endpoint["secretKey"]>
  name: string
  initiallyConfigured: boolean
}) {
  const [value, setValue]           = useState("")
  const [saving, setSaving]         = useState(false)
  const [configured, setConfigured] = useState(initiallyConfigured)
  const [status, setStatus]         = useState<{ kind: "idle" | "saved" | "error"; msg?: string }>({ kind: "idle" })

  async function save() {
    const trimmed = value.trim()
    if (!trimmed) return
    setSaving(true)
    setStatus({ kind: "idle" })
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookSecrets: { [secretKey]: trimmed } }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(text || `HTTP ${res.status}`)
      }
      setValue("")
      setConfigured(true)
      setStatus({ kind: "saved" })
      setTimeout(() => setStatus({ kind: "idle" }), 2500)
    } catch (err) {
      setStatus({ kind: "error", msg: err instanceof Error ? err.message : "Save failed" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-white/8 bg-black/20 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={`secret-${secretKey}`} className="text-[12px] font-semibold text-zinc-200">
          Signing secret
        </label>
        <span
          className={
            configured
              ? "rounded-full bg-[#2BA98B]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#2BA98B]"
              : "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-300"
          }
        >
          {configured ? "Configured" : "Not set"}
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-[16px] text-zinc-500">
        Pasting a new value overwrites whatever is stored. Field is write-only — the current value is never displayed.
      </p>
      <div className="flex gap-2">
        <input
          id={`secret-${secretKey}`}
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={configured ? "•••••••• paste to replace" : `Paste ${name} signing secret`}
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 rounded-xl border border-white/12 bg-black/30 px-3 py-2 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-[#2BA98B]/40 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !value.trim()}
          className="rounded-xl border border-white/14 bg-[#2BA98B]/[0.12] px-4 py-2 text-[12px] font-semibold text-[#2BA98B] transition-colors hover:bg-[#2BA98B]/[0.20] disabled:opacity-40 disabled:hover:bg-[#2BA98B]/[0.12]"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {status.kind === "saved" && (
        <p className="mt-2 text-[11px] text-[#2BA98B]">Saved. Inbound webhooks will use this signing secret from the next request onward.</p>
      )}
      {status.kind === "error" && (
        <p className="mt-2 text-[11px] text-rose-400">Save failed: {status.msg}</p>
      )}
    </div>
  )
}
