import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig } from "@/lib/workspace-config"

const LI_POST_RE = /linkedin\.com\/(feed\/update|posts)\//

function truncate8(text: string): string {
  const words = text.trim().split(/\s+/)
  if (words.length <= 8) return text.trim()
  return words.slice(0, 8).join(" ") + "…"
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params

  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ title: null }, { status: 404 })

  if (config.accessToken) {
    const cookieStore = await cookies()
    const token = cookieStore.get(`dashboard_auth_${workspaceId}`)?.value
    if (token !== config.accessToken) {
      return NextResponse.json({ title: null }, { status: 401 })
    }
  }

  const url = request.nextUrl.searchParams.get("url")
  if (!url || !LI_POST_RE.test(url)) {
    return NextResponse.json({ title: null })
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 86400 },
    })
    if (!res.ok) return NextResponse.json({ title: null })

    const html = await res.text()
    const match = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)
                ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/)
    if (!match) return NextResponse.json({ title: null })

    let title = match[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    // Strip " | Author Name" suffix LinkedIn appends
    const pipe = title.lastIndexOf(" | ")
    if (pipe > 12) title = title.slice(0, pipe).trim()
    // Strip surrounding quotes LinkedIn sometimes adds
    title = title.replace(/^["']|["']$/g, "").trim()

    return NextResponse.json(
      { title: truncate8(title) },
      { headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600" } },
    )
  } catch {
    return NextResponse.json({ title: null })
  }
}
