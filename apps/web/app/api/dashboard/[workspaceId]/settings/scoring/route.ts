import { NextRequest, NextResponse } from "next/server"
import { getWorkspaceConfig, patchWorkspaceConfig } from "@/lib/workspace-config"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params
  const config = await getWorkspaceConfig(workspaceId)
  if (!config) return NextResponse.json({ error: "Workspace not found" }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body || (body.verbWeights === undefined && body.thresholds === undefined)) {
    return NextResponse.json({ error: "verbWeights and/or thresholds required" }, { status: 400 })
  }

  // Validate verbWeights if present.
  let weights: Record<string, number> | undefined
  if (body.verbWeights !== undefined) {
    if (typeof body.verbWeights !== "object" || body.verbWeights === null) {
      return NextResponse.json({ error: "verbWeights must be an object" }, { status: 400 })
    }
    const rawWeights = body.verbWeights as Record<string, unknown>
    for (const [k, v] of Object.entries(rawWeights)) {
      if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) {
        return NextResponse.json({ error: `Invalid weight for "${k}": must be a non-negative number` }, { status: 400 })
      }
    }
    weights = rawWeights as Record<string, number>
  }

  // Validate thresholds if present: each value is a non-negative integer; the
  // three must be monotonically increasing so the CASE expression always
  // resolves to the highest matching stage.
  let thresholds: { signalFound: number; engaged: number; highSignal: number } | undefined
  if (body.thresholds !== undefined) {
    const t = body.thresholds
    if (!t || typeof t !== "object") {
      return NextResponse.json({ error: "thresholds must be an object" }, { status: 400 })
    }
    const sf = t.signalFound, en = t.engaged, hs = t.highSignal
    for (const [k, v] of [["signalFound", sf], ["engaged", en], ["highSignal", hs]] as const) {
      if (typeof v !== "number" || v < 0 || !Number.isInteger(v) || !Number.isFinite(v)) {
        return NextResponse.json({ error: `Invalid threshold "${k}": must be a non-negative integer` }, { status: 400 })
      }
    }
    if (!(sf < en && en < hs)) {
      return NextResponse.json({ error: "Thresholds must be strictly increasing: signalFound < engaged < highSignal" }, { status: 400 })
    }
    thresholds = { signalFound: sf, engaged: en, highSignal: hs }
  }

  await patchWorkspaceConfig(workspaceId, {
    scoring: {
      ...(config.scoring ?? {}),
      ...(weights    !== undefined ? { verbWeights: weights }    : {}),
      ...(thresholds !== undefined ? { thresholds }              : {}),
    },
  })

  return NextResponse.json({ ok: true })
}
