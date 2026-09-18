---
name: apply-to-jobs
description: Applies to jobs from the user's job-finder tracker by autofilling and submitting ATS application forms in their own visible Chrome — no external apply service. Detects the ATS portal (Ashby/Greenhouse/Lever/Workable/iCIMS/Workday/SmartRecruiters/Microsoft/LinkedIn incl. Easy Apply/generic), follows that portal's reference, fills strictly from the user's profile + stored answers + live CV, auto-submits clean forms, checks pages + tracker for prior applications, and pauses for the user (HITL) only on captcha/consent/login/knockout blockers. Supports single roles and batch ("apply to all interested"). Use when the user says "apply", "apply to this job", "autofill", "submit application", or "apply to all interested".
---

# Apply to a job (self-owned autofill + submit)

Apply to roles already tracked by the **job-finder** skill, using the user's own visible Chrome.
**Auto-submit clean forms**; pause (`awaiting_user`) only when a human is required (captcha, consent
wall, forced login, knockout mismatch). Never invent facts; never submit past a knockout mismatch.

**Prerequisite:** `job-finder` from the same repo must be installed — it owns the tracker and the
profile. If it's missing, tell the user to install it, then stop.

Paths (resolve relative to this skill's own directory):

- Tracker: `../job-finder/scripts/tracker.mjs` (override with `$JOB_SEARCH_TRACKER`)
- Judgments: `../job-finder/scripts/jev.mjs` — Jev for knockout, QA-match, applied-guard,
  and submit verification (needs `TYPESAFE_API_KEY`; without it, judge manually).
  Full reference: `../job-finder/reference/jev.md`.
- Browser helper: `scripts/chrome.mjs` (see `portals/_common.md` for the command set) — its
  `decide` subcommand drives the Jev browser-decision loop (snapshot → Jev picks → `do`).
- Portal references: `portals/_common.md` (always read first) + `portals/<portal>.md`

## Step 0 — Resolve the target(s)

Load the profile first: `tracker.mjs profile show`. If there is no profile, send the user through the
job-finder onboarding (`job-finder/reference/onboarding.md`) — do not apply with invented data.

- **Single role** — user names a company/title/URL/id: `tracker.mjs role "<query>"`. Ambiguous or
  missing → show `tracker.mjs list` matches and ask. Then create the queue row: `tracker.mjs queue add <id>`.
- **Batch** — "apply to all interested": `tracker.mjs queue fill --status interested [--limit N]`,
  then `tracker.mjs queue list --status queued`.

Fetch the work item: `tracker.mjs queue get <queueId>` → queue row + full role (url, company, title).

## Step 1 — Open the posting, detect the portal, load its reference

1. `node scripts/chrome.mjs launch` (once per session), then `open <url>` — one tab per job in batch.
2. Detect the portal from the URL: `ashbyhq`→ashby · `greenhouse.io`→greenhouse · `lever.co`→lever ·
   `workable.com`→workable · `icims.com`→icims · `myworkdayjobs`→workday · `smartrecruiters`→smartrecruiters ·
   `apply.careers.microsoft.com`→microsoft · `linkedin.com/jobs`→linkedin · else generic.
3. Read `portals/_common.md`, then `portals/<portal>.md` — follow it exactly.
4. Verify the visible H1/title/company matches the tracker role. Mismatch (redirect/expired) →
   `awaiting_user "posting mismatch (expected … got …)"` and stop. Accept consent/GDPR walls.

## Step 2 — Duplicate guard + knock-out pre-scan

Duplicate guard first (`_common.md` § Duplicate guard): `jev.mjs applied-guard --page <text>`
or a visible "Applied" banner, or the tracker already shows `applied`/pipeline → skip,
never re-apply — the same role reached via LinkedIn and the company ATS is one
application (`jev.mjs same-role` decides ties).

Cross-check with `jev.mjs knockout --profile <profile.json> --posting <role.json>
[--form <form-text>]`: years, degree, work authorization, location, salary.
**If `knockout:true` (any hit ≥ 0.7): do NOT fill/submit** → `awaiting_user "knockout:
<hit>"` and stop. Uncertain hits → surface to the user, never auto-submit past them.
Fill salary only when the range covers the profile band; else blank + flag.

## Step 3 — Fill

Fill everything through the browser helper (locators → fill → re-read to verify). Follow the portal
ref's quirks. Resume comes from `cv.stored_path || cv.path` — upload it, then re-verify the fields the
portal autofills from it.

**Guided loop (required for form steps):** do not pick controls by guessing. Each cycle:

    node <browser> decide --goal "complete and submit the application for <title> at <company>: <remaining asks>"
    node <browser> do <index> <click|fill|select> [value]

`decide` snapshots the page, builds the observed action space, and has Jev pick `operation` +
`target` (the snapshot index). Execute the exact target with `do`; re-`decide` after every page
change. `TYPE_TEXT` values come from the profile / answer bank — never invented. `operation: DONE`
requires visible evidence; `BLOCKED` → `awaiting_user` with what is missing. Three no-change
non-wait actions in a row → stop as blocked. Details: `portals/_common.md` § Deciding what to click
(jev-browser loop). Raw `snap`/`click`/`fill` remain the fallback when the helper or Jev is down.

### Answer bank — check before you ever block or guess

For any question not answerable from the profile or CV, check the stored answers first:

    node <tracker> qa get "<question text>"
    node <jev> qa-match --question "<question>" --answers <answers.json>

- `qa-match` (Choice over the answer bank, `match_index:-1` below 0.5 confidence) beats
  loose string matching — use it when several stored answers could fit (notice period,
  sponsorship, "why this role", "how did you hear", etc.).
- A hit → fill it (also for equivalent questions on other portals).
- No hit and the field is required → `queue set <queueId> awaiting_user "QA: <exact question>"` (one
  question per block) and stop. Save the user's answer back with `qa set` so it's never asked again.
- No hit and the field is optional → leave blank. Never fabricate.

## Step 4 — Submit (auto) or block (HITL)

- **Clean form** (no captcha/consent-modal/login, no knockout) → click the final Submit.
- **Unresolvable blocker** (captcha, consent modal, forced login without Keychain creds, knockout
  mismatch, duplicate detected) → set the queue row and **stop**:

      node <tracker> queue set <queueId> awaiting_user "<exact, actionable message>"

  Single run: finish with `AWAITING_USER`. Batch: stop the whole run; the user resolves it in the
  visible Chrome and tells you to continue — then re-check the page and proceed. Never loop on the
  same blocker. Login: use Keychain only when the portal/company was preconfigured
  (`security find-generic-password -s <apply.keychain_service> -w`; email = profile email). Never
  write passwords to files/notes/logs.

## Step 5 — Record the outcome

After submit, verify before completing:

    node <jev> verify-submit --page <confirmation-text> --role <role.json>

`confirmed:true` (≥ 0.8) → complete. Ambiguous (0.4–0.8) → `queue set <queueId>
awaiting_user "unconfirmed submit: <page evidence>"`, do NOT mark applied.

On verified submit:

    node <tracker> queue complete <roleId> <queueId> "submitted (<portal>)"

Then add a human note:

    node <tracker> note <roleId> "applied <date> via apply-to-jobs (<portal>) …"

Optional per-step progress: `queue step <queueId> "<step>"` ("opening form", "filling", "submitted").

## Final message

`APPLIED` (clean submit) · `AWAITING_USER` (blocker set; explain in one line) ·
`SKIPPED` (duplicate guard — already applied) · `MISMATCH`/`KNOCKOUT`/`ERROR` (stopped; explain in
one line). In batch mode, report the tally: applied N, skipped as duplicate M, awaiting user on
<company> (blocker), remaining K queued.
