import { NextRequest, NextResponse } from "next/server"
import { put } from "@vercel/blob"

export async function POST(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get("filename")
  const type = req.nextUrl.searchParams.get("type")

  if (!filename || !type) {
    return NextResponse.json({ error: "Missing filename or type" }, { status: 400 })
  }

  if (!req.body) {
    return NextResponse.json({ error: "No file body" }, { status: 400 })
  }

  const blob = await put(`wizard/${type}/${Date.now()}-${filename}`, req.body, {
    access: "public",
    contentType: req.headers.get("content-type") ?? "application/octet-stream",
  })

  return NextResponse.json({ url: blob.url })
}
