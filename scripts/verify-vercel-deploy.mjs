/**
 * Verify a Vercel deployment is actually serving the expected content.
 *
 * Run this after any settings change, redeploy, or first deploy of a
 * new project. The point is to catch the failure mode where Vercel
 * marks a deploy "● Ready" but the served content is wrong (e.g. our
 * 2026-05-19 incident, where mvpr-website's "Ready" deploy was the
 * CRM build, not the Astro site).
 *
 * What it does:
 *   1. Curl the given URL with a cache-bust query string
 *   2. Assert the response status is 2xx
 *   3. Grep the body for each --expect marker (must all be present)
 *   4. Grep the body for each --not-expect marker (must NOT be present)
 *
 * Exits 0 on all assertions pass, non-zero (with a clear log) on any fail.
 *
 * Usage:
 *   node scripts/verify-vercel-deploy.mjs \
 *     --url https://project-p7km4.vercel.app/ \
 *     --expect "<title>MVPR - PR for the AI era" \
 *     --expect "How MVPR works for you" \
 *     --expect "fragment-card" \
 *     --not-expect "Signal-First CRM Builder" \
 *     --not-expect "Page couldn't load"
 *
 * Can be wired into a deploy-verification CI step or run manually.
 */

const args = process.argv.slice(2)

const opts = { url: null, expect: [], notExpect: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--url") opts.url = args[++i]
  else if (a === "--expect") opts.expect.push(args[++i])
  else if (a === "--not-expect") opts.notExpect.push(args[++i])
  else if (a === "--help" || a === "-h") {
    console.log("Usage: node scripts/verify-vercel-deploy.mjs --url <url> [--expect <str>...] [--not-expect <str>...]")
    process.exit(0)
  }
}

if (!opts.url) {
  console.error("✗ --url is required")
  process.exit(2)
}
if (opts.expect.length === 0 && opts.notExpect.length === 0) {
  console.error("✗ at least one --expect or --not-expect must be given")
  process.exit(2)
}

const bustedUrl = `${opts.url}${opts.url.includes("?") ? "&" : "?"}__verify_nocache=${Date.now()}`

let res
try {
  res = await fetch(bustedUrl, { cache: "no-store", redirect: "follow" })
} catch (err) {
  console.error(`✗ fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const status = res.status
const body = await res.text()
const finalUrl = res.url

console.log(`URL:        ${opts.url}`)
console.log(`Final URL:  ${finalUrl}`)
console.log(`Status:     ${status}`)
console.log(`Body size:  ${body.length} bytes`)
console.log()

let allOk = true

if (status < 200 || status >= 300) {
  console.log(`✗ Status ${status} is not 2xx`)
  allOk = false
} else {
  console.log(`✓ Status ${status}`)
}

for (const marker of opts.expect) {
  if (body.includes(marker)) {
    console.log(`✓ Contains: ${JSON.stringify(marker)}`)
  } else {
    console.log(`✗ Missing:  ${JSON.stringify(marker)}`)
    allOk = false
  }
}

for (const marker of opts.notExpect) {
  if (body.includes(marker)) {
    console.log(`✗ Should not contain: ${JSON.stringify(marker)}`)
    allOk = false
  } else {
    console.log(`✓ Absent (good):      ${JSON.stringify(marker)}`)
  }
}

console.log()
if (allOk) {
  console.log("✓ All assertions passed.")
  process.exit(0)
} else {
  console.log("✗ One or more assertions failed.")
  process.exit(1)
}
