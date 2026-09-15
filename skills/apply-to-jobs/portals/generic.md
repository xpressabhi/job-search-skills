# Generic / unknown ATS — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.

## Recognize
No known portal signature (not Ashby/Greenhouse/Lever/Workable/iCIMS/Workday/SmartRecruiters).
Examples: company-owned careers pages (Google, Amazon, Stripe, Netflix, Canva…), TalentBrew, Clinch,
Eightfold, Phenom.

## Approach
1. `chrome.mjs open <url>`; verify title/company against the tracker role.
2. Find the **Apply / Apply Now / Join our team** button (real-mouse `click`; hover menus may exist).
   Some own-portals deep-link to a known ATS — detect it and switch to that portal's reference.
3. Fill per `_common.md`; multi-step wizards: advance with Continue/Next, re-scan for error text after
   each step, never skip ahead.
4. If the form can't be located after two attempts → `awaiting_user` with the exact blocker + URL.

## Recurring walls and quirks
- **Login-required portals** (Eightfold/Phenom often force an account): Keychain only if preconfigured;
  else `awaiting_user` — the user creates/logs in in the visible window, then confirms.
- **LinkedIn job pages** (`linkedin.com/jobs/view/...`) hit a guest auth wall ("Join LinkedIn / Sign in")
  with no skip — that's a LOGIN wall: `awaiting_user`; never click "Agree & Join" (it creates an
  account). Once signed in, the posting loads and Apply usually deep-links to the company ATS — detect
  and switch.
- **Google careers deep links expire** (a `/jobs/results/<id>-…` URL may bounce to search results).
  Re-locate the live posting via `…/jobs/results/?q=<title keywords>` and read the **location list**
  from the posting itself before applying — search snippets show only one city.
- GDPR/consent and "desired region" walls: dismiss/accept as appropriate.
- Company-hosted forms sometimes live in an iframe — check `pages`/`snap` output for the frame content;
  the CDP helper attaches to the top page, so if the form is cross-origin, tell the user or use
  `eval` to locate the frame URL and open it directly.

## Submit
Click the final **Submit** only if clean; no silent fallbacks. On any wall → `awaiting_user`.
On success: `queue complete <roleId> <queueId> "submitted (generic)"` (see `_common.md`).
