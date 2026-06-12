/**
 * Neon Postgres client.
 *
 * Uses @neondatabase/serverless Pool (WebSocket transport). A pool persists
 * across requests within a Fluid Compute instance, so the TLS/WS handshake
 * happens once per instance rather than once per query. With the previous
 * HTTP driver, every sql.query() was its own HTTPS round trip — 4 count
 * queries on the SDR page took ~290ms each (almost all of that was the round
 * trip, not the query). Pool reuses one persistent connection.
 *
 * The exported surface is unchanged: sql() returns a callable that supports
 * both tagged-template (sql`SELECT ...`) and .query(text, params) forms,
 * each resolving to a row array — same as the HTTP driver did.
 *
 * Set DATABASE_URL in .env.local (Neon connection string with ?sslmode=require).
 * If DATABASE_URL is not set, sql() will throw at call time — check
 * isDbConfigured() before calling if you want a graceful fallback.
 *
 * Node 20+ has built-in WebSocket so no `ws` package is required.
 */

import { Pool } from "@neondatabase/serverless"

export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL
}

let cached: Pool | undefined

function pool(): Pool {
  if (!cached) {
    cached = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return cached
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * Same shape as the HTTP driver's neon() return value: a function that's
 * both callable as a tagged template AND has a .query(text, params) method.
 * Both forms resolve to a row array (not a result object).
 */
export interface NeonLike {
  <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>
}

export function sql(): NeonLike {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — provision a Neon database and add it to .env.local")
  }
  const p = pool()

  // Tagged-template form: stitch the string parts back together with $1, $2
  // placeholders, hand the values off as the parameters array.
  const fn = (async <T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
    let text = strings[0]
    for (let i = 0; i < values.length; i++) {
      text += `$${i + 1}` + strings[i + 1]
    }
    const result = await p.query<T>(text, values)
    return result.rows
  }) as NeonLike

  fn.query = async <T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]> => {
    const result = await p.query<T>(text, params ?? [])
    return result.rows
  }

  return fn
}
