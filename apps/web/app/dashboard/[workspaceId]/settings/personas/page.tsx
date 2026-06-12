/**
 * Legacy redirect: /settings/personas -> /settings/company-messaging.
 *
 * The Personas page was rolled into the broader "Company Messaging" hub in
 * the cozy-tiger plan (Phase 2). Personas remain a section of that page;
 * only the URL moved. Kept around so existing bookmarks and any cached
 * internal links keep working.
 */

import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

export default async function PersonasLegacyRedirect({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  redirect(`/dashboard/${workspaceId}/settings/company-messaging`)
}
