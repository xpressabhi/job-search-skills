# Search playbook — techniques, sources, verification

The workflow in `SKILL.md` is the contract; this file is the craft. Read the profile first —
`tracker profile show` — and let it decide modes, locations, comp floors, and exclusions. Where
this file says "the user's floors/regions", read the actual values from the profile; nothing here
overrides them.

## 1. Freshness window

Sort every portal newest-first and read the posting's publish date (Greenhouse/Ashby/Lever/Workday
all show one; for boards without dates, newest-first order is the signal).

- **Within `search.freshness_days`** (profile, default 7): always eligible; record `posted_at`.
- **Older but new to the tracker and top-tier fit**: surface, ranked below fresher roles, flagged
  `(stale, posted YYYY-MM-DD)`; set `posted_at`. A slow pipeline beats no pipeline.
- **Already in the tracker** with any status except `interested`: never re-surface. The
  `tracker seen` check is the hard gate and runs on every candidate *before* ranking.
- Skip stale roles that are partial-fit, below the comp floor, or failing any exclusion.

## 2. Per-portal sweep technique

- **Greenhouse:** `boards.greenhouse.io/<slug>?location=<Country>` + `?query=` for keywords
  ("Staff", "Principal", "AI Engineer", "Remote").
- **Ashby:** `jobs.ashbyhq.com/<slug>?locations=<Country>` — the typeahead accepts partial names.
- **Lever:** `jobs.lever.co/<slug>` — team + location filters in the sidebar.
- **Workday:** no URL shortcut — open the root, use the Location / Remote filters.
- **Own boards (Google/MS/Amazon/Stripe/Netflix…):** site search box; filter country + remote.
- **Other ATS (BambooHR `<co>.bamboohr.com/careers`, Recruitee `<co>.recruitee.com`, Teamtailor,
  Personio):** no query params — scan the board root; the company's `/careers` page links its ATS.
- **LinkedIn fallback:** `linkedin.com/company/<slug>/jobs` catches roles posted only to LinkedIn.
- **ATS site-query cross-check** (after the sweep): restrict to known slugs —
  `site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com OR site:jobs.lever.co ("Staff Software Engineer" OR "Principal Software Engineer") (<country> OR <city> OR Remote)`.
  Workday hosts index poorly — sweep them directly instead.
- Keep a running list of surfaced ATS URLs while sweeping; a role posted on several boards counts once.

## 3. Supplements — remote boards (only if the primary sweep yields too few)

Himalayas (himalayas.app/jobs) · RemoteOK · WeWorkRemotely · Remotive · Wellfound · JustRemote ·
Working Nomads · ai-jobs.net · YC (ycombinator.com/jobs — the location tag, e.g. "Remote (IN)", is
the eligibility signal, not marketing copy) · HN "Who is hiring?" monthly thread ·
LinkedIn with the remote filter (`f_WT=2`) · WelcomeToTheJungle (salaries shown).
Aggregator labels lie — always re-verify eligibility on the company's own posting.

Middleman platforms reselling engineers (Turing/Crossover/Uplers-style) and "apply once, we match
you" bodyshops are not in scope: pay, IP, and work quality rarely clear the bar. Direct platforms
(Braintrust, Contra, Arc.dev) are lead sources only — verify the end client.

## 4. Supplements — local on-site/hybrid boards

Use the user's city/metro from the profile:

- **LinkedIn Jobs:** city geoId + `f_WT=1` (on-site) | `f_WT=3` (hybrid) | `f_WT=2` (remote),
  separate runs. Search the target titles; use the salary filter where available.
- **Naukri / Cutshort / Instahyre / iimjobs** (India) · **Otta** (UK/US/EU) · **Jobs.ch** (CH) ·
  **StepStone/Xing** (DACH) · **Seek** (AU/NZ) — the regional board splits by market; use what the
  profile's country implies.
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
5. Relocation requirements — the profile says whether relocation is acceptable. If `relocation:
   false`, any "remote now, relocate later" or relocation-required posting is a hard skip.

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
- Published ranges strongly preferred; when absent, write `estimate: <X>` and rank below roles that
  publish. Note equity-only-heavy offers and flag if base is below the floor.
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
