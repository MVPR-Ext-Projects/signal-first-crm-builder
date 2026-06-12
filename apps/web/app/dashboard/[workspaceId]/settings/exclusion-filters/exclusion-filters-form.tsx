"use client"

/**
 * ExclusionFiltersForm — three comma-separated lists that drop noise from
 * the workspace's queue: own-employee email domains, own-employee company
 * names, and agency-tracked Teamfluence team_member_emails.
 *
 * Saves via PATCH /api/workspace/[id]/config.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"

function parseList(input: string): string[] {
  return input.split(",").map(s => s.trim()).filter(Boolean)
}
function formatList(arr: string[] | undefined): string {
  return (arr ?? []).join(", ")
}

function parseLines(input: string): string[] {
  return input.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
}
function formatLines(arr: string[] | undefined): string {
  return (arr ?? []).join("\n")
}

export function ExclusionFiltersForm({
  workspaceId,
  initialEmailDomains,
  initialCompanyNames,
  initialAgencyEmails,
  initialLinkedinUrls,
}: {
  workspaceId:         string
  initialEmailDomains: string[]
  initialCompanyNames: string[]
  initialAgencyEmails: string[]
  initialLinkedinUrls: string[]
}) {
  const router = useRouter()
  const [domains,   setDomains]   = useState(formatList(initialEmailDomains))
  const [companies, setCompanies] = useState(formatList(initialCompanyNames))
  const [agency,    setAgency]    = useState(formatList(initialAgencyEmails))
  const [linkedin,  setLinkedin]  = useState(formatLines(initialLinkedinUrls))
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/config`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          internalEmailDomains:   parseList(domains),
          internalCompanyNames:   parseList(companies),
          agencyTeamMemberEmails: parseList(agency),
          internalLinkedinUrls:   parseLines(linkedin),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        setError(body.error ?? `HTTP ${res.status}`)
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
    <div className="space-y-6">
      <Field
        label="Email domains"
        value={domains}
        onChange={v => { setDomains(v); setSaved(false) }}
        placeholder="example.com, example.co"
        hint="Anyone whose verified email matches one of these is purged after Surfe enrichment."
      />
      <Field
        label="Company names"
        value={companies}
        onChange={v => { setCompanies(v); setSaved(false) }}
        placeholder="Example Co, Example Group"
        hint="Case-insensitive substring match against the contact's company."
      />
      <Field
        label="Agency team-member emails"
        value={agency}
        onChange={v => { setAgency(v); setSaved(false) }}
        placeholder="agent@youragency.com"
        hint="Skip Teamfluence webhook events whose team_member_email matches this list — useful when an operator's profile is tracked under the same TF account but isn't a customer employee."
      />

      <div>
        <label className="mb-1 block text-[13px] font-medium text-zinc-200">Excluded LinkedIn URLs</label>
        <textarea
          rows={Math.min(8, Math.max(3, (linkedin.match(/\n/g)?.length ?? 0) + 2))}
          value={linkedin}
          onChange={e => { setLinkedin(e.target.value); setSaved(false) }}
          placeholder={"https://www.linkedin.com/in/example/\nhttps://www.linkedin.com/in/another/"}
          className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 font-mono text-[12px] leading-[1.5] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          One URL per line. Anyone in this list is dropped at the webhook entry point. Remove a URL here to un-exclude the person - future signals will create a new contact (the original row was deleted at exclude-time).
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-xl bg-[#2BA98B] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#249A7E] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-[12px] text-[#2BA98B]">Saved.</span>}
        {error && <span className="text-[12px] text-rose-400">{error}</span>}
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, placeholder, hint,
}: {
  label:       string
  value:       string
  onChange:    (v: string) => void
  placeholder: string
  hint?:       string
}) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-zinc-200">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-[#2BA98B]/40 focus:outline-none"
      />
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}
