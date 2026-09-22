# Optimization review — job-search-skills

Date: 2026-09-15 · Scope: `job-finder` + `apply-to-jobs` skills, `tracker.mjs`, `chrome.mjs`
Method: full script audit (measured against the live store: 220 roles, 165 KB `data.json`), skill-
authoring review against Anthropic's [Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
and a live-verified survey of public ATS JSON APIs ([skills/job-finder/reference/ats-apis.md](skills/job-finder/reference/ats-apis.md)).

## TL;DR — ranked roadmap

| # | Item | Dimension | Impact | Effort | Where |
|---|---|---|---|---|---|
| 1 | File lock + atomic `profile.json` writes (stop silent lost updates) | persistence | High | Low–Med | `tracker.mjs` |
| 2 | `seen --batch -` (NDJSON in/out) + stop regenerating `applications.md` on every save | speed | High | Low | `tracker.mjs`, `SKILL.md` |
| 3 | `scrollIntoView` before clicks, readiness wait in `open`, launch readiness poll | reliability | High | Low | `chrome.mjs` |
| 4 | ATS JSON sweep fast-path (Workday CXS first, then SmartRecruiters/Workable/BambooHR…) | speed + quality | High | Med | playbook + `companies.md` |
| 5 | `--page` plumbing + full target id from `open --new` + `close` only explicit tabs | reliability | Med | Med | `chrome.mjs` |
| 6 | Three skill evaluations + weak-model test (free Zen model) | quality | High | Low–Med | `evals/` |
| 7 | Schema version migrations + `queue complete` role/queue id guard | persistence | Med | Low | `tracker.mjs` |
| 8 | Archive terminal roles, cap `history`, fix same-day report overwrite | persistence | Med | Low | `tracker.mjs` |
| 9 | Iframes in `snap`/`fill`/`upload`, `fill` by id/name not 6-px distance, CDP batching | reliability | Med–High | Med–High | `chrome.mjs` |
| 10 | Optional `node:sqlite` backend (after 1, 2, 8 — not before) | persistence | Med | High | `tracker.mjs` |

---

## Implemented 2026-09-22 — Jev pre-screening + extraction

| Change | Where | What it saves |
|---|---|---|
| `company-screen` (pre-sweep triage: product, hiring market, pay vs floor, domain fit, information) | `jev.mjs`, finder `SKILL.md` §2.0, cached via `company screen` | one Jev call replaces a board fetch + parse + per-role calls for staffing shops, wrong-geography employers, and below-floor pay |
| `triage` (per-listing fetch/skip on title+location+snippet) | `jev.mjs`, finder `SKILL.md` §2.0 | posting fetches and rank calls for explicit location/track/level mismatches; deterministic onsite gate costs nothing |
| `requirements` (must-haves + per-requirement evidence + gaps) | `jev.mjs`, finder `SKILL.md` §3 | opaque coverage becomes named gaps for the report, and `--max-gaps` can short-circuit fatal fits |
| `salary-parse` (select-not-generate) | `jev.mjs`, finder `SKILL.md` §2.5 | structured base band (currency/min/max/unit) for the comp floor and the report's Salary column |
| `rejection-reason` | `jev.mjs`, finder `SKILL.md` §5 | rejection emails become `mark rejected --reason` entries — the feedback that tunes ranking |
| Dashboard fallback on ambiguous submit | `apply-to-jobs` §5 + `_common.md` | thin thank-you pages no longer block an otherwise-confirmed application |
| Live evals: `run-company-screen.mjs` (7), `run-triage.mjs` (6) | `evals/` | regression bars for both gates |

Design notes: verdicts compose in code from atomic Nouls (composite scoring); `enough_information`
routes unknown companies to `maybe` first so a false skip can never hide a company; screens are dated
and re-screened after 30 days; skips are advisory — the per-role filters still decide every role.

## Implemented 2026-09-22 (pm) — honesty fixes found by the third sweep

All four were live failures in the 2026-09-22 pm sweep; every one could hide a role or
fabricate a verdict, so they are guards, not optimizations.

| Fix | Where | What it prevents |
|---|---|---|
| **Empty posting text is never judged** — `rank` → `unverified`, `fit` → `weak`, both with `no posting text — not judged` | `jev.mjs` (`judgablePosting`) | a Jev call on a blank description answers from the title alone and invents coverage: a LinkedIn 429 left an empty posting and `rank` returned `strong 0.839, coverage 2.95`; with the real text it was `partial 0.571, coverage 1.74` |
| **Requirement spans survive flattened HTML** — over-long single lines fall back to sentence chunks, then word chunks | `jev.mjs` (`requirementCandidates`) | fetch pipelines strip block tags to spaces, collapsing a posting into one line the `>400`-char filter discarded — `requirements` returned *no spans* for all six live postings |
| **Greenhouse double-escaped text decoded** — `&lt;p&gt;` → strip tags → entities | sweep fetch scripts | judges were reading literal `&lt;p&gt;` markup junk instead of the posting |
| **`Home based - …` mapped to `remote`** at rank-input time | sweep fetch scripts | Canonical's home-based roles got `mode:""` → failed relocation despite being worldwide-remote (false skips) |

Also operational (documented, not code): concurrent `seen` processes race on the tracker's
load→save and silently drop inserts — run it sequentially or use `add-batch` (SKILL.md §4).

Verification: `jev.mjs selftest` 59/59 · rank regression 10/10 drop + 8/8 keep ·
triage 6/6 · company-screen 7/7.

## 1. Quality — the skill layer

**Strengths (no action):** SKILL.md files are well under the 500-line budget (97 and 128 lines),
descriptions are specific and inside the 1,024-char limit (615 / 651), references are one level
deep (no nested `SKILL.md → ref → ref` chains), and load-on-demand references match the
progressive-disclosure pattern.

**Gaps:**

1. **No evaluations.** Anthropic's guidance is to build 3+ evaluations per skill *before* polishing
   instructions; the repo has only the CLI `selftest` (which asserts stdout substrings). A sweep's
   real quality risks — wrong eligibility calls, dead links in the report, re-surfacing a seen role,
   invented form answers — are exactly what evals would pin down.
   *Fix:* `evals/` with JSON scenarios (`skills`, `query`, `files`, `expected_behavior`) for:
   (a) first-run onboarding produces a complete profile; (b) a sweep over a fixture board yields the
   ranked report with the right skip lines and no duplicates; (c) an apply run on a local fixture
   form fills from profile/QA bank and pauses instead of guessing.
2. **Never tested on weak models.** The README now recommends free Zen models, which are much worse
   at long tool-calling runs than frontier models. The skills should be exercised end-to-end on a
   small free model and the failure modes captured (e.g. skipping the dedupe gate, forgetting
   `--posted`). If a free model can't hold the workflow, say so in the README.
3. **No feedback loop after submission.** `apply-to-jobs` step 5 records the outcome but nothing
   verifies the portal actually accepted the form (some confirmations arrive late or never).
   *Fix:* after submit, re-check the page for a confirmation marker or "applied" state before
   `queue complete`; if ambiguous, record `awaiting_user` with the evidence.
4. **Time-sensitive facts living in the starter universe** ("Bengaluru office (2026)", "Acquired by
   Cloudflare (2026)"). Acceptable, but `company verify` should be run before relying on them
   (it already exists — make the monthly cadence real in `SKILL.md`).

## 2. Persistence & data safety

The store is JSON with whole-file read-modify-write per command. At today's size that's fast
(0.3 ms parse, 0.6 ms stringify) — the problems are correctness, not milliseconds.

1. **No locking → silent lost updates (top risk).** Every command loads a snapshot, mutates, and
   renames over the file. Two overlapping commands (agent parallelizes, user marks a role during a
   sweep, two sessions) both write; whoever renames last wins and the other's change vanishes.
   The pid-suffixed temp file prevents corruption, not lost updates.
   *Fix:* `open(lock, 'wx')` lockfile with retry + stale-lock break, wrapped around load→save.
2. **`profile.json` is the only store written non-atomically** (`tracker.mjs:690,744,1064,1074`).
   A kill mid-write truncates the one file with no recovery path.
   *Fix:* reuse the tmp+rename helper everywhere.
3. **Multi-file commands aren't atomic:** `company ignore` writes profile → companies → data
   (`tracker.mjs:689-722`); `profile import` writes profile then data (`1074-1077`). A crash between
   steps leaves divergent state. *Fix:* write all temps first, then rename in a fixed order, and
   make the next run reconcile (profile exclude list is the union source anyway).
4. **`queue complete` doesn't verify the role/queue pair** (`tracker.mjs:1005-1019`) — transposed
   ids mark the wrong role `applied`. *Fix:* assert `row.role_id === roleId`, fail loudly.
5. **`seen` saves before the ignore-list check** (`tracker.mjs:531-534`) — an ignored company's role
   is recorded as new before the stderr warning. Harmless, but the warning should gate or annotate
   the record instead.
6. **`version` fields are written but never read** (`tracker.mjs:41,223,301`). No migrations, no
   forward-compat guard. *Fix:* `migrate(data)` switch + refuse newer-than-supported versions.
7. **Growth is unbounded:** `history` appends on every mark even when the status doesn't change
   (`tracker.mjs:150-157`), notes/queue rows are never pruned, roles are never archived. At 10× the
   store size a 100-candidate sweep writes ~2 GB total (per-`seen` full rewrites). *Fix:* skip
   no-op history entries, archive terminal roles older than ~12 months, prune completed queue rows.
8. **`report save` overwrites same-day, same-label reports** (`tracker.mjs:1088-1091`). *Fix:* add a
   `-2` suffix when the path exists.
9. **SQLite is the eventual answer, not the next step.** `node:sqlite` (Node 22.5+) behind an adapter
   would make writes transactional and flat-cost — but only worth it after items 1, 2, and 8 are in,
   and after batch commands land (`add-batch` already proves the pattern: one load, one save).

## 3. Speed

1. **ATS JSON APIs are the single biggest sweep upgrade.** Today the sweep renders board pages;
   every major ATS exposes public JSON with structured fields (`workplaceType`, `isRemote`,
   `publishedAt`, salary, locations) and no auth. Verified endpoints and gotchas:
   [skills/job-finder/reference/ats-apis.md](skills/job-finder/reference/ats-apis.md). Priorities:
   - **Workday CXS** (`POST /wday/cxs/{tenant}/{site}/jobs`) — the current browser fallback is the
     slowest part of every big-tech sweep; JSON gives `title/locationsText/postedOn` and a real
     `startDate` on the detail call.
   - **SmartRecruiters, Workable, BambooHR, Recruitee, Personio, Teamtailor** — all one GET/POST per
     company, complete boards, no pagination or trivial pagination.
   - Greenhouse/Ashby/Lever are already used by `company verify`; extend the playbook to use them for
     **listing**, not just health checks.
   - Sentinel checks already exist in spirit (`verify` probes Ashby/GH/Lever APIs); reuse the same
     tenant-validation traps from the doc (SmartRecruiters returns `200` + `totalFound:0` for bad
     tenants; BambooHR 302s to marketing HTML).
   *Impact:* sweep time per company drops from seconds (render/wait) to ~100 ms; eligibility and
   salary fields arrive structured; dead links are gone before the report.
2. **Batch the tracker calls.** A 100-candidate sweep runs `seen` 100× → 100 processes × full parse
   + full rewrite each. `add-batch` exists but returns only totals, so the agent can't act per row.
   *Fix:* `seen --batch -` reading NDJSON/JSON, printing one `{index, status, id}` per line, one
   load + one save. Also batch `qa get q1 q2…` (called once per form question during apply) and
   `queue list --json --with-roles`.
3. **Stop regenerating `applications.md` on every write** (`tracker.mjs:55-61`). It's 41 KB and grows
   ~186 B/role; users read it rarely. *Fix:* regenerate on `export` and on status-changing commands
   only (or lazily when `applications.md` is older than N seconds).
4. **Batch the browser too.** Every `chrome.mjs` command is a new process + HTTP `/json/list` + new
   WebSocket (20–30 ms + handshake each). A 40-field form is 40+ round trips. *Fix:* a `do <ops.json>`
   command executing an operation list on one connection.
5. **Aggregator APIs for supplements** (HN Algolia, RemoteOK, Remotive, Himalayas, We Work Remotely
   RSS) — structured JSON/RSS instead of scraping; details and ToS notes in the ATS doc.

## 4. Apply reliability (flaky-fill audit)

Ranked from the chrome.mjs audit; all confirmed by reading the code:

1. **Clicks don't scroll into view** (`chrome.mjs:285,288,397`) and `snap` includes off-screen
   elements — the most likely "click did nothing" failure on long ATS pages. *Fix:* `scrollIntoView`
   before dispatching, or filter the snapshot to the viewport.
2. **`open` waits a fixed 1500 ms** (`chrome.mjs:240`) instead of a load/ready event — too short for
   slow SPAs, wasted on fast pages. *Fix:* wait for `document.readyState`/`Page.loadEventFired` with
   a timeout fallback.
3. **Iframes are invisible** to `snap`/`fill`/`upload`/`eval` (top frame only) — iCIMS and embedded
   Workable widgets fall back to manual handling. *Fix:* walk `Page.getFrameTree` and namespace
   indexes per frame (High effort; portal docs already route around it).
4. **`fill` resolves by 6-px Euclidean distance** (`chrome.mjs:301-307`) and ignores the `id`/`name`
   the snapshot already carries — a DOM shift can fill the wrong field silently. *Fix:* prefer
   id/name match, fall back to distance; add `fill --selector`.
5. **No socket `close` handler** (`chrome.mjs:44-61`) — a closed tab hangs every pending call for the
   full 20 s. Also hard-coded timeouts everywhere (1500/400/60/700 ms, 20 s CDP). *Fix:* reject
   pending on close; expose `--timeout`.
6. **`launch` returns before port 9222 is up** (`chrome.mjs:201-203`) — the next command can fail
   spuriously. *Fix:* poll `/json/version` before printing success.
7. **Batch tab safety:** commands default to `pages[0]`, `open` ignores `--page`, `open --new` prints
   only an 8-char id, `close` closes `pages[0]` — a bad `close` can kill the wrong application
   session. *Fix:* thread `--page` through everything; return the full target id.
8. Smaller: `select` bypasses React's native setter (`chrome.mjs:365` vs `313`), `fill` dispatches no
   `blur` (validation-on-blur portals), no retry on "execution context destroyed", `wait` is
   case-sensitive, `keys` payloads are minimal for async widgets.

## 5. What we should NOT do

- Don't add real SQLite now — it fixes scaling the repo hasn't hit; items 1–3 and batching remove
  the actual measured waste first.
- Don't parallelize applications across tabs yet — the current single-tab flow is the safe one until
  `--page` plumbing lands.
- Don't chase universal iframe support before the cheap reliability fixes (1, 2, 5, 6) — those are
  the ones that fail today on ordinary Greenhouse/Ashby/Workday forms.

## Sources

- Anthropic, *Skill authoring best practices* — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- ATS/board API reference with live-verified endpoints — [skills/job-finder/reference/ats-apis.md](skills/job-finder/reference/ats-apis.md)
- Script audit measurements: live `~/.job-search` store, 2026-09-15 (220 roles, `data.json` 165 KB,
  `applications.md` 41 KB); benchmarks on Node 24, macOS.
