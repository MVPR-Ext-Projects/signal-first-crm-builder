# Signal-first CRM

A B2B outbound CRM built around signals: every prospect interaction (LinkedIn follow, post like, email open, meeting booked) becomes a scored signal that drives the funnel. PR-shaped — the default flow assumes you're targeting humans who publish, comment, and follow, and you want to react to their behaviour with personalised reach-out.

**The approach: earned media as a top-of-funnel signal.** Most outbound tools start from firmographics. This one starts from trust - react to whoever engages with your high-trust earned coverage. That's the "trust-nested" funnel: promote coverage via LinkedIn, measure the engagement back as signals, work the named humans who engaged. The approach is PR-source-agnostic - any agency's coverage can feed it; with a manual agency relationship it just works the same way, only harder to track and slower to scale. What [MVPR](https://mvpr.io) adds is a REST API for your coverage, the journalist outreach threads behind it, and PR-performance data (response/coverage rates, which pitches land) - so feeding the loop and tracking it is automatic instead of manual. (That API is MVPR's edge over other agencies, not a requirement of the signal-first approach.) Optional to run: `crmProvider: "none"` and no MVPR key both work. See [docs/PR-LinkedIn-Measurement.md](./docs/PR-LinkedIn-Measurement.md).

This is a template forked from gtm-os, ready to be scaffolded into your own deployment. Seeded with an example workspace ("Acme Demo") shaped as a B2B platform-observability company so you can see what a populated workspace looks like before replacing it with your own data.

## Quick start

If you received this as a **zip drop**: start with [SCAFFOLD.md](./SCAFFOLD.md) — the end-to-end walkthrough from unzip → live dashboard (~45-60 minutes).

If you cloned the repo from GitHub: [SETUP.md](./SETUP.md) covers the same ground in slightly more reference-style detail. Either works.

The short version:

```bash
npm install
vercel link && vercel env pull .env.local
# Set ENCRYPTION_KEY, CRON_SECRET, ANTHROPIC_API_KEY in .env.local
node scripts/init-db.mjs
node scripts/seed-workspaces.mjs
npm run dev --workspace=apps/web
```

## What's in this repo

- `apps/web/` - the CRM (Next.js, deployed on Vercel). Includes the MVPR PR integration: `lib/mvpr.ts` (REST adapter), the coverage/threads sync cron, and the PR-performance tracking surface
- `apps/attribution/` - website-attribution tracker (optional, separate deploy)
- `packages/crm-adapters/` - optional CRM write adapters (HubSpot or Attio); Postgres is the system of record, so `crmProvider: "none"` runs with no CRM at all. See [docs/CRM-ADAPTERS.md](./docs/CRM-ADAPTERS.md)
- `packages/blueprint-schema/` - types describing the workspace configuration shape
- `scripts/` - recovery, inspection, migrations
- `seed/example-workspace.json` - example seed ("Acme Demo", a B2B platform-observability shape) to scaffold from + replace with your own

## Knowledge map

**[MAP.md](./MAP.md)** is the visual entry point: a Mermaid diagram of the whole system with every node clickable into the relevant deep-dive doc. Plus a "Lifecycle of a signal" prose walkthrough for readers who prefer narrative. A standalone **[MAP.html](./MAP.html)** renders the same diagram in any browser (no Mermaid plugin needed). Start there if you want the bird's-eye view.

## How to think about this codebase

Read in this order for full context:

1. [PHILOSOPHY.md](./PHILOSOPHY.md) - the *why*. Design tenets, what would break the design, the load-bearing decisions.
2. [GLOSSARY.md](./GLOSSARY.md) - canonical product terms. When a word is ambiguous, this file resolves it.
3. [ARCHITECTURE.md](./ARCHITECTURE.md) - the *how* at a system level. Storage layers, end-to-end lifecycle of a signal, where customisation goes.
4. [CLAUDE.md](./CLAUDE.md) - the operating manual. Read every session.
5. [docs/adr/](./docs/adr/) - non-obvious decisions, one ADR per choice. Read the relevant one before refactoring in that area.
6. [docs/WEBHOOKS.md](./docs/WEBHOOKS.md) - per-provider cookbook (auth model, idempotency key, verbs written, CRM-push decision).
7. [docs/CAMPAIGNS.md](./docs/CAMPAIGNS.md) - what a campaign is, what adding a contact to one does, how delivery flows from draft to send to outreach_log.
8. [docs/CONTACTS.md](./docs/CONTACTS.md) - how people get into the system (the five paths, dedup behaviour, the design choice that there's no manual "Add contact" button).
9. [docs/PR-LinkedIn-Measurement.md](./docs/PR-LinkedIn-Measurement.md) - the PR + LinkedIn + Teamfluence closed loop: how high-trust earned coverage gets trust-nested inside paid LinkedIn distribution, then measured back into the signal-first funnel.

Together these are the "knowledge base" the system constantly references. `CLAUDE.md` auto-loads into every Claude Code session, and it points back to the others as needed.

## Daily-driver slash commands

Try `/add-signal-verb`, `/audit-personas`, `/review-fingerprint`, `/add-webhook`, `/migrate-schema`. Defined in [.claude/commands/](./.claude/commands/).

## Guardrail sub-agents

Spawn them after edits in their area:
- `multi-tenancy-reviewer` - checks new code scopes by `workspace_id`
- `persona-coverage-auditor` - flags persona overlaps + gaps
- `signal-verb-consistency-checker` - confirms verbs are in all three places
- `fingerprint-scope-checker` - catches the "only-fetch-channel_persona" bug

Defined in [.claude/agents/](./.claude/agents/).

## Customizing

This template assumes you'll edit personas, signal verbs, ICP rules, and dashboard chrome to match your business. The architecture (multi-tenant workspaces, signal scoring, style fingerprints) is meant to stay.

For first customizations, open the repo in Claude Code and start with prompts like:
- "Rewrite the four example personas for our buyers in [industry]."
- "Add a new signal verb for [event]."
- "Wire up a webhook for [marketing automation tool]."

## Hosting

This is a **self-hosted** template - there is no managed version. You deploy it to your own infrastructure. It is built for Vercel (`vercel link`, then `vercel deploy`), with Neon Postgres and Upstash Redis as the data stores and the env vars in [.env.example](./.env.example). Set `GTMOS_URL` (and, if you run the attribution app, its host) to your own deployment URL - nothing points anywhere by default.

## License

Open source under the **[Apache License 2.0](./LICENSE)** - use it, modify it, self-host it, build a business on it, no permission needed. If you redistribute a modified version, keep the LICENSE and note your changes (per the Apache terms). Questions: support@mvpr.io.

## Built by MVPR

This template is the open companion to MVPR's work on **Signal-First GTM** - a go-to-market approach built around buyer signals and earned trust.

- Signal-First GTM, the idea: https://mvpr.io/signal-first-gtm
- Trust-Nested Selling, the whitepaper: https://mvpr.io/special-projects/trust-nested-selling
- MVPR: https://mvpr.io

If you build something with this, a link back to https://mvpr.io is appreciated (never required).
