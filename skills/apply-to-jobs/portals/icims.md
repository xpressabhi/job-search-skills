# iCIMS — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `icims.com` (e.g. `careers-<company>.icims.com/jobs/<id>`). Frequently behind a
**login/consent wall** (Atlassian, AMD, and others).

## Navigate
1. `chrome.mjs open <url>`; verify title/company.
2. Consent/GDPR wall: accept the privacy/consent dialog if present ("Continue"/"Accept").
3. If iCIMS forces **"Log in to apply"**: iCIMS has no unified login, and the user may need to create
   an account. Use Keychain credentials **only if this portal/company was preconfigured**; otherwise
   `awaiting_user` — ask the user to create/log in with their email in the visible window, then confirm.

## Quirks
- Multi-step wizard with a progress bar: fill each step and click **Continue/Next** until the review
  page — don't skip ahead.
- Required asterisks vary; after each step, re-scan for unmet required fields (error text) and fix.
- Attachments: `upload "input[type=file]" <cv>`; verify the uploaded filename appears.
- Some old forms use tables/frames — if an element isn't in `snap`, try `eval` to inspect the form.

## Submit
On the final review step, click **Submit Application**. Login wall before the form → `awaiting_user`.
On success: `queue complete <roleId> <queueId> "submitted (icims)"` (see `_common.md`).
