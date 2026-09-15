# Lever — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `jobs.lever.co/<company>/<id>`.

## Navigate
1. `chrome.mjs open <url>`; verify the H1 title/company.
2. Click **Apply for this Job** — Lever opens a modal/form (may grab an hCaptcha).

## Quirks (CRITICAL)
- **hCaptcha triggers when checkboxes/radios are clicked programmatically.** Fill text inputs,
  textareas, and standard selects only. Leave checkboxes/radios untouched and put their recommended
  values in the `awaiting_user` message so the user ticks them and solves the captcha by hand.
- If an hCaptcha iframe is present, you cannot solve it → `awaiting_user`
  ("Lever hCaptcha present — tick the consent boxes and solve the captcha in Chrome, then confirm").
- react-select: `keys` char-by-char, re-snap, pick by label.
- Duplicate application: if the form says the candidate already applied, respect it → `awaiting_user`.

## Submit
Click **Submit** only when the form is clean (no captcha, no required checkboxes left for the user).
Otherwise `awaiting_user`. On success: `queue complete <roleId> <queueId> "submitted (lever)"` (see `_common.md`).
