# Greenhouse — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `boards.greenhouse.io/<slug>` or `job-boards.greenhouse.io/<slug>/jobs/<id>`.

## Navigate
1. `chrome.mjs open <url>`; verify the H1 title/company.
2. Click **Apply** → the application form loads on the same page (or a dedicated application page).

## Quirks
- Cookie/consent banners (GDPR) may overlay the form — dismiss them first.
- Greenhouse often includes **multiple rate questions** (1–10 scales) or company-specific selects —
  answer honestly from the CV/profile; never inflate.
- Location/state/country comboboxes are often react-select: type with `keys`, re-snap, click the
  option by its exact label (large lists — select by value/label, don't dump all options).
- Checkboxes labelled "consent / privacy notice": tick only when mandatory-and-safe; when a
  demographic section exists, use the profile's EEOC preference (`decline` → its decline option).
- Resume upload: `upload "input[type=file]" <cv>`; if a "parse resume" autofill appears afterward,
  let it fill and then re-verify every field.
- Re-read all filled values before submit (fill → snap → compare with profile).

## Submit
Click the green **Submit Application** unless blocked (captcha / consent modal / login / knockout) →
`awaiting_user`. On success: `queue complete <roleId> <queueId> "submitted (greenhouse)"` (see `_common.md`).
