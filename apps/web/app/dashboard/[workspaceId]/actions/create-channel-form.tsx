"use client"

/**
 * CreateChannelForm - top-of-page affordance for adding a new channel.
 * Channel = { name, delivery mechanism, has fingerprint flag }.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

type Delivery = "none" | "unipile" | "resend" | "twilio_voice"

const DELIVERY_LABELS: Record<Delivery, string> = {
  none:         "No delivery (e.g. PR coverage)",
  unipile:      "LinkedIn DM via Unipile",
  resend:       "Email via Resend",
  twilio_voice: "Voice calls via Twilio (coming soon)",
}

export function CreateChannelForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [delivery, setDelivery] = useState<Delivery>("unipile")
  const [hasFingerprint, setHasFingerprint] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError("Name is required."); return }
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/channels`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:              name.trim(),
          deliveryMechanism: delivery,
          hasFingerprint,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setName("")
      setOpen(false)
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-zinc-100 transition-colors hover:border-white/24 motion-reduce:transition-none"
      >
        + Create channel
      </button>
    )
  }

  // Fingerprint only relevant for written-channel deliveries (Unipile, Resend).
  // Voice (Twilio) and no-delivery channels don't carry a writing-style fingerprint.
  const fingerprintAllowed = delivery === "unipile" || delivery === "resend"

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-bold text-white">Create a channel</h3>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null) }}
          className="text-[12px] text-zinc-400 hover:text-zinc-200"
        >Cancel</button>
      </div>

      <div className="space-y-2">
        <label className="block text-[11px] font-medium text-zinc-400" htmlFor="ch-name">Name</label>
        <input
          id="ch-name"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. LinkedIn DM (Founders network)"
          className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/24 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-[11px] font-medium text-zinc-400" htmlFor="ch-delivery">Delivery mechanism</label>
        <select
          id="ch-delivery"
          value={delivery}
          onChange={e => setDelivery(e.target.value as Delivery)}
          className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 focus:border-white/24 focus:outline-none"
        >
          {(Object.keys(DELIVERY_LABELS) as Delivery[]).map(d => (
            <option key={d} value={d}>{DELIVERY_LABELS[d]}</option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-zinc-200">
        <input
          type="checkbox"
          checked={hasFingerprint && fingerprintAllowed}
          disabled={!fingerprintAllowed}
          onChange={e => setHasFingerprint(e.target.checked)}
        />
        Enable per-campaign writing-style fingerprint
        {!fingerprintAllowed && (
          <span className="text-zinc-500">(only available for delivery channels)</span>
        )}
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[12px] font-semibold text-white hover:bg-[#249A7E] disabled:opacity-50"
        >{busy ? "Creating..." : "Create channel"}</button>
        {error && <p className="text-[12px] text-red-400">{error}</p>}
      </div>
    </div>
  )
}
