"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense } from "react"

const CONNECTORS = [
  {
    id: "surfe",
    name: "Surfe",
    description: "Enriches new signals with email, job title, location, and company data",
    type: "apikey" as const,
    placeholder: "Paste your Surfe API key",
    required: true,
    badge: "Enrichment",
  },
  {
    id: "apollo",
    name: "Apollo.io",
    description: "Fallback enrichment provider if Surfe doesn't return a result",
    type: "apikey" as const,
    placeholder: "Paste your Apollo API key",
    required: false,
    badge: "Enrichment",
  },
  {
    id: "apify",
    name: "Apify",
    description: "Fetches a company's employees from LinkedIn on demand. Powers the \"Fetch employees\" action on the Companies tab.",
    type: "apikey" as const,
    placeholder: "Paste your Apify API token (apify_api_…)",
    required: false,
    badge: "Enrichment",
  },
  {
    id: "teamfluence",
    name: "Teamfluence",
    description: "Sends LinkedIn engagement signals (follows, reactions, DMs) into your workspace",
    type: "webhook" as const,
    required: true,
    badge: "Signals",
  },
  {
    id: "dripify",
    name: "Dripify",
    description: "Sends outreach campaign events (replies, no-replies, connection accepts)",
    type: "webhook" as const,
    required: false,
    badge: "Signals",
  },
]

const BADGE_COLORS: Record<string, string> = {
  Enrichment: "bg-[#2BA98B]/[0.16] text-[#2BA98B] border-[#2BA98B]/40",
  Signals: "bg-blue-500/10 text-blue-300 border-blue-500/30",
}

function ConnectPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const workspaceId = searchParams.get("workspaceId") ?? ""

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const webhookBase = typeof window !== "undefined"
    ? `${window.location.origin}/api/webhooks/${workspaceId}`
    : `/api/webhooks/${workspaceId}`

  async function copyWebhook(connectorId: string) {
    await navigator.clipboard.writeText(`${webhookBase}/${connectorId}`)
    setCopied(connectorId)
    setTimeout(() => setCopied(null), 2000)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enrichment: {
            surfe:  apiKeys.surfe  ? { apiKey: apiKeys.surfe }  : undefined,
            apollo: apiKeys.apollo ? { apiKey: apiKeys.apollo } : undefined,
            apify:  apiKeys.apify  ? { apiToken: apiKeys.apify } : undefined,
          },
        }),
      })
      if (!res.ok) throw new Error("Failed to save")
      router.push(`/wizard/provision?workspaceId=${workspaceId}`)
    } catch {
      setError("Failed to save — please try again")
      setSaving(false)
    }
  }

  const requiredDone = apiKeys.surfe?.trim()

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">
          Step 5 of 6 · Connect tools
        </p>
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-white">Connect your tools</h1>
        <p className="max-w-[640px] text-[15px] leading-[23px] text-zinc-300">
          These connectors power the signal scoring and enrichment that runs automatically in your workspace.
        </p>
      </div>

      <div className="space-y-4">
        {CONNECTORS.map((connector) => (
          <div
            key={connector.id}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-white">{connector.name}</span>
                  {connector.required && (
                    <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#2BA98B]">Required</span>
                  )}
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] ${BADGE_COLORS[connector.badge]}`}>
                    {connector.badge}
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-zinc-400">{connector.description}</p>
              </div>
            </div>

            {connector.type === "apikey" ? (
              <input
                type="password"
                placeholder={connector.placeholder}
                value={apiKeys[connector.id] ?? ""}
                onChange={(e) => setApiKeys((k) => ({ ...k, [connector.id]: e.target.value }))}
                className="w-full rounded-lg border border-white/14 bg-white/[0.04] px-4 py-2.5 text-[14px] text-white placeholder-zinc-500 focus:border-[#2BA98B] focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40 font-mono"
              />
            ) : (
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg border border-white/14 bg-white/[0.04] px-4 py-2.5 text-[12px] text-zinc-300 truncate font-mono">
                  {webhookBase}/{connector.id}
                </code>
                <button
                  onClick={() => copyWebhook(connector.id)}
                  className="shrink-0 rounded-lg border border-white/14 px-3 py-2.5 text-[12px] font-medium text-zinc-300 hover:border-[#2BA98B]/60 hover:text-[#2BA98B] transition-colors motion-reduce:transition-none"
                >
                  {copied === connector.id ? "Copied!" : "Copy"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p className="text-[13px] text-rose-400">{error}</p>}

      <div className="flex items-center justify-between border-t border-white/10 pt-6">
        <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#2BA98B]">Step 5 of 6</p>
        <button
          onClick={handleSave}
          disabled={!requiredDone || saving}
          className="rounded-lg bg-[#2BA98B] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Continue →"}
        </button>
      </div>
    </div>
  )
}

export default function ConnectPage() {
  return (
    <Suspense>
      <ConnectPageInner />
    </Suspense>
  )
}
