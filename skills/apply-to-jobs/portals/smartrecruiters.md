# SmartRecruiters — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
URL contains `jobs.smartrecruiters.com/<company>` (e.g. `jobs.smartrecruiters.com/Freshworks`).

## Navigate
1. `chrome.mjs open <url>`; verify title/company.
2. Click **Apply** → SmartRecruiters opens its guided application flow.

## Quirks
- Multi-tab wizard (e.g. "Your Details" → "Your Documents" → "Review"): advance with **Next**; if Next
  is blocked, go back and fix the flagged required fields.
- LinkedIn import buttons are present — ignore them; fill manually (the values come from the profile).
- Consent checkboxes ("I agree to privacy…"): tick only required-and-safe ones.
- Resume upload may have both a file picker and a "parse from LinkedIn" path — use the file picker
  (`upload`), then verify the parsed fields it fills.

## Submit
On the review step click **Submit application** if clean. Any wall → `awaiting_user`. On success:
`queue complete <roleId> <queueId> "submitted (smartrecruiters)"` (see `_common.md`).
