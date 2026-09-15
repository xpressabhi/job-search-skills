# Microsoft Careers — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
`apply.careers.microsoft.com/careers/job/<jobnumber>` (posting) — Microsoft's own careers portal (not
Workday-hosted).

## Navigate
1. `chrome.mjs open <url>`; verify title/company and read the listed **work site** (e.g. "3 days/week
   in-office", city) — location knockouts apply per the profile's cities/modes.
2. Click **Apply now** (real mouse click; menus may need hover first) → goes to
   `…/careers/apply?pid=<id>`.

## Sign-in wall (expected)
All Microsoft applications require an account — there is **no guest path**. The sign-in page offers
Microsoft / LinkedIn / Google / Facebook sign-in, or "First time here? Create an account".

- This is a LOGIN wall: `awaiting_user` ("LOGIN: Microsoft careers requires sign-in — sign in with
  <profile email> in the visible Chrome, then confirm") unless credentials are preconfigured in
  Keychain (service `<apply.keychain_service>-microsoft`).
- After the user signs in, the multi-step form continues on the same site; fill per `_common.md`
  (the "Upload your resume" match-checker is optional).

## Submit
Final screen **Submit Application**. Any wall/block → `awaiting_user`. On success:
`queue complete <roleId> <queueId> "submitted (microsoft)"` (see `_common.md`).
