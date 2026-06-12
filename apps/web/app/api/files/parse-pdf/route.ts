import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

const RequestSchema = z.object({
  url: z.string().url(),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing or invalid url" }, { status: 400 })
  }

  const { url } = parsed.data

  // Fetch the PDF from Vercel Blob
  let pdfBuffer: ArrayBuffer
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch PDF" }, { status: 502 })
    }
    pdfBuffer = await res.arrayBuffer()
  } catch {
    return NextResponse.json({ error: "Failed to download file" }, { status: 502 })
  }

  // Parse PDF text
  try {
    const pdfParse = (await import("pdf-parse")).default
    const data = await pdfParse(Buffer.from(pdfBuffer))

    // Trim to ~8000 chars to stay within model context limits
    const text = data.text.slice(0, 8000).trim()

    return NextResponse.json({
      text,
      pageCount: data.numpages,
      characterCount: text.length,
    })
  } catch (err) {
    console.error("[parse-pdf] Error parsing PDF:", err)
    return NextResponse.json({ error: "Failed to parse PDF text" }, { status: 422 })
  }
}
