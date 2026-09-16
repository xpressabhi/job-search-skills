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
- Browser helper: `scripts/chrome.mjs` (see `portals/_common.md` for the command set)
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

Duplicate guard first (`_common.md` § Duplicate guard): page says "Applied" or the tracker already
shows `applied`/pipeline → skip, never re-apply — the same role reached via LinkedIn and the company
ATS is one application.

Cross-check form questions against the profile: years, degree, work authorization, location, salary
(fill only when the range covers the profile band; else blank + flag). **If a hard requirement clearly
fails: do NOT fill/submit** → `awaiting_user "knockout: <question>"` and stop.

## Step 3 — Fill

Fill everything through the browser helper (locators → fill → re-read to verify). Follow the portal
ref's quirks. Resume comes from `cv.stored_path || cv.path` — upload it, then re-verify the fields the
portal autofills from it.

### Answer bank — check before you ever block or guess

For any question not answerable from the profile or CV, check the stored answers first:

    node <tracker> qa get "<question text>"

- Match loosely (strip punctuation, case-insensitive). A hit → fill it (also for equivalent questions
  on other portals: notice period, sponsorship, "why this role", "how did you hear", etc.).
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

On successful submit:

    node <tracker> queue complete <roleId> <queueId> "submitted (<portal>)"

Then add a human note:

    node <tracker> note <roleId> "applied <date> via apply-to-jobs (<portal>) …"

Optional per-step progress: `queue step <queueId> "<step>"` ("opening form", "filling", "submitted").

## Final message

`APPLIED` (clean submit) · `AWAITING_USER` (blocker set; explain in one line) ·
`SKIPPED` (duplicate guard — already applied) · `MISMATCH`/`KNOCKOUT`/`ERROR` (stopped; explain in
one line). In batch mode, report the tally: applied N, skipped as duplicate M, awaiting user on
<company> (blocker), remaining K queued.
