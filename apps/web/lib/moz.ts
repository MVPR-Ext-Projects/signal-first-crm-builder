/**
 * Moz unified API client (JSON-RPC 2.0).
 *
 * Endpoint: POST https://api.moz.com/jsonrpc
 * Auth:     x-moz-token header (single API key from moz.com/api)
 * Method:   data.site.metrics.fetch
 */

const MOZ_JSONRPC = "https://api.moz.com/jsonrpc"

export interface MozDomainMetrics {
  domainAuthority: number | null
  pageAuthority: number | null
  backlinks: number | null
  rootDomains: number | null
  spamScore: number | null
}

/**
 * Normalise an arbitrary string into a bare domain name, stripping protocol,
 * www prefix, paths, and trailing slashes.
 *
 * "https://www.example.com/blog" → "example.com"
 */
export function normaliseDomain(input: string): string {
  const stripped = input.trim().replace(/^https?:\/\//, "").replace(/^www\./, "")
  return stripped.split("/")[0].toLowerCase()
}

/**
 * Fetch site metrics for a domain from the Moz unified API.
 *
 * Returns null on auth / network / API errors.
 */
export async function fetchMozMetrics(
  domain: string,
  apiKey: string,
): Promise<MozDomainMetrics | null> {
  const target = normaliseDomain(domain)

  let res: Response
  try {
    res = await fetch(MOZ_JSONRPC, {
      method: "POST",
      headers: {
        "x-moz-token": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "data.site.metrics.fetch",
        params: {
          data: {
            site_query: {
              query: `https://${target}`,
              scope: "domain",
            },
          },
        },
      }),
      cache: "no-store",
    })
  } catch (err) {
    console.error("[moz] Network error:", err)
    return null
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.warn(`[moz] HTTP error ${res.status}: ${body}`)
    return null
  }

  interface SiteMetrics {
    domain_authority?: number
    page_authority?: number
    root_domains_to_root_domain?: number
    external_equity_links?: number
    spam_score?: number
  }

  const envelope = await res.json() as {
    error?: { code: number; message: string }
    result?: {
      site_metrics?: SiteMetrics
      results?: Array<{ site_metrics?: SiteMetrics }>
    } & SiteMetrics
  }

  if (envelope.error) {
    console.warn("[moz] JSON-RPC error:", envelope.error)
    return null
  }

  if (!envelope.result) return null

  // The unified API returns metrics under result.site_metrics.
  const r: SiteMetrics =
    envelope.result.site_metrics ??
    envelope.result.results?.[0]?.site_metrics ??
    envelope.result

  return {
    domainAuthority: r.domain_authority ?? null,
    pageAuthority:   r.page_authority   ?? null,
    backlinks:       r.external_equity_links ?? null,
    rootDomains:     r.root_domains_to_root_domain ?? null,
    spamScore:       r.spam_score       ?? null,
  }
}
