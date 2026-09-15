# Ashby — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `jobs.ashbyhq.com/<company>/<jobid>` (job page); the application form is at
`<jobid>/application`. Company careers pages may link here.

## Navigate
1. `chrome.mjs open <url>`; verify the H1 title/company against the tracker role.
2. Click **"Apply for this Job"** → the form loads (same page or `/application`). You need the form.

## Quirks
- **Duplicate prevention:** if the user already applied to this company, Ashby may flag the candidate
  by email. Respect it — `awaiting_user` with that message rather than resubmitting.
- Name/email/phone may "auto-fill from resume"; always re-read the fields after fill and re-fill if a
  value came back empty (e.g. phone after a resume upload).
- react-select dropdowns: use `keys` (per-character key events), re-snap between keystrokes, then
  click the matching `[role=option]` row by label.
- **Validation errors name the required question, not the field:** submit can fail with "Missing entry
  for required field: <Question label>" even when that question's checkbox/option isn't marked
  `required` in the DOM (often a consent/acknowledgement section near the end). On error, read the
  error list, locate the named label, tick it, re-submit.
- A hidden `textarea.g-recaptcha-response` with token gibberish inside `div.grecaptcha-badge` is the
  normal invisible reCAPTCHA — ignore it, never fill it, it is not a honeypot you touched.
- The final button reads "Submit Application"; success shows a "Success / Thanks for applying" panel
  (no URL change). Some companies run a follow-up AI interview (e.g. Ezra) — post-submit, not a blocker.

## Submit
Click **Submit Application** unless blocked (captcha, consent modal, login wall, knockout mismatch) →
`awaiting_user`. On success: `queue complete <roleId> <queueId> "submitted (ashby)"` (see `_common.md`).
