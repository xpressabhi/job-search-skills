# First-run onboarding — build the user's profile

Run this **only when `~/.job-search/profile.json` does not exist** — check with
`node <skill>/scripts/tracker.mjs profile path`: non-zero exit + "profile missing" means first run.
Or when the user explicitly asks to change setup. Everything is stored locally at `~/.job-search/` —
say so up front; nothing is uploaded anywhere.

## Ground rules

- **CV first.** Start by asking for the CV (local path or URL) and extract as much as possible from
  it. Present what you found; ask them to correct it. Only then ask the questions the CV can't answer.
- **Interview, don't interrogate.** One section at a time; wait for answers; confirm briefly and move on.
- **Offer defaults / suggestions** on every remaining question (`(suggested: …)`) — from the CV where
  possible, otherwise from sensible defaults. Accept "skip" / "you decide".
- **Never invent** personal facts. Empty is better than wrong.
- When all sections are done, write a temp JSON file, `tracker profile import <file>`, show a compact
  summary, and continue with whatever the user originally asked for (usually "find jobs").

## Step 1 — Ask for the CV

> "Where's your CV? A local file path or a URL — PDF, DOCX, or markdown. A text/markdown version is
> ideal, but I can read PDFs too."

Then:

1. **Local path** → read it with your file tools (most agents read PDFs directly; for DOCX try a
   converter if available). **URL** → fetch it (webfetch / scrape tool). If the URL is behind a login
   or fails twice, ask for the file instead. Never scrape a LinkedIn profile page — ask for the CV.
2. **If the file can't be parsed** → try the available document tools; last resort, ask the user to
   paste the CV text or point at a text version.
3. **Offer to store a copy** for stable applications:
   - copy the original into `~/.job-search/cv/<original-filename>` → `cv.stored_path`
   - if a text/markdown version exists, copy it to `~/.job-search/cv/cv.md` → `cv.text_path`
   - keep the original location in `cv.path` either way
4. **If the user has no CV at all** → say so is fine; fall back to the interview-only path: collect the
   same facts (name, contact, latest roles, years, stack) verbally and save a starter
   `~/.job-search/cv/cv.md`; continue with the questions below.

## Step 2 — Extract and present (don't ask what the CV already answers)

From the CV, fill:

- **identity:** full name, email, phone (with country code), city + country, LinkedIn / GitHub /
  portfolio / website URLs, total years of experience (earliest role → now), one-line headline
- **targets (draft):** current/most recent title, likely seniority, 3–8 candidate titles to search
  (infer from their trajectory — then let them choose), core skills, industries

Present it as a compact summary and ask them to **correct anything**:

> "Here's what I pulled from your CV — fix anything that's off: **<name>** · <location> · <years> yrs ·
> <headline> · <email/phone> · <links> · skills: <…>. Current title: <…>."

Do not re-ask fields the user just confirmed. Only ask if something is missing or ambiguous
(e.g. no phone on the CV, several possible locations).

## Step 3 — Remaining questions (one section at a time)

### 3a. What you're looking for
- Which of the candidate titles should I search? (offer 3–8, let them edit)
- Target seniority (offer what the CV implies: e.g. Senior / Staff / Principal)
- Industries to prioritize or avoid

### 3b. Search preferences
- Work modes: remote / hybrid / on-site (default all three)
- Remote scope: worldwide / specific regions / timezone-bounded (max overlap hours or async notes)
- For hybrid/on-site: which cities/metros are acceptable
- Relocation: within country? abroad? (default: no)
- Salary: currency + minimum + target for full-time; a local-currency band if they search both
  remote-global and local roles; minimum contract rate if freelance is in scope
- Company rules: product companies only? exclude consultancies/staffing/agencies? specific companies
  to never surface? (suggest the common ones as defaults)
- Freshness: how many days old can a posting be and still be worth surfacing (default 7)

### 3c. Application defaults (seeds the answer bank)
These get reused by `apply-to-jobs` so forms never stall on the same question:
- Work authorization status; do you require visa sponsorship?
- Notice period
- Willing to relocate (mirror of 3b)
- Preferred pronouns (optional)
- Demographic/EEOC questions: answer or decline (default decline)
- Expected salary for forms: a number, range, or "negotiable"
- "How did you hear about this role?" default (default: blank / "Other")
- Any other form question they've answered before and don't want to repeat

Seed the standard ones even if answered "skip" — an empty stored answer is a signal to ask once more at
apply time, not a blocker.

### 3d. Company lists (optional)
- Any public Google Sheets / CSV lists of companies hiring that they maintain or follow (store URLs in
  `company_list_urls`). These are **candidate pools only** — every company still passes the same gates
  (eligibility, comp floor, exclusions).

## Step 4 — Write the profile

1. Build the JSON (shape in `reference/data-model.md`).
2. Write it to a temp file, then:

       node <skill>/scripts/tracker.mjs profile import /tmp/profile.json

   This merges over defaults, saves `~/.job-search/profile.json`, and seeds `answers[]` into the answer bank.
3. Show a 5-line summary (name, location, targets, comp floor, modes) — plus anything derived from the
   CV that the user should double-check (phone, LinkedIn) — and ask them to correct anything.
4. From then on, small edits go through `profile set <dot.path> "<value>"` — no need to re-run
   onboarding. Full re-runs are safe: `profile import` merges, never wipes.

## If the user asks to change one thing later

Examples:

    tracker.mjs profile set search.salary.full_time_min 120000
    tracker.mjs profile set search.modes '["remote"]'
    tracker.mjs profile set identity.location "Berlin, Germany"

Offer this whenever their feedback implies a lasting preference ("actually, no on-site roles" → update
the profile, not just this run).
