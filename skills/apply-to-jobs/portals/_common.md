# Common apply rules — read this before any portal file

Every portal file assumes the values below. **Never hardcode personal data and never invent any** —
resolve every value from the user's profile / answer bank at apply time.

## Resolve values

    node <job-finder-skill-dir>/scripts/tracker.mjs profile show
    node <job-finder-skill-dir>/scripts/tracker.mjs profile get identity.name
    node <job-finder-skill-dir>/scripts/tracker.mjs qa get "<question text>"

Standard mapping:

| Form field | Source |
|---|---|
| Full name | `identity.name` |
| First / Last name | split `identity.name` on the last space |
| Email | `identity.email` |
| Phone | `identity.phone` |
| Location / City / Country | `identity.location` (+ `identity.country`) |
| LinkedIn URL | `identity.links.linkedin` |
| Website / GitHub / Portfolio | `identity.links.portfolio` → `links.github` → `links.website` (first non-empty) |
| Resume/CV upload | `cv.stored_path` → `cv.path` (first non-empty) |
| Years of experience | `identity.years_experience` |
| Work authorization / sponsorship | `apply.work_authorization`; sponsorship = `apply.sponsorship_required` (map to the form's wording) |
| Notice period | `apply.notice_period` |
| Willing to relocate | `apply.willing_to_relocate` |
| Preferred pronouns | `apply.pronouns` (leave blank if empty) |
| Demographic / EEOC / veteran / disability | `apply.eeoc` (`decline` = use the form's decline option; leave blank when there is none) |
| Expected salary (when required) | `search.salary` band — put the adequate number for the location, never the highest; if truly unanswerable, `apply.extra.expected_salary` |
| "How did you hear about us?" | `apply.extra.how_did_you_hear` if set, else the stored answer, else blank / "Other" |
| Anything else the form asks | `qa get "<question>"` first — the answer bank exists exactly for this |

**Order of resolution for any question:** profile value → answer bank (`qa get`) → if neither and the
field is optional, leave blank; if required, stop and set `awaiting_user` with **`QA: <exact question>`**
as the message. One question per block. Never fabricate.

When the user answers a new question during a run, save it so it's never asked again:

    node <tracker> qa set "<question>" "<answer>" --category forms

## Browser

Drive the user's visible Chrome via this skill's CDP helper (do NOT use `node_repl`; do NOT use
`chromium.connectOverCDP` — a second context manager is rejected by browser-hosted Chrome):

    node <this-skill-dir>/scripts/chrome.mjs launch     # once per session
    node <this-skill-dir>/scripts/chrome.mjs open <url> # one tab per job in batch mode
    node <this-skill-dir>/scripts/chrome.mjs snap       # numbered elements + coordinates
    node <this-skill-dir>/scripts/chrome.mjs click <i> | fill <i> "<value>" | keys "<text>" |
         select <i> "<value>" | check <i> | key Enter | upload "<css>" <file> | eval "<js>" | text

- Re-run `snap` after every page change; act on the newest indexes immediately.
- `click`/`check` dispatch real mouse events at the element's coordinates — use them for custom
  widgets (Workday, Microsoft) that ignore synthetic `.click()`.
- `fill` sets the value with the native setter + `input`/`change` events (React-safe); `keys` sends
  per-character key events (react-select typeaheads); `type` inserts text into the focused field.
- If port 9222 is down: `chrome.mjs launch`, or fall back to the `chrome-devtools` MCP tools.
  Node 22+ is required for the helper; older Node → use the MCP tools and say so.
- Prefer one browser window, one tab per job in batch runs.

## Duplicate guard (before filling anything)

1. **Page state:** if the posting shows "Applied" (LinkedIn badge, Greenhouse "you already applied",
   any "already applied" banner) → stop and record:
   `queue set <queueId> skipped "already applied <date>"`.
2. **Tracker:** `tracker.mjs role "<company>:<title>"` — if status is `applied` or further in the
   pipeline (`oa`/`phone`/`onsite`/`offer`/`accepted`), stop the same way. A role reached via a
   different URL (LinkedIn vs the company's own ATS) is the **same application** — never apply twice.
   `tracker.mjs queue add` also warns on the command line when the role is already applied.

## Verification before submit

1. Re-read every filled field (fill → snap → check against the profile).
2. Knock-out pre-scan: if a hard requirement clearly fails (work authorization, location, years,
   degree) → **do not submit**; `awaiting_user "knockout: <question>"` and stop.
3. Never submit past a captcha, a consent modal that needs a human, or a forced login without
   preconfigured credentials.

## Submitting and recording

- Clean form (no captcha/consent/login/knockout) → click the final Submit.
- Blocked → set the queue row to `awaiting_user` with an exact, actionable message and **stop**
  (single: finish; batch: stop the whole run):

      node <tracker> queue set <queueId> awaiting_user "CAPTCHA: hcaptcha on step 2 — solve it in Chrome, then confirm"

  Never loop on the same blocker. The user resolves it in the visible browser and tells the agent to
  continue; the agent re-checks the page and proceeds.
- Login: use the macOS Keychain entry **only** when the portal/company was preconfigured —
  `security find-generic-password -s <apply.keychain_service> -w` (email = profile email). Never write
  credentials to files, notes, or logs. If not preconfigured → `awaiting_user "LOGIN: …"`.
- After a successful submit:

      node <tracker> queue complete <roleId> <queueId> "submitted (<portal>)"
      node <tracker> note <roleId> "applied <date> via apply-to-jobs (<portal>)"

- Per-step progress (optional, useful in batch): `queue step <queueId> "<step>"`.
