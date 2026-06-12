import { redirect } from "next/navigation"

export default async function DashboardRoot({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const { workspaceId } = await params
  redirect(`/dashboard/${workspaceId}/companies`)
}
