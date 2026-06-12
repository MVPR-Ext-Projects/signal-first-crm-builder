import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import ExcelJS from "exceljs"

const RequestSchema = z.object({
  url: z.string().url(),
})

type DetectedType = "people" | "companies" | "deals" | "unknown"

function detectRecordType(headers: string[]): DetectedType {
  const lower = headers.map((h) => h.toLowerCase())

  const peopleSignals = ["first name", "last name", "firstname", "lastname", "email", "linkedin", "twitter", "job title", "title"]
  const companySignals = ["company name", "domain", "website", "industry", "employees", "revenue", "founded"]
  const dealSignals = ["deal", "opportunity", "stage", "amount", "value", "close date", "pipeline"]

  const peopleScore = lower.filter((h) => peopleSignals.some((s) => h.includes(s))).length
  const companyScore = lower.filter((h) => companySignals.some((s) => h.includes(s))).length
  const dealScore = lower.filter((h) => dealSignals.some((s) => h.includes(s))).length

  const max = Math.max(peopleScore, companyScore, dealScore)
  if (max === 0) return "unknown"
  if (max === dealScore) return "deals"
  if (max === companyScore) return "companies"
  return "people"
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object" && "text" in value) return String(value.text)
  if (typeof value === "object" && "result" in value) return String((value as ExcelJS.CellFormulaValue).result ?? "")
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

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

  let buffer: ArrayBuffer
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch file" }, { status: 502 })
    }
    buffer = await res.arrayBuffer()
  } catch {
    return NextResponse.json({ error: "Failed to download file" }, { status: 502 })
  }

  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)

    const worksheet = workbook.worksheets[0]
    if (!worksheet) {
      return NextResponse.json({ error: "No sheets found in file" }, { status: 422 })
    }

    // First row is headers
    const headerRow = worksheet.getRow(1)
    const originalHeaders: string[] = []
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      originalHeaders.push(cellToString(cell.value))
    })

    if (originalHeaders.length === 0) {
      return NextResponse.json({ error: "File has no header row" }, { status: 422 })
    }

    const normalisedHeaders = originalHeaders.map(normaliseHeader)

    // Collect data rows (skip header row 1)
    const rawRows: Record<string, string>[] = []
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return
      const record: Record<string, string> = {}
      originalHeaders.forEach((header, i) => {
        record[normaliseHeader(header)] = cellToString(row.getCell(i + 1).value)
      })
      rawRows.push(record)
    })

    if (rawRows.length === 0) {
      return NextResponse.json({ error: "File has no data rows" }, { status: 422 })
    }

    const detectedType = detectRecordType(originalHeaders)
    const sampleRows = rawRows.slice(0, 5)

    return NextResponse.json({
      headers: normalisedHeaders,
      originalHeaders,
      rowCount: rawRows.length,
      sampleRows,
      detectedType,
    })
  } catch (err) {
    console.error("[parse-csv] Error parsing file:", err)
    return NextResponse.json({ error: "Failed to parse file" }, { status: 422 })
  }
}
