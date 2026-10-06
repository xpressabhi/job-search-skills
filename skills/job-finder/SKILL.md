---
name: job-finder
description: Finds jobs for the user and remembers every role it has shown. Runs a guided first-time setup (profile + CV) on first use, sweeps the user's target companies and job boards, filters by their real eligibility (remote regions, timezones, comp floor, exclusions), and tracks every role locally through the whole pipeline (shown/interested/applied/interview/offer/rejected). Use when the user says "find me jobs", "job search", "find remote jobs", "any new jobs", "jobs in <city>", "who's hiring", "set up my job search", or asks for job listings, salary ranges, or companies hiring. Pairs with the apply-to-jobs skill.
---

# Job finder — search, verify, rank, remember

Find roles the user can actually get, rank them by real fit, and keep a persistent local memory so
nothing is ever surfaced twice. **The profile drives everything** (targets, locations, modes, comp
floor, exclusions); the tracker is the memory.

- Tracker: `node <this-skill-dir>/scripts/tracker.mjs <command>` — data lives in `~/.job-search/`
  (never in the repo). Full command reference: `reference/data-model.md` or `tracker.mjs help`.
- Judgments: `node <this-skill-dir>/scripts/jev.mjs <command>` — Jev (TypeSafe System One)
  for every semantic decision (eligibility, fit/rank, liveness, red flags, duplicates).
  Needs `TYPESAFE_API_KEY`; without it, judge manually and say so. Details: `reference/jev.md`.
- Browser decisions: the apply skill's `chrome.mjs decide` + `do` drive page actions through
  the Jev browser-decision loop — never guess a control from coordinates.
- Browser sweeps: `scripts/linkedin-sweep.mjs` (signed-in LinkedIn Jobs discovery + original-
  posting resolution), `scripts/naukri-sweep.mjs` (Naukri, India), and `scripts/warm-path.mjs`
  (1st/2nd-degree referral check). All drive the apply skill's `chrome.mjs` against the dedicated
  signed-in profile; run `linkedin-sweep.mjs check` first — a login wall means the user signs in
  once in the visible Chrome window.
- Quality gate: `scripts/crosscheck.mjs --profile P --roles R.json` — the mandatory Jev
  cross-check (rank + fit + requirements + redflags) every role passes before it is presented.
  Only PRESENT roles are reported; everything else is dropped (user MUST, 2026-10-05).
- Deep references, load on demand: `reference/companies.md` (starter company universe),
  `reference/search-playbook.md` (techniques, boards, verification, red flags).

## Step 0 — Load the profile (onboarding gate)

1. `tracker.mjs profile show` (or `profile get <dot.path>`); `tracker.mjs profile path` exits 1 when
   there is no profile yet.
2. **No profile → run `reference/onboarding.md` first**, then come back. Onboarding is CV-first: it
   asks for the CV (path or URL), extracts what it can, confirms with the user, and only then asks the
   remaining questions. Do not search with a blank profile; do not invent personal facts.
3. Read the CV: prefer `cv.text_path`, else `cv.stored_path`, else `cv.path`. The CV is canonical for
   skills/level — if the profile and CV disagree, trust the CV and offer to update the profile.
4. Read `reference/companies.md` (starter sweep order), `tracker.mjs company list` (learned sweep
   targets, cached company screens, ignored companies), and `reference/search-playbook.md` (how).

## Step 1 — Clarify (only if the request diverges)

"Find me jobs" needs no questions — go. If the request adds constraints ("only remote", "in Berlin",
"part-time"), honor them for this run; if it sounds like a lasting preference, update the profile
(`tracker.mjs profile set …`) and say so. Not sure which? Ask once — "just this run, or from now
on?" — then honor the answer and keep the profile current from then on.

## Step 2 — Search

Default pool = `reference/companies.md` in table order, plus learned companies (`tracker.mjs company
list`); use `reference/search-playbook.md` §2–§7 for sweep technique (ATS JSON endpoints first —
`reference/ats-apis.md`), boards, X, query patterns, and the user's company lists. Ignored companies
are never fetched.

**Sweep channels — run all four every sweep** (unless the user narrows the ask):
1. **ATS boards** — the default pool via JSON endpoints.
2. **LinkedIn Jobs** (signed-in): `node scripts/linkedin-sweep.mjs run`, then
   `node scripts/linkedin-sweep.mjs resolve --in <file> --limit N` so every role kept points at the
   employer's own posting; report a LinkedIn URL only for Easy-Apply-only listings (flag it).
3. **Naukri** (India): `node scripts/naukri-sweep.mjs run` (date-sorted) — cards are discovery;
   cross-check the employer's own portal for shortlisted roles.
4. **Fresh supplements** — HN "Who is hiring?" (current month), remote boards, X, company lists
   (playbook §3–§7) when the primary channels yield too few or the user asks wider.

**Company pre-screen — before any board fetch.** One `company-screen` call per company replaces a
board fetch, parse, and per-role calls for companies that cannot yield eligible roles at all. For
every company not already screened (cached screens show in `company list`; re-screen entries older
than 30 days):

    jev.mjs company-screen --profile <profile.json> --company "<name>" [--context <snippet>]

`skip` → do not fetch its board; record the verdict with
`tracker.mjs company screen "<name>" --verdict skip --reason "…"`. `maybe` → thin information; fetch
anyway but expect noise. `sweep` → fetch. Pass `--context` (locations, what the company does, comp
signals) whenever the company is not widely known — without it unknown companies route to `maybe`.
Screens are advisory and dated, never a substitute for the per-role filters below.

**Listing triage — before fetching full postings.** Triage a board's listing rows (title, location,
mode, snippet) so only plausible roles cost a posting fetch and a rank call:

    jev.mjs triage --profile <profile.json> --listings <listings.json>

`skip` → don't fetch the posting (explicit location/track/level mismatch; the onsite gate fires
deterministically and costs nothing). `maybe` → fetch, flagged. `fetch` → fetch. Only explicit
mismatches skip — a thin listing never hides a role.

Every candidate passes, in order (free filters before paid judgments — deterministic
drops never spend a Jev call):

1. **Never re-surface gate:** `tracker.mjs seen <url> <company> <title> --mode … --location … --salary … --posted … --source …`
   - `NEW` (exit 0) → first time; keep going.
   - `ALREADY SEEN` (exit 1) → drop it; count it into a "previously surfaced — skipped: N" line.
     Roles the tracker marks `applied`/pipeline/`not_interested` are never reported again.
   - Cross-source copy (LinkedIn vs company ATS, title reworded) → `jev.mjs same-role
     --a <role-a.json> --b <role-b.json>`; `same:true` counts as the same application.
   - **Run it sequentially** (or bulk-load with `add-batch`, one process): the tracker
      load→save's the whole file per call, so concurrent `seen` processes race and the last
      writer silently discards the others' inserts (cost 64 inserts in the 2026-09-22 sweep).
      Statuses are never corrupted — only newly-inserted rows are lost — and `add-batch`
      restores them atomically.
2. **Exclusions** — ignored companies (`tracker.mjs company list`) are never fetched or surfaced;
   profile `search.company_rules` (product-only, excluded types/companies) and relocation per
   playbook §9–§10. The `seen` check also warns on stderr if a role sneaks in from an ignored company.
2.5 **Ghost & freshness screen (deterministic, free)** — user rule 2026-10-06: filter ghost jobs,
   prefer newly posted. Drop before any fetch/rank call when:
   - the posting's own publish date is **older than 45 days** (`--max-age` to override); or
   - the text reads evergreen/talent-pool ("always hiring", "talent pool", "general application",
     "future opportunities", "rolling basis", "keep your CV on file").
   Count drops into a "ghost/stale — skipped: N" line. Every candidate records `--posted
   YYYY-MM-DD`; when the source hides it, fetch the page and read the date; still unknown → flag
   `date: unknown` and rank below dated peers. `rank`/`triage`/`crosscheck` enforce this in code
   (fresher = +0.03 ≤ 7 days, −0.03 > 30 days, labels unchanged).
3. **Liveness** — `jev.mjs liveness --page <fetched-text> --role <role.json>`; `dead`/
   `suspicious` → drop and count into a "dead/expired — skipped: N" line; `unverified` →
   keep but flag `unverified` (playbook §9a). Anti-bot blocked → retry once, then keep
   but flag `unverified`.
4. **Eligibility** — `jev.mjs eligibility --profile <profile.json> --posting <posting.json>`
   (remote region + timezone + payroll + auth + relocation, playbook §9). `ineligible` =
   skip; `unverified` = keep, ranked below `eligible`.
5. **Comp floor & estimation** from the profile — below floor = skip (numeric check in code, never
   Jev). When the posting publishes pay, `jev.mjs salary-parse --posting <posting.json>` extracts the
   base band for that check and the report's Salary column. When pay is unpublished, run
   `scripts/payest.mjs estimate --role <role.json>` — the evidence ladder: published → **observed**
   bands for the company (`~/.job-search/comp-bands.json`) → vetted floor → unknown. Comp-gated
   screens (relocation, down-level surfacing) may pass on **observed** evidence, disclosed as
   `comp est ₹X–Y — verify with recruiter`; `unknown` keeps the conservative default (never assume
   pay). Grow the store whenever real pay is seen (posting, recruiter call, offer):
   `payest.mjs set "<company>" --min L --max L --source "<evidence>"`; `payest.mjs import` refreshes
   from job-radar's observed evidence and vetted floors.
6. **Level + stack match (strict by default)** — `jev.mjs rank` over the whole shortlist
   (§3). Level mismatch (below or above the candidate band) and missing named requirements
   (`requirement_coverage` < 1.5) drop the role — when level doesn't match, comp and
   interviews don't either. Only roles that pass the mandatory `scripts/crosscheck.mjs` gate
   (§3) reach the report; `partial`/`weak` roles are dropped and counted in the skip lines,
   never presented — not even as a footer "possible" (user MUST, 2026-10-05). Widening a run
   requires the user to ask for it explicitly.

Record the posting's own publish date as `--posted YYYY-MM-DD` (empty if not shown) and the exact
canonical ATS URL — both are reused verbatim in the report. Order the final list freshest first:
fresh (≤ `search.freshness_days`) roles above stale-flagged ones at equal fit.

New strong sources get remembered: after the sweep, `tracker.mjs company add "<Company>" <portal>
[--ats X]` for any company that yielded several good roles or that the user wants watched — future
runs sweep it automatically.

## Step 3 — Score and rank · cross-check gate

`jev.mjs rank --profile <profile.json> --roles <shortlist.json>` scores eligibility + fit
in one fan-out call per role and returns verdict-then-composite order (playbook §11:
eligibility confirmed > published salary > CV-fit > company quality > timezone/commute
fit — salary/company-currency math stays in code). **Level and stack must match:**
below/above-level roles and roles missing named requirements are dropped, not softened.
Only `interested` roles are ever re-shown, so the report is the user's one shot at each
role — rank honestly.

### The Jev cross-check gate — mandatory before any role is presented

    node scripts/crosscheck.mjs --profile <profile.json> --roles <shortlist.json> [--max-gaps 1] [--max-age 45] [--strict] [--out F]

Composes the full evidence per role — ghost/freshness (deterministic first), rank
(eligibility + fit, profile), fit (CV), requirements (must-have gaps), redflags (survivors)
— into a hard **PRESENT / DROP** verdict.
PRESENT requires all of: not a ghost (posted ≤ `--max-age` days — default 45 — and no
evergreen/talent-pool language); rank not `ineligible`; rank **or** fit reaches `good`/`strong`
(`--strict`: both); must-have gaps ≤ `--max-gaps` (default 1, each one disclosed on the row);
no red-flag hits. Fail-closed: a Jev error drops the role. Exit 0 when at least one role
presents, 1 otherwise.

Only PRESENT roles reach the report; DROP roles are counted in the skip lines with their
reason — never presented, never padded in as "possible" (user MUST, 2026-10-05). An empty
result is a valid answer: report "no high-quality matches this sweep" and show coverage.
Name every gap the gate surfaced (`jev.mjs requirements` gap text) on the role's row.

## Step 4 — Deliver a ranked report

Only cross-check PRESENT roles, 10–15 max, mixed modes when the profile allows — freshest
first (fresh ≤ `search.freshness_days` above stale-flagged, equal fit). Columns:

**Role & Company** (link — ALWAYS the live posting on the company's own portal/ATS; aggregators are
discovery-only) · **Salary** (published, else `estimate: …`) · **Mode** (remote / hybrid X days /
on-site <city>) · **Level/Stack** · **Eligibility** (confirmed / likely / unverified) ·
**Timezone/Commute** · **Why it stands out** (one line; include stale/stretch flags and any
rank-vs-fit disagreements here).

If the gate presented nothing: say so plainly — "no high-quality matches this sweep" — with the
skip/coverage lines. Never fill a report with below-bar roles.

Referral-first is the profile's channel rule: for the roles that reach the report, run
`node scripts/warm-path.mjs "<company>"` (or `--batch` for several companies) and give each role a
**Warm path** note — 1st-degree names, 2nd-degree count. Roles with a warm path lead the "next
moves"; a 0-path role at a low-yield company is flagged, not sold as a cold-apply opportunity.

Add skip lines where relevant: "previously surfaced — skipped: N", "already applied — skipped: N",
"dead/expired — skipped: N", "ghost/stale — skipped: N", and one coverage line — "swept N companies
— M had no matching roles" — so the user can see the sweep really happened. After the report, offer:
tailor the CV for a role, draft outreach to the top 3, or apply now (hand off to the **apply-to-jobs** skill).

## Step 5 — Update statuses from the user's reaction

- Picked a role → `tracker.mjs mark interested <id>` (only `interested` roles may be re-shown).
- Declined → `mark not_interested <id>` · expired posting → `mark expired <id>`.
- Rejected → always capture the reason — it tunes future ranking. Paste the rejection email or status
  text into `jev.mjs rejection-reason --text <text>`; it returns `reason`
  (`location|comp|level|stack|domain|track|sponsorship|unknown`) plus confidence, then record it:
  `mark rejected <id> --reason <reason>`. A generic "we moved forward with other candidates" is
  `unknown`; never invent a cause.
  `tracker.mjs stats` shows the breakdown plus low-yield companies (3+ applied, none advanced).
- **Repeat declines → offer the ignore list.** After updating statuses, run
  `tracker.mjs company candidates --min 2`; if a company shows up, offer: "You've passed on N
  <Company> roles — ignore them entirely?" On yes:
  `tracker.mjs company ignore "<Company>" --reason "declined N roles"` (never swept or surfaced
  again; its open roles are marked `not_interested`, open apply rows aborted).
- **User names a company to watch** ("keep an eye on Anthropic", "check Acme weekly") →
  `tracker.mjs company add "<Company>" <portal> [--ats X]`.
- **"Never show <Company> again"** → `tracker.mjs company ignore "<Company>"` on the spot.
- Ready to apply → the apply skill drives the queue; `tracker.mjs queue add <id>` is how it starts.
- Notes: `tracker.mjs note <id> "<text>"` — anything learned (recruiter, referral, timeline).

`applications.md` in the data home regenerates automatically on every write — tell the user it exists
when they want a human-readable view (`tracker.mjs export` to rewrite it).

## Universe hygiene (offer monthly, or when a board 404s)

- `tracker.mjs company verify` — health-check starter + learned portals (`--stale 90` re-checks only
  entries not verified in 3+ months; `--dry-run` lists targets without fetching). `blocked` is
  expected on known bot-blockers (use a browser); `dead`/`moved` need action; dead exits 1.
- Fixes go through the learned list, never the installed skill files: `company add "<name>" <new
  portal>` for a moved board; `company ignore "<name>"` when a company is gone for good.
- Learned companies that stay dead or never yield across runs → offer to ignore them.
- Grow coverage deliberately: add 2–5 verified companies per review via `company add` (frontier AI
  and remote-first first).

## Statuses

`shown → interested → applied → oa → phone → onsite → offer → accepted`
Terminal: `rejected` · `withdrew` · `not_interested` · `expired`

## Rules

- The tracker is the only source of truth for what was shown/applied — never report a role whose
  dedupe check says `ALREADY SEEN` (unless its status is exactly `interested`).
- Never invent facts about the user; never stretch the CV; never hide a red flag to fill the report.
- Search by derived terms only (titles, skills, cities, sectors) — never paste CV text, name, email,
  phone, or URLs containing them into search queries or third-party services.
- Keep personal data out of the repo: it belongs in `~/.job-search/` only.
