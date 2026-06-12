/**
 * Redirect: /settings/campaigns was renamed to /settings/channel-settings
 * as part of the Channels refactor. The per-campaign CRUD that used to
 * live here now lives in the Channels page drawer.
 */

import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

export default async function CampaignsSettingsRedirect({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  redirect(`/dashboard/${workspaceId}/settings/channel-settings`)
}
