# Workday — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `*.myworkdayjobs.com` (e.g. `<company>.wd5.myworkdayjobs.com/en-US/...`).

## Navigate
1. `chrome.mjs open <url>`; verify title/company.
2. Click **Apply** — it's an `<a data-automation-id="adventureButton">` whose href ends in `/apply`.
   Workday's custom widgets ignore synthetic `.click()` → use `chrome.mjs click <index>` (real mouse
   coordinates) or navigate to the href directly.
3. The "Start Your Application" page offers **Autofill with Resume** (`/apply/autofillWithResume`),
   **Apply Manually** (`/apply/applyManually`), **Use My Last Application**. Prefer **Autofill with
   Resume** (uploads the CV and pre-fills standard fields — still re-verify every field).
4. Workday then asks **"Do you already have an account?"** as step 1 of a 7-step wizard — always check
   the stepper:
   - Prefer **"Apply without an account"** when offered (fastest, anonymous).
   - If the company forces account login: use Keychain **only if preconfigured for this company**
     (service `<apply.keychain_service>-<company>`); otherwise `awaiting_user`
     ("Workday requires a <company> account — create/log in with <profile email> in the visible
     window, then confirm").

## Quirks
- Long multi-section wizard with its own accessibility framework: locate fields by label text (custom
  components, not standard inputs); set values and dispatch `input`/`change` (that's what `fill` does).
- Country dropdowns: type-to-search (e.g. "India Índia") then select the highlighted row (`keys` + click).
- Date fields, "How did you hear", and previous-worker questions are common — answer from profile /
  answer bank, never guess.
- Some companies' Workday is bot-hostile. If the form can't be reached after one retry →
  `awaiting_user` with the reason.

## Submit
Final screen shows **Submit Application** (often with a review list) — click it when clean. Any wall →
`awaiting_user`. On success: `queue complete <roleId> <queueId> "submitted (workday)"` (see `_common.md`).
