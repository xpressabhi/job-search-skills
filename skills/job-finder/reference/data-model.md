# Data model & tracker reference

Everything lives in `JOB_SEARCH_HOME` (default `~/.job-search/`), never in the repo:

```
~/.job-search/
  profile.json        # onboarding output — user profile + search preferences
  data.json           # roles, statuses, history, notes, Q&A bank, apply queue (source of truth)
  companies.json      # learned sweep targets + ignored companies (with reasons)
  applications.md     # auto-generated human view of data.json (never edit by hand)
  reports/            # archived search reports (tracker report save)
  cv/                 # optional copies of the user's CV
```

## Commands

Tracker: `node <skill-dir>/scripts/tracker.mjs <command>` (skill dir = where this skill is installed).

| Command | What it does |
|---|---|
| `init` | Create the store, print paths |
| `stats` | Status counts, answers, open queue rows |
| `seen <url> <company> <title> [--mode --location --salary --posted --source]` | Dedupe check + record. Prints `NEW` (exit 0) or `ALREADY SEEN` (exit 1) |
| `add-batch <file.json\|->` | Bulk-add roles (JSON array; same dedupe) |
| `mark <status> <id\|url\|company\|title\|"company:title"> [--note text]` | Set pipeline status |
| `note <key> <text>` | Append a timestamped note |
| `role <key>` | Print one role as JSON |
| `list [--status S] [--limit N] [--all] [--json]` | Recent roles, newest first |
| `company list [--json]` | Learned sweep targets + ignored companies |
| `company add <name> <portal> [--ats X] [--note …]` | Remember a discovered company for future sweeps |
| `company ignore <name> [--reason …]` | Add to the ignore list, remove from learned, mark its open roles `not_interested` (open apply rows aborted) |
| `company unignore <name>` | Remove from the ignore list |
| `company candidates [--min N]` | Companies with N+ declined roles (default 2) — the offer-to-ignore signal |
| `company verify [name] [--learned --stale D --dry-run --quiet --json]` | Health-check starter + learned portals; flags dead/moved/blocked (exit 1 on dead) |
| `export` | Regenerate `applications.md` (also runs after every write) |
| `qa get\|set\|list` | Reusable application answers |
| `queue add\|fill\|list\|get\|set\|step\|complete` | Apply-run state (see below) |
| `profile import\|show\|get\|set\|path` | Profile read/write (dot-paths work) |
| `report save <file.md> [label]` | Archive a report under `reports/` |
| `import-sqlite <jobs.db> [--queue]` | One-time migration from the old SQLite tracker |
| `selftest` | Exercise the whole CLI in a temp home |

Exit codes: `0` success · `1` "already seen" / no QA match · `2` usage or lookup error (message on stderr).

## Role statuses

Pipeline: `shown → interested → applied → oa → phone → onsite → offer → accepted`
Terminal: `rejected` · `withdrew` · `not_interested` · `expired`

- `shown` = surfaced in a report, user hasn't picked it up
- `interested` = user wants it; **only status that may be re-surfaced in a report**
- Everything else (including `shown`) is never re-reported — dedupe is the memory
- `applied_at` is set automatically on the first move to `applied`

## Apply queue

Tracks one application attempt per role (`queued → filling → awaiting_user → applied | skipped | failed | aborted`):

1. `queue add <roleId>` (single) or `queue fill --status interested [--limit N]` (batch)
2. `queue step <id> "<progress>"` while working
3. Blocked on captcha/login/consent/knockout → `queue set <id> awaiting_user "<exact blocker>"`
4. Success → `queue complete <roleId> <queueId> "<portal> submit"`

## Company memory

Two local lists keep sweeps from re-crawling the same ground:

- **Learned** (`companies.json → learned`): companies discovered mid-search that are worth sweeping
  again (`company add`). Future runs sweep `reference/companies.md`, then these.
- **Ignored** (`companies.json → blocked`, with reasons; mirrored as plain names into
  `profile.search.company_rules.exclude_companies`): never swept or surfaced, and `seen` warns on
  stderr if a role from one slips through. `company ignore` also marks its `shown`/`interested` roles
  `not_interested` and aborts their open apply rows. `company unignore` removes the list entries only
  — role statuses are left as they are.

`company candidates --min N` surfaces companies with N+ declined roles — the signal for the agent to
offer ignoring them (SKILL.md Step 5). `company verify` probes every starter + learned portal (plus
the Ashby/Greenhouse/Lever board API where one exists — that catches dead boards that still render a
page) and records the outcome in `companies.json → verified`; results also surface in `company
list`. `--stale D` limits a run to entries not verified in D days — the learned-aging check.

## profile.json shape (all fields optional; defaults applied on import)

```json
{
  "identity": { "name": "", "email": "", "phone": "", "location": "", "country": "",
                "links": { "linkedin": "", "github": "", "portfolio": "", "website": "" },
                "years_experience": null, "headline": "" },
  "cv": { "path": "", "stored_path": "", "text_path": "", "resume_filename": "" },
  "targets": { "seniority": [], "titles": [], "skills": [], "industries": [], "summary": "" },
  "search": {
    "modes": ["remote", "hybrid", "onsite"],
    "cities": [], "countries": [], "remote_scope": [],
    "relocation": false,
    "timezone": { "max_offset_hours": null, "notes": "" },
    "salary": { "currency": "USD", "full_time_min": null, "full_time_target": null,
                "local_currency": "", "local_min": null, "local_target": null, "contract_min": null },
    "company_rules": { "product_only": true, "exclude_types": ["consultancy","staffing","bodyshop"], "exclude_companies": [] },
    "freshness_days": 7, "notes": ""
  },
  "apply": { "work_authorization": "", "sponsorship_required": false, "notice_period": "",
             "willing_to_relocate": false, "pronouns": "", "eeoc": "decline",
             "keychain_service": "job-search-apply", "extra": {} },
  "company_list_urls": [],
  "answers": [ { "question": "…", "answer": "…", "category": "…" } ]
}
```

Reading a field: `tracker profile get search.salary.full_time_min`. Prefer this over parsing profile.json by hand.

## data.json shape (machine-managed — prefer the CLI over editing)

```json
{
  "version": 1,
  "roles": [ { "id": 1, "url": "…", "company": "…", "title": "…", "mode": "remote",
               "location": "…", "salary": "…", "posted_at": "YYYY-MM-DD", "source": "…",
               "status": "shown", "score": null, "first_seen_at": "…", "last_seen_at": "…",
               "applied_at": null,
               "notes": [ { "at": "…", "text": "…" } ],
               "history": [ { "at": "…", "status": "shown" } ] } ],
  "answers": [ { "question": "…", "answer": "…", "category": "…", "updated_at": "…" } ],
  "queue": [ { "id": 1, "role_id": 1, "portal": "greenhouse", "status": "queued",
               "message": "", "step": "", "created_at": "…", "updated_at": "…" } ]
}
```

Dedupe keys: exact URL first (trailing slash ignored), then normalized `company + title`.
