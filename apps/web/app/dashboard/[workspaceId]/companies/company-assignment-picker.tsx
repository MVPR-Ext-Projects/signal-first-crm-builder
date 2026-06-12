"use client"

/**
 * Inline SDR / team-member picker on each company row in the Companies page.
 * Shows the current assignment (or "Unassigned") and writes the change
 * straight to /api/dashboard/[workspaceId]/companies/assignment, then
 * refreshes the RSC tree so the page-level filter pills + count pills
 * reflect the new state.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

interface TeamMember { id: string; name: string }

export function CompanyAssignmentPicker({
  workspaceId,
  companyName,
  initialAssignment,
  members,
}: {
  workspaceId:        string
  companyName:        string
  initialAssignment:  string | null
  members:            TeamMember[]
}) {
  const router = useRouter()
  const [assigned, setAssigned] = useState<string | null>(initialAssignment)
  const [busy, setBusy] = useState(false)

  if (members.length === 0) return null

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value === "" ? null : e.target.value
    const prev = assigned
    setAssigned(next)
    setBusy(true)
    try {
      const res = await fetch(`/api/dashboard/${workspaceId}/companies/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, teamMemberId: next }),
      })
      if (!res.ok) {
        setAssigned(prev)
        return
      }
      router.refresh()
    } catch {
      setAssigned(prev)
    } finally {
      setBusy(false)
    }
  }

  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        assigned
          ? "border-[#2BA98B]/30 bg-[#2BA98B]/[0.10] text-[#A7F3D0]"
          : "border-white/[0.10] bg-white/[0.03] text-zinc-400 hover:border-white/[0.20] hover:text-zinc-200"
      } ${busy ? "opacity-60" : ""}`}
      title={assigned ? `Assigned to ${members.find(m => m.id === assigned)?.name ?? "—"}` : "Assign SDR"}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
      </svg>
      <select
        value={assigned ?? ""}
        onChange={onChange}
        disabled={busy}
        aria-label="Assigned SDR"
        className="cursor-pointer bg-transparent outline-none disabled:cursor-not-allowed"
      >
        <option value="">Unassigned</option>
        {members.map(m => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </label>
  )
}
