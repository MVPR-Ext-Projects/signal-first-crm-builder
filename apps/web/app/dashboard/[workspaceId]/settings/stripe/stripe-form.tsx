"use client"

/**
 * StripeForm - API key + mode + webhook secret editor.
 *
 * Saves via PATCH /api/workspace/[id]/config with a `stripe` block. The
 * server config route never echoes the apiKey / webhookSecret back, so
 * "configured" indicators tell the user a value is set without exposing it.
 *
 * Webhook setup is a manual step on Stripe's side: copy the workspace URL,
 * paste into Stripe's webhook settings, select the events listed below,
 * paste the resulting signing secret back here.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

const REQUIRED_WEBHOOK_EVENTS = [
  "customer.created",
  "customer.updated",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "charge.refunded",
  "product.created",
  "product.updated",
  "product.deleted",
  "price.created",
  "price.updated",
  "price.deleted",
]

export function StripeForm({
  workspaceId,
  configured,
  webhookSecretConfigured,
  initialMode,
  webhookUrl,
}: {
  workspaceId:             string
  configured:              boolean
  webhookSecretConfigured: boolean
  initialMode:             "test" | "live"
  webhookUrl:              string
}) {
  const router = useRouter()
  const [mode, setMode]                       = useState<"test" | "live">(initialMode)
  const [editKey, setEditKey]                 = useState(!configured)
  const [editWebhook, setEditWebhook]         = useState(!webhookSecretConfigured)
  const [apiKey, setApiKey]                   = useState("")
  const [webhookSecret, setWebhookSecret]     = useState("")
  const [saving, setSaving]                   = useState(false)
  const [saved, setSaved]                     = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [copied, setCopied]                   = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const stripeBody: Record<string, string> = { mode }
      if (apiKey.trim())        stripeBody.apiKey        = apiKey.trim()
      if (webhookSecret.trim()) stripeBody.webhookSecret = webhookSecret.trim()
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ stripe: stripeBody }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      // Clear the input buffers and snap back to configured-state if we just
      // set a value. The router refresh re-reads the page's server props so
      // the badges update.
      if (apiKey.trim())        { setApiKey("");        setEditKey(false) }
      if (webhookSecret.trim()) { setWebhookSecret(""); setEditWebhook(false) }
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API can fail in non-HTTPS contexts; ignore.
    }
  }

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Setup</h2>
        <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-[20px] text-zinc-300">
          <li>
            In Stripe, create a <span className="font-semibold text-white">restricted API key</span> with
            read access to customers, subscriptions, invoices, charges, products, prices, and
            balance_transactions. Paste it below.
          </li>
          <li>
            Add a webhook endpoint in Stripe pointing at the URL below. Select the events listed
            after it. Paste the webhook&rsquo;s signing secret back into this page.
          </li>
          <li>
            We&rsquo;ll start receiving events live; the daily reconcile cron backfills anything missed.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Mode</h2>
        <div className="flex items-center gap-2">
          {(["test", "live"] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setSaved(false) }}
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors motion-reduce:transition-none ${
                mode === m
                  ? "border-[#2BA98B]/60 bg-[#2BA98B]/[0.16] text-white"
                  : "border-white/12 bg-white/[0.04] text-zinc-300 hover:border-white/24 hover:text-white"
              }`}
            >
              {m === "test" ? "Test mode" : "Live mode"}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-zinc-400">
          Make sure this matches the API key you&rsquo;re pasting. Live keys start with{" "}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">rk_live_</code>{" "}
          (restricted) or <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">sk_live_</code>;
          test keys start with <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">rk_test_</code> /
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">sk_test_</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">API key</h2>
        {configured && !editKey ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#2BA98B]/[0.16] px-2.5 py-1 text-[12px] font-semibold text-[#7be4c6]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2BA98B]" />
              Configured
            </span>
            <button
              type="button"
              onClick={() => setEditKey(true)}
              className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:text-white motion-reduce:transition-none"
            >
              Replace
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); setSaved(false) }}
            placeholder="rk_live_..."
            spellCheck={false}
            autoComplete="off"
            className="w-full max-w-[480px] rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-[#2BA98B]/40"
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Webhook endpoint</h2>
        <p className="text-[12px] text-zinc-400">
          Paste this URL into Stripe&rsquo;s webhook settings (Developers &rarr; Webhooks &rarr; Add endpoint).
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[12px] font-mono text-zinc-200">
            {webhookUrl}
          </code>
          <button
            type="button"
            onClick={copyWebhookUrl}
            className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:text-white motion-reduce:transition-none"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <details className="text-[12px] text-zinc-400">
          <summary className="cursor-pointer text-zinc-300 hover:text-white">Events to subscribe to ({REQUIRED_WEBHOOK_EVENTS.length})</summary>
          <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {REQUIRED_WEBHOOK_EVENTS.map(ev => (
              <li key={ev}>
                <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-200">{ev}</code>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Webhook signing secret</h2>
        <p className="text-[12px] text-zinc-400">
          After you add the webhook in Stripe, click the endpoint and reveal the signing secret
          (starts with <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">whsec_</code>).
        </p>
        {webhookSecretConfigured && !editWebhook ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#2BA98B]/[0.16] px-2.5 py-1 text-[12px] font-semibold text-[#7be4c6]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2BA98B]" />
              Configured
            </span>
            <button
              type="button"
              onClick={() => setEditWebhook(true)}
              className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:text-white motion-reduce:transition-none"
            >
              Replace
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={webhookSecret}
            onChange={e => { setWebhookSecret(e.target.value); setSaved(false) }}
            placeholder="whsec_..."
            spellCheck={false}
            autoComplete="off"
            className="w-full max-w-[480px] rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] font-mono text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-[#2BA98B]/40"
          />
        )}
      </section>

      <div className="flex items-center gap-3 border-t border-white/10 pt-6">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#2BA98B]/60 bg-[#2BA98B]/[0.20] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#2BA98B]/[0.32] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-[12px] text-[#7be4c6]">Saved.</span>}
        {error && <span className="text-[12px] text-rose-300">{error}</span>}
      </div>
    </div>
  )
}
