/**
 * One-time Postgres backfill — was originally a CRM → Postgres migration.
 *
 * The CRM source for this backfill has been retired; the gtm-os Postgres
 * projection is now the source of truth and is populated by the inbound
 * webhook + cron paths. This endpoint is left as a tombstone so any saved
 * admin link still gets a clear response.
 */

import { NextRequest, NextResponse } from "next/server"

export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: "Gone",
      message: "The Postgres backfill is no longer wired. Postgres is now the source of truth; populate it via the inbound webhooks.",
    },
    { status: 410 },
  )
}
