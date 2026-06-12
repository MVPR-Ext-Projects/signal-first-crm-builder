/**
 * Enrichment poll cron — runs every 2 minutes, processes pending Surfe enrichments
 * that are old enough to have a result (≥60s).
 *
 * Cron: "* * * * *" (every 2 min via vercel.json)
 * Protected by CRON_SECRET header.
 */

import { NextRequest, NextResponse } from "next/server"
import { processPendingEnrichments } from "@/lib/enrichment"

async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await processPendingEnrichments()
  console.log(`[enrichment-poll] processed=${result.processed} pending=${result.pending} failed=${result.failed}`)
  return NextResponse.json({ ok: true, ...result })
}

export const GET = handle
export const POST = handle
