"use client"

/**
 * Signal verb filter on the Signals page. Sets `?source=<verb>` in the
 * URL; clearing removes it. Filtering happens server-side in the page.
 *
 * Trigger + open panel follow the design-system spec on Paper artboard
 * 02 - Components (long-list variant C, minus the search box - the verb
 * count today is small enough that the simple single-select rendering
 * is fine. Add search later if the verb enum grows past ~20).
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { FilterDropdown, type FilterItem } from "../components/filter-dropdown"

interface VerbOption { signalVerb: string; count: number }

const VERB_LABELS: Record<string, string> = {
  liked_post:                 "Liked a post",
  commented_post:             "Commented on a post",
  viewed_profile:             "Viewed a profile",
  followed_our_team_member:   "Followed team member",
  followed_prospect:          "Followed by us",
  followed_our_company:       "Followed our company",
  sent_connection_request:    "Connection request sent",
  accepted_our_connection:    "Accepted connection",
  connected:                  "Connected",
  sent_dm:                    "Sent DM",
  replied_dm:                 "Replied to DM",
  replied_dm_initial:         "Replied to DM (first)",
  replied_dm_subsequent:      "Replied to DM (subsequent)",
  sent_email:                 "Sent email",
  replied_email:              "Replied to email",
  email_opened:               "Email opened",
  email_clicked:              "Email link clicked",
  email_bounced:              "Email bounced",
  email_complained:           "Email marked as spam",
  clicked_link:               "Link clicked",
  booked_meeting:             "Booked meeting",
  ai_search:                  "AI search",
  pr_pitch_sent:              "PR pitch sent",
  pr_journalist_replied:      "Journalist replied",
  pr_coverage_published:      "Coverage published",
}

export function SourceTypeSelect({
  options,
  active,
}: {
  options: VerbOption[]
  active:  string | null
}) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  function navigate(value: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set("source", value)
    else next.delete("source")
    next.delete("p")
    const qs = next.toString()
    router.push(`${pathname}${qs ? "?" + qs : ""}`)
  }

  if (options.length === 0) return null

  const allCount = options.reduce((n, o) => n + o.count, 0)
  const items: FilterItem[] = [
    { value: "", label: "All signals", meta: allCount.toLocaleString() },
    ...options.map(o => ({
      value: o.signalVerb,
      label: VERB_LABELS[o.signalVerb] ?? o.signalVerb,
      meta:  o.count.toLocaleString(),
    })),
  ]

  return (
    <FilterDropdown
      pillLabel="Signal type"
      header={`${options.length === 1 ? "1 signal type" : `${options.length} signal types`}`}
      items={items}
      activeValue={active}
      onChange={navigate}
      panelWidth={300}
    />
  )
}
