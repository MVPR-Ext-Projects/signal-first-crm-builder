"use client"

/**
 * Team-member select dropdown for the People and Companies pages.
 *
 * Selecting a member sets `?team=<id>` in the URL; clearing removes the
 * param. Filtering happens server-side in the page that mounts this - see
 * teamFilterClause in contact-store.ts.
 *
 * Trigger + open panel both follow the design-system spec on Paper
 * artboard 02 - Components (single-select variant A).
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useTransition } from "react"
import { FilterDropdown, type FilterItem } from "./components/filter-dropdown"

interface TeamMember {
  id:   string
  name: string
}

export function TeamMemberSelect({
  members,
  active,
}: {
  members: TeamMember[]
  active:  string | null
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function navigate(teamId: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (teamId) next.set("team", teamId)
    else next.delete("team")
    const qs = next.toString()
    startTransition(() => {
      router.push(`${pathname}${qs ? "?" + qs : ""}`)
    })
  }

  if (members.length === 0) return null

  const items: FilterItem[] = [
    { value: "", label: "All SDRs" },
    ...members.map(m => ({ value: m.id, label: m.name })),
  ]

  return (
    <div className={`transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-50" : ""}`}>
      <FilterDropdown
        pillLabel="SDR"
        emptyLabel="Select owner"
        header="Filter by SDR"
        items={items}
        activeValue={active}
        onChange={navigate}
        persistent
        panelWidth={240}
      />
    </div>
  )
}
