"use client"

/**
 * TeamFiltersForm — manages the workspace's team-member roster. Each
 * member is a name with a stable id; assignment to companies is manual
 * via the inline picker on the Companies page.
 *
 * Saves via PATCH /api/workspace/[id]/config. New members get a randomly
 * generated id the first time they're added. Removing a member here does
 * not unassign them from any companies they're currently on — those rows
 * just become orphaned data on company_tags.assigned_team_member_id, which
 * the page renders gracefully (drops back to "Unassigned" in the picker).
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

interface TeamMember {
  id:   string
  name: string
}

function newId(): string {
  // Tiny non-cryptographic id generator. Enough uniqueness for workspace-scoped
  // member ids that get created at human pace.
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36).slice(-4)
}

export function TeamFiltersForm({
  workspaceId,
  initialMembers,
}: {
  workspaceId:    string
  initialMembers: TeamMember[]
}) {
  const router = useRouter()
  const [members, setMembers] = useState<TeamMember[]>(initialMembers)
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function addMember() {
    setMembers([...members, { id: newId(), name: "" }])
    setSaved(false)
  }
  function removeMember(id: string) {
    setMembers(members.filter(m => m.id !== id))
    setSaved(false)
  }
  function updateMember(id: string, name: string) {
    setMembers(members.map(m => m.id === id ? { ...m, name } : m))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const cleanMembers = members
        .filter(m => m.name.trim().length > 0)
        .map(m => ({ id: m.id, name: m.name.trim() }))
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ teamMembers: cleanMembers }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }))
        setError(errBody.error ?? `HTTP ${res.status}`)
        return
      }
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Team members</h2>
          <button
            type="button"
            onClick={addMember}
            className="rounded-lg border border-white/14 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
          >
            + Add member
          </button>
        </div>
        <p className="text-[13px] text-zinc-400">
          Add the SDRs on your team. Once added, they show up as an &ldquo;Assign&rdquo; picker on each company row in the Companies page, and as a filter on the People and Companies pages.
        </p>

        {members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-[13px] text-zinc-500">
            No team members yet. Add one to start splitting accounts across the team.
          </p>
        ) : (
          <ul className="space-y-2">
            {members.map(m => (
              <li key={m.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <input
                  type="text"
                  value={m.name}
                  onChange={e => updateMember(m.id, e.target.value)}
                  placeholder="Name (e.g. Tom Lawrence)"
                  className="flex-1 rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[14px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeMember(m.id)}
                  className="rounded-lg px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:text-rose-300 motion-reduce:transition-none"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-[#2BA98B]/30 bg-[#2BA98B]/[0.08] px-5 py-4 backdrop-blur">
        <div className="text-[13px]">
          {error && <span className="text-rose-400">{error}</span>}
          {saved && !error && <span className="text-emerald-400">Saved.</span>}
          {!saved && !error && <span className="text-zinc-300">Changes apply across People, Companies, and Signals.</span>}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}
