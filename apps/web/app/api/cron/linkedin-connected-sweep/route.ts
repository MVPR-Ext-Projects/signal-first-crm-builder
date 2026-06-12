/**
 * Daily LinkedIn-connected sweep.
 *
 * Finds contacts across all workspaces where linkedin_connected IS NULL
 * and a 'connected' or 'accepted_our_connection' signal exists anywhere
 * in their full signal history. Sets linkedin_connected = TRUE.
 *
 * Safe to run repeatedly — only touches NULL rows (not manual FALSE overrides).
 * New accounts onboarding after the initial migration will be caught here.
 *
 * Schedule: daily 02:30 UTC (before email-freshness at 11:00 UTC).
 *
 * Auth: Bearer CRON_SECRET in the Authorization header.
 */

import { NextRequest, NextResponse } from "next/server"
import { isDbConfigured } from "@/lib/db"
import { sweepLinkedinConnected } from "@/lib/db/contact-store"

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 })
  }

  const updated = await sweepLinkedinConnected()
  return NextResponse.json({ ok: true, updated })
}
