# Workable — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `apply.workable.com/<company>/j/<id>`. Company sites may embed the Workable widget.

## Navigate
1. `chrome.mjs open <url>`; verify the H1/company + role.
2. Click **Apply for this position** → Workable renders the form (SPA — the DOM re-renders aggressively).

## Quirks (CRITICAL)
- **SPA re-renders constantly** — stale element indexes break. Re-run `snap` immediately before every
  action; never batch several clicks/fills against one snapshot.
- Use `fill` (native setter + events) rather than keystroke typing; if the SPA still resets a field,
  focus it with a click and use `keys`.
- After filling, re-read the current values to confirm — the SPA may reset fields on re-render.
- If a field fails twice, put that answer as a numbered list in the `awaiting_user` message so the
  user can paste it manually.
- GDPR/consent banner may cover the button — dismiss first.
- Upload the CV with `upload "input[type=file]" <cv>`; verify the filename appeared in the form.

## Submit
Click **Apply / Submit Application** if clean. If validation bounces, read the errors, fix, retry once;
still stuck → `awaiting_user` with the error text. On success:
`queue complete <roleId> <queueId> "submitted (workable)"` (see `_common.md`).
