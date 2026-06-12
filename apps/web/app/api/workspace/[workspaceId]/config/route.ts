import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, patchWorkspaceConfig } from "@/lib/workspace-config"
import { renameCompanyProspectType } from "@/lib/db/contact-store"

type ProspectTypeRename = { from: string; to: string }

function parseRenames(value: unknown): ProspectTypeRename[] {
  if (!Array.isArray(value)) return []
  const out: ProspectTypeRename[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const from = typeof (entry as { from?: unknown }).from === "string" ? (entry as { from: string }).from.trim() : ""
    const to   = typeof (entry as { to?:   unknown }).to   === "string" ? (entry as { to:   string }).to.trim()   : ""
    if (!from || !to || from === to) continue
    if (seen.has(from)) continue
    seen.add(from)
    out.push({ from, to })
  }
  return out
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Strip API keys from response
  const { enrichment, messaging, resend, stripe, ...safe } = config
  return NextResponse.json({
    ...safe,
    enrichment: {
      surfe:  enrichment?.surfe  ? { configured: true } : undefined,
      apollo: enrichment?.apollo ? { configured: true } : undefined,
      clay:   enrichment?.clay   ? { configured: true } : undefined,
      apify:  enrichment?.apify  ? { configured: true } : undefined,
    },
    messaging: {
      unipile: messaging?.unipile
        ? { configured: true, dsn: messaging.unipile.dsn, accountId: messaging.unipile.accountId }
        : undefined,
      outreachContext: messaging?.outreachContext ?? "",
    },
    resend: {
      configured: !!resend?.apiKey,
      senders: resend?.senders ?? [],
    },
    stripe: stripe
      ? {
          configured: !!stripe.apiKey,
          mode: stripe.mode,
          webhookSecretConfigured: !!stripe.webhookSecret,
        }
      : undefined,
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const body = await req.json()

  // ── Custom-tag renames ───────────────────────────────────────────────────
  // The Custom Tags settings page sends a `renames` array alongside the
  // updated prospectTypes list when the user edits an existing label. Apply
  // those renames in Postgres (company_tags.prospect_types) and rewrite any
  // matching values inside config.messaging.templates[].prospectTypes before
  // patching, so already-tagged companies + scoped templates follow the new
  // label instead of being orphaned with the old one.
  const { renames: rawRenames, ...patch } =
    body && typeof body === "object" ? body as { renames?: unknown } & Record<string, unknown> : {}
  const renames = parseRenames(rawRenames)

  if (renames.length > 0) {
    for (const { from, to } of renames) {
      await renameCompanyProspectType(workspaceId, from, to)
    }

    // Rewrite templates[].prospectTypes inside the incoming patch when present
    // so the saved config matches the new label set. If the caller didn't send
    // a messaging.templates field, we leave existing templates untouched
    // (they'll be migrated next time the messaging settings page saves).
    const map = new Map(renames.map(r => [r.from, r.to]))
    const messaging = (patch as { messaging?: { templates?: Array<{ prospectTypes?: string[] }> } }).messaging
    if (messaging?.templates) {
      messaging.templates = messaging.templates.map(t =>
        t.prospectTypes
          ? { ...t, prospectTypes: t.prospectTypes.map(p => map.get(p) ?? p) }
          : t,
      )
    }
  }

  const updated = await patchWorkspaceConfig(workspaceId, patch)

  // Note: editing personas here does NOT re-classify existing contacts.
  // Use POST /api/dashboard/<workspaceId>/personas/reclassify (the
  // "Reclassify all contacts" button on the Personas page) to apply the
  // new match rules to existing rows. New contacts arriving via the
  // Teamfluence webhook get classified inline so they're always current.

  // Strip API keys from response
  const { enrichment, messaging, resend, ...safe } = updated
  return NextResponse.json({
    ...safe,
    enrichment: {
      surfe:  enrichment?.surfe  ? { configured: true } : undefined,
      apollo: enrichment?.apollo ? { configured: true } : undefined,
      clay:   enrichment?.clay   ? { configured: true } : undefined,
      apify:  enrichment?.apify  ? { configured: true } : undefined,
    },
    messaging: {
      unipile: messaging?.unipile
        ? { configured: true, dsn: messaging.unipile.dsn, accountId: messaging.unipile.accountId }
        : undefined,
      outreachContext: messaging?.outreachContext ?? "",
    },
    resend: {
      configured: !!resend?.apiKey,
      senders: resend?.senders ?? [],
    },
  })
}
