# Search playbook — techniques, sources, verification

The workflow in `SKILL.md` is the contract; this file is the craft. Read the profile first —
`tracker profile show` — and let it decide modes, locations, comp floors, and exclusions. Where
this file says "the user's floors/regions", read the actual values from the profile; nothing here
overrides them.

## 1. Freshness & ghosts (user rule 2026-10-06: filter ghosts, prefer new)

Sort every portal newest-first and read the posting's own publish date (Greenhouse/Ashby/Lever/
Workday all show one; for boards without dates, newest-first order is the signal).

- **≤ `search.freshness_days`** (profile, default 7): first-class; record `posted`. `rank` adds a
  deterministic +0.03 ordering nudge (labels unchanged) and the report lists these first.
- **8–45 days:** eligible but aging — `rank` −0.03 nudge, row flagged `(posted YYYY-MM-DD)`.
  A slow pipeline still beats no pipeline, but it never outranks fresh.
- **> 45 days:** ghosts. Drop before fetch/rank; count into "ghost/stale — skipped: N". Override
  only with the user's explicit permission (`--max-age`).
- **Evergreen language** ("always hiring", "talent pool", "general application", "future
  opportunities", "rolling basis", "keep your CV on file", "no specific role"): ghosts regardless
  of date; drop and count.
- **Date unknown:** fetch the page and read it; still unknown → flag `date: unknown`, rank below
  dated peers. Never present an undated stale-looking repost.
- **Already in the tracker** with any status except `interested`: never re-surface (hard gate,
  runs before ranking).
- Deterministic ghost checks live in `jev.mjs` (`rank`/`triage`/`liveness` info) and
  `crosscheck.mjs` (gate item 0) — no model calls, fail-closed.

## 2. Per-portal sweep technique

**Fastest path first:** every major ATS exposes a public JSON listing endpoint — verified URLs,
fields, and tenant-validation traps in `reference/ats-apis.md`. Prefer JSON over rendering pages
(faster, structured `workplaceType`/`publishedAt`/salary fields, no dead-board surprises); fall back
to the board URL when an endpoint is missing or blocked.

- **Greenhouse:** `boards.greenhouse.io/<slug>?location=<Country>` + `?query=` for keywords
  ("Staff", "Principal", "AI Engineer", "Remote").
- **Ashby:** `jobs.ashbyhq.com/<slug>?locations=<Country>` — the typeahead accepts partial names.
- **Lever:** `jobs.lever.co/<slug>` — team + location filters in the sidebar.
- **Workday:** no URL shortcut — open the root, use the Location / Remote filters.
- **Own boards (Google/MS/Amazon/Stripe/Netflix…):** site search box; filter country + remote.
- **Other ATS (BambooHR `<co>.bamboohr.com/careers`, Recruitee `<co>.recruitee.com`, Teamtailor,
  Personio):** no query params — scan the board root; the company's `/careers` page links its ATS.
- **LinkedIn (run every sweep — scripted):** `node scripts/linkedin-sweep.mjs check` then
  `run` (profile titles × Hyderabad + India-remote, `f_TPR` 1/3/7/30 days, newest-first, full
  virtualized-list collection), then `resolve --in <cards.json> --limit N` to decode each card's
  original ATS URL. Login wall → the user signs in once in the visible Chrome profile
  (`apply-to-jobs`' `chrome.mjs launch`); the session persists. A LinkedIn URL is reported only
  for Easy-Apply-only listings (label `easy apply`). Dedupe on company+title keeps the LinkedIn
  and ATS copies of one role from surfacing twice. Manual fallback: search
  `linkedin.com/jobs/search/?keywords=…&location=…` with `f_WT=2` (remote) / `1` (on-site) /
  `3` (hybrid) and `sortBy=DD`; company pages `linkedin.com/company/<slug>/jobs` catch roles
  posted only there. Record `--source linkedin`.
- **ATS site-query cross-check** (after the sweep): restrict to known slugs —
  `site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com OR site:jobs.lever.co ("Staff Software Engineer" OR "Principal Software Engineer") (<country> OR <city> OR Remote)`.
  Workday hosts index poorly — sweep them directly instead.
- Keep a running list of surfaced ATS URLs while sweeping; a role posted on several boards counts once.

## 3. Supplements — remote boards (only if the primary sweep yields too few)

Himalayas (himalayas.app — its API has **no search/filter** over 116k listings; use the website in a
browser, or skip) · RemoteOK · WeWorkRemotely · Remotive · Wellfound · JustRemote ·
Working Nomads · ai-jobs.net · YC (ycombinator.com/jobs — the location tag, e.g. "Remote (IN)", is
the eligibility signal, not marketing copy) · HN "Who is hiring?" monthly thread ·
LinkedIn (signed in — §2) with the remote filter (`f_WT=2`) · WelcomeToTheJungle (salaries shown).
Aggregator labels lie — always re-verify eligibility on the company's own posting.

Middleman platforms reselling engineers (Turing/Crossover/Uplers-style) and "apply once, we match
you" bodyshops are not in scope: pay, IP, and work quality rarely clear the bar. Direct platforms
(Braintrust, Contra, Arc.dev) are lead sources only — verify the end client.

## 4. Supplements — local on-site/hybrid boards

Use the user's city/metro from the profile:

- **LinkedIn Jobs** (signed in — §2, scripted): `linkedin-sweep.mjs run` covers on-site/hybrid/
  remote via separate queries; manual pattern is city geoId + `f_WT=1|3|2` with `f_TPR` and
  `sortBy=DD`.
- **Naukri** (India — scripted): `node scripts/naukri-sweep.mjs run` — date-sorted, Hyderabad by
  default (`--loc`), paginates via canonical `-N` URLs. Cross-check shortlisted roles against the
  employer's own portal; Naukri's apply flow is often the employer's chosen channel, so treat the
  Naukri posting as the application target when no company posting exists.
- **Cutshort / Instahyre / iimjobs** (India, manual — login-walled) · **Otta** (UK/US/EU) ·
  **Jobs.ch** (CH) · **StepStone/Xing** (DACH) · **Seek** (AU/NZ) — the regional board splits by
  market; use what the profile's country implies.
- **Wellfound** + **YC jobs** with the country filter.
- **Glassdoor / AmbitionBox / levels.fyi** for salary benchmarking before ranking.

## 5. X / Twitter (fastest for fresh startup news: new offices, funding, founder posts)

- Access: X API if available; else a CDP browser session — user logs in once in a visible Chrome,
  then `https://x.com/search?q=<query>&f=live` (`f=live` is essential), scrape body text.
- Queries: `"staff software engineer" remote <country> hiring`, `"forward deployed engineer" remote hiring`,
  `AI engineer remote hiring`, `-filter:retweets`.
- Resolve `t.co` links (`curl -sIL`), grep the page for `ashbyhq|greenhouse|lever|workday`, and apply
  on the real ATS, not the tweet.

## 6. Query patterns (adjust titles/skills from the profile)

- Remote: `staff <role> remote`, `principal <role> worldwide`, `<role> remote <region>`,
  `forward deployed engineer remote`, `solutions architect <domain> remote`, `AI engineer <domain> remote`.
- Combine with `(full remote OR worldwide OR anywhere OR APAC OR <region>)`; look for
  "time zones: <user's>", "hires from <country>", contractors-globally language.
- Local: `<role> <city>`, plus the on-site/hybrid filters above.
- Search twice with different keywords — listings vary run to run.

## 7. User company lists (CSV / Google Sheets)

If `profile.company_list_urls` is non-empty, treat each list as a **candidate pool only**:

1. Fetch CSV export: `https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=0`.
2. Apply the full pipeline per company: exclusions → eligibility → comp floor.
3. Dedupe against the starter universe (use the master portal root, not the list's often-stale link).
4. Skip and list (with reason) anything below floor / not hiring in an eligible location.
   Sheet presence is never a free pass.

## 8. Freelance / contract (only if the profile includes contract work)

- Priority: direct client contracts (cold outreach to founders/CTOs with a specific product
  observation beats board-hopping) · self-directed marketplaces (Braintrust, Contra) as lead sources.
- Report contracts as `[contract]` with rate, hrs/week, and client location — rank by rate × hours
  and note stackability (multiple part-time contracts can beat one salary).
- Non-negotiable: direct invoice to the company, rate agreed in writing, kill-fee for cancelled work.
- Red flags on top of §10: work before contract/escrow, task-based pay, unbounded unpaid test
  projects, no IP terms, local-currency pay for a foreign client, sanctioned jurisdictions.

## 9. Eligibility verification (do NOT skip)

**Remote:** "remote" ≠ eligible where the user lives. Check:

1. Location scope: Worldwide / Anywhere / specific regions / explicit country list.
2. Timezone: required overlap hours vs the user's timezone; drop roles locking to far-offsets with no
   async flexibility if the profile says so (record the reason).
3. Payroll: entity, EOR (Deel/Remote/Oyster/Multiplier/Skuad/Papaya), or "contractors globally".
4. Exclusions: "must be authorized to work in <country>" that the user isn't, US-only / EU-only, etc.
5. Relocation requirements — read `search.relocation` in the profile. Plain `false` → any
   "remote now, relocate later" or relocation-required posting outside the candidate cities is a
   hard skip. Conditional form (`{conditional:true, min_total_lpa, min_cash_lpa, regions}`) →
   office/hybrid roles in otherwise-excluded metros ARE eligible only when the posting evidences
   pay meeting the floors (total above `min_total_lpa` with at least `min_cash_lpa` as cash;
   bonus/stock/RSU/ESOP may cover the remainder). Unpublished or unverifiable pay does not
   qualify. `jev.mjs` enforces this deterministically in the onsite gate (`relocationTermsOk`)
   and the eligibility question reads the same terms; the report discloses whether the cash
   split was verified or needs recruiter confirmation.

Ambiguous → fetch the posting; still unsure → mark `unverified` and rank accordingly.

**On-site/hybrid:** verify a real office in the posted city (not a co-working virtual address), the
actual mode (days/week on-site vs hybrid vs "remote within country"), and that the city is in
`search.cities`. "Relocation possible" is not the same as "this role is in <city>" — treat it as
unverified.

## 9a. Posting liveness (never report a dead link)

Aggregators and reposts go stale fast — the posting itself gets fetched and classified before it
reaches the report:

- `expired`: page loads but says "no longer accepting applications", "position filled", "posting
  removed", "job no longer available" → drop.
- `redirected`: URL bounces to a careers home/search page, or lands on a different job → drop.
- `not_found`: 404/410, or "job not found" content → drop.
- `suspicious`: application/verification fees, no employer name, recruiter-only contact without a
  company site → drop, warn (§10).
- Fuzzy matches are fine (minor title/company wording); a different role entirely is not.
- Blocked fetch (captcha, 403, anti-bot): retry once; still blocked → keep but mark `unverified` and
  rank accordingly — never silently call it live. Known bot-blockers: Workday roots (companies.md
  Notes), X, LinkedIn.
- Aggregate a kill rate into the report: "dead/expired — skipped: N" (see SKILL.md Step 4).

## 10. Red flags — warn, don't hide

- Crypto/token pay, upfront or "verification" fees, bank details/OTP/KYC requests early
- No legal entity, no payroll answer, vague contract terms
- Location requirement contradicts "remote"
- **Low-trust / micromanagement signals:** screen-time or activity tracking, "must be online
  9–6 <far timezone>", granular hour logging, standing 6-day weeks
- Founder offers with 24/7 on-call or 3-month renewals
- Telegram/Discord-only recruiters, no company email domain, no real careers page
- Fake/clone ATS domains (`job-boards.greenhouse.io.fake.com`) — must match the real ATS root
- Staffing-agency reposts ("via X Recruitment", "client: Confidential") when the profile wants
  to hear from the hiring company only

**Verification playbook when in doubt (do all four):** domain (linked from the company site) ·
funding (Crunchbase/YC — unfunded "$200k remote day one" is a scam tell) · people (real employees,
history predating the posting) · money flow (direct wire or named EOR only).

## 11. Ranking yardsticks

- **Match against the CV, not the profile summary.** Score seniority, stack, and the CV headline.
  Drop roles whose required skills are absent from the CV; surface ~70%+ matches as
  `partial fit` with the gap named; never stretch the CV.
- Remote-USD reference bands (when the profile's floor is USD): Junior/Mid $40–80k · Senior $80–130k ·
  Staff/Principal $120–200k+ · Leadership $150–250k+. Local-currency bands vary by market — anchor on
  the postings themselves plus the benchmark discipline below, and rank by true annual take-home, not
  by the currency format.
- Order: eligibility confirmed > published salary > CV-fit > company quality > timezone/commute fit.
- **Warm path** (profile channel rule): a role with 1st-degree coverage at the company outranks an
  otherwise equal cold role — `scripts/warm-path.mjs "<company>"` supplies the signal (1st-degree
  names, 2nd-degree count) for the report's "next moves".
- Published ranges strongly preferred; when absent, **estimate before dismissing**
  (`scripts/payest.mjs estimate --role R.json`, evidence ladder published → observed → floor →
  unknown) and write `estimate: ₹X–Y (basis)`; unknown stays `not published (comp unverified)` and
  ranks below dated/published peers. Comp-gated decisions (relocation, down-level surfacing) may
  pass on observed evidence — always with `verify pay with recruiter`. Note equity-only-heavy
  offers and flag if base is below the floor. Every real range encountered (posting or recruiter
  call) gets recorded: `payest.mjs set "<company>" --min L --max L --source "<evidence>"`.
- Cross-mode comparison: convert everything to the user's primary currency at a consistent rate
  (state the rate assumption once) before ordering the report.
- **Benchmark like this, never from one source:** triangulate at least two (BLS OEWS by SOC code,
  levels.fyi for big tech, Glassdoor/Comparably self-reports, sector guides — Mercer/Robert Half for
  professional services, Candid/990s for nonprofits), date the underlying data (`as of 2025`) and say
  when it lags, and widen the band + flag thin samples (<25 reports, no BLS match). Never mix base
  with total comp unlabeled; sector matters (same title at a $50M foundation ≠ a $5M nonprofit).
- **What must never raise a rank:** logo/brand recognition, aggregator ranking (paid boosts),
  title-match alone, recruiter urgency. **What overrides the order entirely:** scam/fee signals,
  knockouts, and dead postings (§9a, §10) — however good the math looks.

## 12. Tips

- Sweep the starter universe in table order every run; re-verify portal health when a bookmark 404s.
- Use `webfetch` on board search URLs; many need query strings (`?q=…&region=…`).
- Run both mode tracks when the profile allows several (remote + local); a strong local offer can
  beat a weak remote one on take-home — the numbers decide.
- Company memory: `company add` new strong sources so future runs sweep them automatically;
  `company candidates` surfaces repeat declines worth ignoring; `company verify` (monthly,
  `--stale 90`) keeps portals from rotting (SKILL.md Step 5 + Universe hygiene).
- X is the fastest channel for fresh AI/FDE roles; founders post before recruiters.
- When surface-level applications stall: pick ONE niche, build public reputation (OSS contribution,
  monthly technical post, community presence), then cold-email founders with a specific observation.
