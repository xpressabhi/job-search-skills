# LinkedIn — apply portal reference

Values: see `_common.md`. All personal data comes from the profile — never hardcode it.
LinkedIn runs on the user's own session: never create an account, never click "Agree & Join", never
enter a password (Keychain only if preconfigured), never accept connection requests.

## Recognize
`linkedin.com/jobs/view/<id>` (posting) · Easy Apply modals · `linkedin.com/jobs/search…` (discovery
is job-finder's job — do not sweep here from apply).

## Step 1 — Login (once)
A guest wall ("Join LinkedIn / Sign in") is a LOGIN wall → `awaiting_user "LOGIN: LinkedIn — sign in
in the visible Chrome, then confirm"`. The session persists in the dedicated Chrome profile, so this
is a once-ever step. After the user confirms, re-load the page and continue.

## Step 2 — Duplicate guard (both checks, before anything else)
1. **Page:** if the posting shows "Applied <date>" (or the Apply control is replaced by "Applied"),
   stop → `queue set <queueId> skipped "already applied on LinkedIn <date>"`.
2. **Tracker:** `tracker.mjs role "<company>:<title>"` — if status is `applied` or further in the
   pipeline (`oa`/`phone`/`onsite`/`offer`/`accepted`), stop the same way. A role reached via a
   different URL (LinkedIn vs the company ATS) is the same application; never apply twice.

## Step 3 — Easy Apply vs the original posting
Always resolve the **original posting** first (the Apply control shows where it lives) and record its
URL in the note. Then pick the flow:
- **Easy Apply is shown** → apply directly in the modal (below) — no need to leave LinkedIn.
- **No Easy Apply, Apply links out** → that external URL *is* the original posting: detect the portal
  from the final URL, switch to that portal's reference, and apply there.

## Easy Apply flow
1. `click` Easy Apply → modal opens; `snap` after **every** step (the modal re-renders per step).
2. Wizard pages (Contact info → Resume → screening questions → Review). Fill only from the profile /
   answer bank; an unknown **required** question → `awaiting_user "QA: <exact question>"` (never
   guess, never fabricate).
3. Resume: select the current CV (`cv.stored_path || cv.path`); if only stale resumes are listed,
   upload the current file via the modal's upload control.
4. Screening questions: `qa get` first, then profile (`apply.*` for authorization/sponsorship,
   `search.salary` band for expected pay — adequate number, never the top of the band).
5. Review step: re-read every answer against the profile before Submit; use Back to fix, don't
   re-run the whole modal.
6. Submit ("Submit application"). Success = confirmation screen or the posting shows "Applied".
7. Optional follow-up screens ("Answer more questions", premium upsells) — skip; they are not part
   of the application.

## Recurring walls and quirks
- Checkpoint/verification walls mid-flow (unusual email/phone challenge) → `awaiting_user`, human
  resolves, then continue; never loop.
- External apply tabs: LinkedIn may open the ATS in a new tab — `pages` lists it; detect the portal
  there and apply from that tab.
- Postings get re-created with new job ids; the duplicate guard's tracker check (company+title)
  catches the same role under a new URL.
- "Promoted" / staffing-agency reposts: verify the employer on the original posting before applying.

## Submit
Clean modal / external form → final Submit. On any wall → `awaiting_user`.
On success:

    node <tracker> queue complete <roleId> <queueId> "submitted (linkedin easy apply)"
    node <tracker> note <roleId> "applied <date> via apply-to-jobs (linkedin easy apply; original posting: <url or none>)"

If applied via the external ATS after switching portals, record that portal instead:
`submitted (<portal>, via linkedin)` and note the LinkedIn URL as the source.
