"use client"

import { useState } from "react"
import { useToast } from "../../toast"

const VERB_CONFIG: { verb: string; label: string; dot: string; description: string }[] = [
  { verb: "liked_post",                label: "Liked a post",              dot: "#A78BFA", description: "Prospect liked a post by your team" },
  { verb: "commented_post",            label: "Commented on a post",       dot: "#C4B5FD", description: "Prospect commented on a post by your team" },
  { verb: "viewed_profile",            label: "Viewed profile",            dot: "#93C5FD", description: "Prospect viewed a team member's LinkedIn profile" },
  { verb: "followed_our_team_member",  label: "Followed team member",      dot: "#F59E0B", description: "Prospect followed a team member on LinkedIn" },
  { verb: "followed_our_company",      label: "Followed company page",     dot: "#FCD34D", description: "Prospect followed your company page" },
  { verb: "sent_connection_request",   label: "Sent connection request",   dot: "#2BA98B", description: "Team member sent them a connection request" },
  { verb: "accepted_our_connection",   label: "Accepted our connection",   dot: "#10B981", description: "Prospect accepted a connection request from your team" },
  { verb: "connected",                 label: "Connected",                 dot: "#10B981", description: "Connected with a team member" },
  { verb: "replied_dm_initial",        label: "Replied to DM (first)",     dot: "#FCD34D", description: "Prospect's FIRST reply in this DM thread — ambiguous (could be \"not interested\"); scored lower than subsequent replies" },
  { verb: "replied_dm_subsequent",     label: "Replied to DM (subsequent)", dot: "#2BA98B", description: "Prospect's second or later reply in the same DM thread — sustained engagement" },
  { verb: "replied_dm",                label: "Replied to DM (legacy)",    dot: "#6B7280", description: "Pre-split unified verb. Retained for backwards compatibility with historical rows; new replies use the _initial / _subsequent split above." },
  { verb: "replied_email",             label: "Replied to email",          dot: "#F59E0B", description: "Prospect replied to an outbound email" },
  { verb: "booked_meeting",            label: "Booked a meeting",          dot: "#FCD34D", description: "Prospect booked a meeting" },
  { verb: "ai_search",                 label: "AI search",                 dot: "#FB7185", description: "Prospect appeared in an AI people search" },
  { verb: "followed_prospect",         label: "Team followed them",        dot: "#10B981", description: "A team member followed this prospect (outbound)" },
  { verb: "sent_dm",                   label: "DM sent (outbound)",        dot: "#6B7280", description: "Team member sent a DM — outbound activity" },
  { verb: "sent_email",                label: "Email sent (outbound)",     dot: "#6B7280", description: "Team member sent an email — outbound activity" },
  // Email events from Resend webhook (apps/attribution/api/resend-webhook.ts)
  { verb: "email_sent",                label: "Email sent (Resend)",       dot: "#6B7280", description: "Resend confirmed the email was queued for delivery" },
  { verb: "email_delivered",           label: "Email delivered",           dot: "#6B7280", description: "Resend confirmed the email landed in the recipient's inbox" },
  { verb: "email_delivery_delayed",    label: "Email delivery delayed",    dot: "#9CA3AF", description: "Resend reported a temporary delivery delay" },
  { verb: "email_opened",              label: "Email opened",              dot: "#93C5FD", description: "Prospect opened the email (Resend open-tracking)" },
  { verb: "email_clicked",             label: "Email link clicked",        dot: "#2BA98B", description: "Prospect clicked a link in the email" },
  { verb: "email_bounced",             label: "Email bounced",             dot: "#FB7185", description: "Resend reported the email bounced — corporate email may be invalid" },
  { verb: "email_complained",          label: "Email marked as spam",      dot: "#FB7185", description: "Recipient marked the email as spam" },
  // Universal UTM click tracker (apps/attribution/api/track.ts)
  { verb: "clicked_link",              label: "Link clicked (off-email)",  dot: "#2BA98B", description: "Prospect clicked a UTM-tagged link (LinkedIn DM, lead magnet, etc.)" },
  // Call notes (Task #16) - AI-classified outcomes from manually-logged calls.
  { verb: "call_not_answered",         label: "Call not answered",         dot: "#6B7280", description: "Voicemail / no answer / line dead - the call did not connect." },
  { verb: "call_answered",             label: "Call answered",             dot: "#FCD34D", description: "Call connected, number was correct. Neutral or non-committal conversation." },
  { verb: "call_answered_problem_fit", label: "Call answered (problem fit)", dot: "#10B981", description: "Call connected AND the prospect has the problem we solve / wants to continue the conversation." },
]

type RecalcState = "idle" | "confirming" | "running" | "done"

export interface StageThresholds {
  signalFound: number
  engaged:     number
  highSignal:  number
}

export function ScoringForm({
  workspaceId,
  initialWeights,
  initialThresholds,
}: {
  workspaceId:       string
  initialWeights:    Record<string, number>
  initialThresholds: StageThresholds
}) {
  const toast = useToast()
  const [weights, setWeights]         = useState<Record<string, number>>(initialWeights)
  const [thresholds, setThresholds]   = useState<StageThresholds>(initialThresholds)
  const [saving, setSaving]           = useState(false)
  const [unsaved, setUnsaved]         = useState(false)
  const [recalcState, setRecalcState] = useState<RecalcState>("idle")
  const [contactsUpdated, setContactsUpdated] = useState<number | null>(null)

  function setWeight(verb: string, raw: string) {
    const n = parseInt(raw, 10)
    const value = Number.isNaN(n) ? 0 : Math.max(0, Math.min(100, n))
    setWeights(prev => ({ ...prev, [verb]: value }))
    setUnsaved(true)
    if (recalcState === "done") setRecalcState("idle")
  }

  function setThreshold(key: keyof StageThresholds, raw: string) {
    const n = parseInt(raw, 10)
    const value = Number.isNaN(n) ? 0 : Math.max(0, n)
    setThresholds(prev => ({ ...prev, [key]: value }))
    setUnsaved(true)
    if (recalcState === "done") setRecalcState("idle")
  }

  // Validation: thresholds must be strictly increasing so the CASE
  // expression always resolves to the highest matching stage.
  const thresholdError = (() => {
    const { signalFound, engaged, highSignal } = thresholds
    if (!Number.isFinite(signalFound) || !Number.isFinite(engaged) || !Number.isFinite(highSignal)) {
      return "Thresholds must be numbers."
    }
    if (!(signalFound < engaged && engaged < highSignal)) {
      return "Thresholds must be strictly increasing: Signal Found < Engaged < High Signal."
    }
    return null
  })()

  async function handleSave() {
    if (thresholdError) {
      toast.error("Cannot save", thresholdError)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/scoring`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verbWeights: weights, thresholds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`)
      toast.success("Saved", "New signals will use these scores and stage thresholds immediately. Run Recalculate to apply them to existing contacts.")
      setUnsaved(false)
    } catch (err) {
      toast.error("Save failed", (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRecalculate() {
    setRecalcState("running")
    setContactsUpdated(null)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/settings/scoring/recalculate`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`)
      setContactsUpdated(data.contactsUpdated ?? 0)
      setRecalcState("done")
    } catch (err) {
      toast.error("Recalculation failed", (err as Error).message)
      setRecalcState("idle")
    }
  }

  return (
    <div className="space-y-6">
      {/* Stage thresholds */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="text-[15px] font-semibold text-white">Stage thresholds</h3>
        <p className="mt-1 text-[13px] leading-[20px] text-zinc-400">
          Score-derived stages the funnel uses for contacts. A contact&rsquo;s{" "}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-zinc-200">signal_score</code>{" "}
          must reach the threshold below to land in that stage. Stages above High Signal
          (Discovery Call, Customer Won, etc.) are manual and not affected by these
          thresholds.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <ThresholdField
            label="Signal Found"
            description="Contact reaches this score → Signal Found"
            value={thresholds.signalFound}
            onChange={v => setThreshold("signalFound", v)}
          />
          <ThresholdField
            label="Engaged"
            description="Contact reaches this score → Engaged"
            value={thresholds.engaged}
            onChange={v => setThreshold("engaged", v)}
          />
          <ThresholdField
            label="High Signal"
            description="Contact reaches this score → High Signal"
            value={thresholds.highSignal}
            onChange={v => setThreshold("highSignal", v)}
          />
        </div>

        <p className="mt-3 text-[12px] text-zinc-500">
          Default: Signal Found = 3, Engaged = 6, High Signal = 26. Below the Signal
          Found threshold a contact is Prospect.
        </p>
        {thresholdError && (
          <p className="mt-3 text-[12px] text-rose-300">{thresholdError}</p>
        )}
      </div>

      {/* Weights table */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Engagement type</th>
              <th className="hidden px-6 py-3 text-left text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B] sm:table-cell">Description</th>
              <th className="px-6 py-3 text-right text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Points</th>
            </tr>
          </thead>
          <tbody>
            {VERB_CONFIG.map(({ verb, label, dot, description }) => (
              <tr key={verb} className="border-b border-white/[0.04] last:border-0">
                <td className="px-6 py-3.5">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden />
                    <span className="font-medium text-white">{label}</span>
                  </span>
                </td>
                <td className="hidden px-6 py-3.5 text-zinc-400 sm:table-cell">{description}</td>
                <td className="px-6 py-3.5 text-right">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={weights[verb] ?? 0}
                    onChange={e => setWeight(verb, e.target.value)}
                    className="w-16 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-right text-[13px] text-zinc-200 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-[12px] text-zinc-500">Points capped at 100 per engagement. Set to 0 to exclude an engagement type from scoring.</p>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !unsaved}
          className="rounded-lg bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#239977] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save weights"}
        </button>
      </div>

      {/* Recalculate section — always visible */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h3 className="text-[15px] font-semibold text-white">Recalculate existing scores</h3>
        <p className="mt-1 text-[13px] leading-[20px] text-zinc-400">
          Applies your current weights to all existing signals in this workspace, then recomputes every contact&rsquo;s total score and funnel stage. Run this after changing weights.
        </p>

        <div className="mt-4">
          {recalcState === "idle" && (
            <button
              type="button"
              onClick={() => setRecalcState("confirming")}
              disabled={unsaved}
              className="rounded-lg border border-white/10 px-4 py-2 text-[13px] font-medium text-zinc-300 transition-colors hover:border-[#2BA98B]/40 hover:text-[#2BA98B] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Recalculate scores
            </button>
          )}

          {recalcState === "confirming" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-4 space-y-3">
              <p className="text-[13px] text-amber-200">
                This will update score values on all existing signals and recalculate every contact&rsquo;s funnel stage. This cannot be undone.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRecalculate}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-[13px] font-semibold text-black hover:bg-amber-400"
                >
                  Yes, recalculate all scores
                </button>
                <button
                  type="button"
                  onClick={() => setRecalcState("idle")}
                  className="rounded-lg px-4 py-2 text-[13px] text-zinc-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {recalcState === "running" && (
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
              <svg className="animate-spin shrink-0 text-[#2BA98B]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M21 12a9 9 0 1 1-6.22-8.55" />
              </svg>
              <p className="text-[13px] text-zinc-300">
                Recalculating signal scores across all contacts — this may take a few seconds…
              </p>
            </div>
          )}

          {recalcState === "done" && (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <p className="text-[13px] text-emerald-300">
                  Done — <strong>{contactsUpdated}</strong> contact{contactsUpdated === 1 ? "" : "s"} recalculated.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRecalcState("idle")}
                className="text-[12px] text-zinc-500 hover:text-zinc-300"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {unsaved && recalcState === "idle" && (
          <p className="mt-3 text-[12px] text-amber-400">Save your weights first before recalculating.</p>
        )}
      </div>
    </div>
  )
}

function ThresholdField({
  label,
  description,
  value,
  onChange,
}: {
  label:       string
  description: string
  value:       number
  onChange:    (raw: string) => void
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">{label}</span>
      <input
        type="number"
        min={0}
        value={Number.isFinite(value) ? value : 0}
        onChange={e => onChange(e.target.value)}
        className="mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-200 focus:border-[#2BA98B]/40 focus:outline-none focus:ring-1 focus:ring-[#2BA98B]/40"
      />
      <span className="mt-1 block text-[11px] text-zinc-500">{description}</span>
    </label>
  )
}
