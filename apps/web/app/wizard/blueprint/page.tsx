import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { getSession, SESSION_COOKIE } from "@/lib/session"
import BlueprintClient from "./blueprint-client"

export default async function BlueprintPage() {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value

  if (!sessionId) redirect("/wizard")

  const session = await getSession(sessionId)
  if (!session?.blueprint) redirect("/wizard/analyzing")

  return <BlueprintClient blueprint={session.blueprint} sessionId={sessionId} />
}
