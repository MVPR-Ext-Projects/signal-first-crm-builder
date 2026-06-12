/**
 * Personal-email provider blocklist.
 *
 * Per Principle 3 of the dedup master plan: personal emails (gmail, yahoo,
 * outlook, etc.) are excluded from BOTH (a) dedup match keys, and (b)
 * outbound campaign targeting. We sell to corporate emails, not to people's
 * personal inboxes — even when matching on personal emails would technically
 * work.
 *
 * Personal emails ARE still stored on the contact record (useful as outreach
 * context); they're just not used as a dedup key and not used as an outbound
 * target.
 */

import { emailDomain } from "@/lib/normalize/domain"

// Initial set — extend as new providers come up. All entries lowercase,
// no leading dot, no www.
const PERSONAL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com", "googlemail.com",
  // Microsoft
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "outlook.co.uk", "hotmail.co.uk", "live.co.uk",
  // Yahoo
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es",
  "yahoo.it", "yahoo.ca", "yahoo.com.au", "yahoo.com.br",
  "ymail.com", "rocketmail.com",
  // Apple
  "icloud.com", "me.com", "mac.com",
  // AOL
  "aol.com", "aol.co.uk",
  // Proton
  "proton.me", "protonmail.com", "pm.me",
  // GMX
  "gmx.com", "gmx.net", "gmx.de", "gmx.co.uk",
  // Russia / CIS
  "mail.ru", "yandex.ru", "yandex.com", "rambler.ru",
  // China
  "qq.com", "163.com", "126.com", "sina.com", "sina.cn", "sohu.com",
  // Other consumer providers
  "fastmail.com", "fastmail.fm", "tutanota.com", "tutamail.com",
  "zoho.com", "hey.com",
  "gmx.fr", "gmx.es", "freenet.de", "web.de", "t-online.de",
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net",
  "mail.com", "email.com", "inbox.com",
])

/**
 * True if the email's domain is in the personal-provider blocklist.
 * Returns false for missing/malformed emails (caller decides what that means).
 */
export function isPersonalEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  return PERSONAL_DOMAINS.has(domain)
}

/**
 * True if the email is suitable as a corporate-email match key — i.e. it's
 * present and not a personal-provider domain.
 */
export function isCorporateEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return !isPersonalEmail(email)
}
