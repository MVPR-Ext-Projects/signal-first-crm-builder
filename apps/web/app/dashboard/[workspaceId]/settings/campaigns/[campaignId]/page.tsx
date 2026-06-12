/**
 * Redirect: per-campaign editing moved into the right-edge drawer on the
 * Channels page during the Channels refactor. Drop users at /actions; they
 * find the campaign in its parent channel card and click "Edit settings".
 */

import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

export default async function CampaignDetailRedirect({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  redirect(`/dashboard/${workspaceId}/actions`)
}
