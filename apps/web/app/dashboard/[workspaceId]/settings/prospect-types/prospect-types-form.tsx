"use client"

/**
 * ProspectTypesForm — edit the workspace's tag-value list, rename existing
 * values, and toggle the subset that's pre-unchecked on the Companies page
 * chip filter.
 *
 * Writes to PATCH /api/workspace/[id]/config:
 *   {
 *     prospectTypes:                string[],
 *     defaultExcludedProspectTypes: string[],
 *     renames:                      Array<{ from, to }>  // rename diffs
 *   }
 *
 * Renames are derived from `originalLabel !== label` per tag. The API applies
 * them to company_tags.prospect_types in Postgres and to any matching values
 * inside messaging.templates[].prospectTypes before saving the config, so
 * already-tagged companies follow the new label instead of being orphaned.
 *
 * Save is non-destructive of company_tags rows: removing a tag value here
 * leaves any existing tagged-as-X rows in place. The chip simply disappears
 * from the filter and the per-company pill dropdown.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

const TAG_COLORS: { dot: string; text: string }[] = [
  { dot: "#10B981", text: "#A7F3D0" },
  { dot: "#3B82F6", text: "#BFDBFE" },
  { dot: "#F59E0B", text: "#FDE68A" },
  { dot: "#EF4444", text: "#FECACA" },
  { dot: "#8B5CF6", text: "#DDD6FE" },
  { dot: "#EC4899", text: "#FBCFE8" },
  { dot: "#06B6D4", text: "#A5F3FC" },
]

// Stable colour per *originalLabel* so renaming "PR Agency" -> "Agency -
// Software" doesn't reshuffle the row's dot/text colour and surprise the user.
function colorFor(value: string) {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]
}

type Tag = {
  // null for tags added in this session (no rename to emit on save).
  originalLabel: string | null
  label:         string
  excluded:      boolean
}

export function ProspectTypesForm({
  workspaceId,
  initialTypes,
  initialExcluded,
}: {
  workspaceId: string
  initialTypes:    string[]
  initialExcluded: string[]
}) {
  const router = useRouter()
  const [tags,   setTags]   = useState<Tag[]>(() =>
    initialTypes.map(t => ({
      originalLabel: t,
      label:         t,
      excluded:      initialExcluded.includes(t),
    })),
  )
  const [draft,  setDraft]  = useState("")
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function patch(i: number, next: Partial<Tag>) {
    setTags(tags.map((t, idx) => idx === i ? { ...t, ...next } : t))
    setSaved(false)
  }

  function addDraft() {
    const v = draft.trim()
    if (!v) return
    if (tags.some(t => t.label.trim().toLowerCase() === v.toLowerCase())) {
      setDraft("")
      return
    }
    setTags([...tags, { originalLabel: null, label: v, excluded: false }])
    setDraft("")
    setSaved(false)
  }

  function removeAt(i: number) {
    setTags(tags.filter((_, idx) => idx !== i))
    setSaved(false)
  }

  // ── Validation ──────────────────────────────────────────────────────────
  const trimmedLabels = tags.map(t => t.label.trim())
  const hasEmpty      = trimmedLabels.some(l => l.length === 0)
  const lowerLabels   = trimmedLabels.map(l => l.toLowerCase())
  const hasDuplicate  = lowerLabels.some((l, i) => lowerLabels.indexOf(l) !== i)
  const blockSave     = tags.length === 0 || hasEmpty || hasDuplicate

  async function save() {
    if (saving || blockSave) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const cleaned = tags.map(t => ({ ...t, label: t.label.trim() }))
      const renames = cleaned
        .filter(t => t.originalLabel && t.originalLabel !== t.label)
        .map(t => ({ from: t.originalLabel!, to: t.label }))

      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          prospectTypes:                cleaned.map(t => t.label),
          defaultExcludedProspectTypes: cleaned.filter(t => t.excluded).map(t => t.label),
          renames,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      // Bake the renames into local state: after a successful save, the new
      // label IS the original label, so the next edit can produce its own
      // diff cleanly.
      setTags(cleaned.map(t => ({ ...t, originalLabel: t.label })))
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.10em] text-[#2BA98B]">Tag values</h2>
        <p className="text-[13px] text-zinc-400">
          Each value becomes a chip on the Companies page filter and an option in the per-company dropdown.
          Click a name to rename it; already-tagged companies follow the new label automatically.
        </p>

        <ul className="space-y-1.5">
          {tags.map((tag, i) => {
            const c = colorFor(tag.originalLabel ?? tag.label)
            return (
              <li key={(tag.originalLabel ?? "new") + ":" + i} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.dot }} aria-hidden />
                <input
                  type="text"
                  value={tag.label}
                  onChange={e => patch(i, { label: e.target.value })}
                  aria-label={`Tag name${tag.originalLabel ? ` (was ${tag.originalLabel})` : ""}`}
                  spellCheck={false}
                  className="flex-1 border-0 bg-transparent px-1.5 py-0.5 text-[14px] font-medium outline-none ring-0 focus:rounded-md focus:bg-white/[0.05] focus:ring-1 focus:ring-[#2BA98B]/40"
                  style={{ color: c.text }}
                />
                <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={tag.excluded}
                    onChange={e => patch(i, { excluded: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border border-white/20 bg-transparent accent-[#2BA98B]"
                  />
                  Default-exclude
                </label>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:text-rose-300 motion-reduce:transition-none"
                  aria-label={`Remove ${tag.label}`}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addDraft() } }}
            placeholder="Add a tag value (e.g. Reseller)"
            className="flex-1 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[14px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={addDraft}
            className="rounded-xl border border-white/14 bg-white/[0.04] px-4 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-[#2BA98B]/40 hover:bg-[#2BA98B]/[0.10] hover:text-white motion-reduce:transition-none"
          >
            Add
          </button>
        </div>

        <p className="text-[11px] text-zinc-500">
          <strong className="text-zinc-400">Default-exclude</strong> = the chip starts unchecked on the Companies page.
          Companies tagged exclusively with a default-excluded value are hidden until the user ticks that chip.
          Companies carrying any other tag still appear under those chips.
        </p>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || blockSave}
          className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && <span className="text-[12px] text-[#2BA98B]">Saved.</span>}
        {hasEmpty     && <span className="text-[12px] text-rose-400">Tag names can't be empty.</span>}
        {hasDuplicate && !hasEmpty && <span className="text-[12px] text-rose-400">Tag names must be unique.</span>}
        {error        && <span className="text-[12px] text-rose-400">{error}</span>}
      </div>
    </div>
  )
}
