---
name: talent-finder
description: Finds candidates for a role from the recruiter's own pool and shortlists the best fits. Takes a structured role spec (must-haves, years floor, location, comp band, dealbreakers), matches local CVs plus manually pasted public profiles, and returns a ranked top-10 with fit lines and gaps. Shortlist only — no auto-outreach, no bulk messaging. Use when the user says "find candidates", "shortlist for this role", "who fits this JD", or pastes a job spec to staff.
---

# Talent finder — spec, match, shortlist

Turn a job spec into a ranked shortlist from candidates you already hold plus public profiles you paste in. **The role spec drives everything**; the store is the memory. Shortlist only — outreach happens outside this skill with the candidate's consent.

- Store: `node <this-skill-dir>/scripts/talent.mjs <command>` — data lives in `~/.talent-search/` (never in the repo). Full reference: `reference/spec.md`, `reference/sourcing.md`, or `talent.mjs help`.
- Privacy: candidate PII stays in the store. Never paste emails/phones into search queries or third-party services. Public profiles are pasted by you — this skill never scrapes at scale.

## Step 0 — Intake the role (spec gate)

1. `talent.mjs role add --title "…" --client "…" --location "Hyderabad" --min-years 10 --must "Java;Spring Boot;Angular 16+" --nice "fintech;Kubernetes" --notes "…"` (flags in `reference/spec.md`).
2. **No spec → no sourcing.** If the user pastes a raw JD, extract must-haves, years floor, location/mode, comp band, and dealbreakers first, confirm back in 5 lines, then `role add`. Never invent a floor or location.
3. Flag ` --no-unsolicited` when the posting rejects agency resumes (common on Workday posts) — the report then says "requested-channel only, do not blast-submit."

## Step 1 — Build the pool (hybrid, consent-first)

1. Private pool: `talent.mjs ingest <cv-folder>` — one file per candidate (`.md`/`.txt`; filename or first `#` heading is the name). Nothing leaves the machine.
2. Public: `talent.mjs candidate add --name "…" --linkedin "<url>" --location "…" --years 11 --stack "Java;Angular" --notes "ex-Lead @ X"` — paste only what you verified on the live profile. No bulk import, no guessed emails.
3. Dedupe is automatic: email → LinkedIn URL → normalized name. `ALREADY SEEN` (exit 1) means the candidate is already tracked — use the id.

## Step 2 — Match

`talent.mjs match <roleId> [--limit 10]` — scores every eligible candidate, prints ranked table plus skip lines (`below years floor — skipped: N`, `already placed — skipped: N`, `insufficient evidence — flagged`). Labels: `fit` / `partial fit (<gap>)` / `stretch (<gap>)` / `knockout risk (<reason>)`. Saves the report under `reports/` with a `-2` suffix — never overwrites.

Scoring is transparent and textual (see `reference/spec.md`): must-have hits > years floor > lead evidence > location > nice-haves. No black box.

## Step 3 — Deliver the shortlist

10 max. Columns: **Candidate** (name + link you pasted) · **Years/Location** · **Verdict** (fit/partial/stretch) · **Why** (one line, gaps named). Then the screening checklist for the top 3: must-have recency, lead scope, location, comp expectations, consent to represent. Never submit anyone without written consent.

## Step 4 — Track reactions

- Advance: `talent.mjs note <id> "screening: …"` · statuses via `talent.mjs status <id> <status>` (`new → shortlisted → contacted → screening → submitted → placed`; terminal `rejected`/`withdrew`/`not_interested`/`duplicate`).
- Only `new`/`shortlisted` surface in future matches — everything else is skipped with a count line.

## Rules

- Never invent candidate facts; unverified = flagged, not assumed.
- Never expose PII in reports beyond name + link you provided.
- Never auto-contact anyone; never submit past a knockout or a `no-unsolicited` flag.
- The store is the only source of truth for who was shortlisted or placed.
