# Role spec & scoring reference

## Store layout (`TALENT_HOME`, default `~/.talent-search/`)

```
~/.talent-search/
  store.json    # roles + candidates (source of truth, machine-managed)
  reports/      # saved shortlists (never overwritten — -2 suffix)
```

## Role shape

```json
{
  "id": 1, "title": "Principal Software Engineer — Full-stack Lead",
  "client": "SS&C", "location": "Hyderabad", "mode": "onsite",
  "min_years": 10, "floor": null, "currency": "INR",
  "must": ["Java", "Spring Boot", "Angular 16+", "TypeScript", "relational DB"],
  "nice": ["fintech", "Kubernetes", "AWS", "AI tooling", "OSS"],
  "lead_required": true, "no_unsolicited": true,
  "notes": "R43593; requested-channel only",
  "created_at": "…"
}
```

`role add` flags: `--title --client --location --mode --min-years --floor --currency --must "a;b;c" --nice "a;b" [--lead/--no-lead] [--no-unsolicited] [--notes]`.

## Candidate shape

```json
{
  "id": 1, "name": "…", "email": null, "linkedin": null,
  "location": "Hyderabad", "years": 11, "stack": "Java;Angular",
  "text": "CV or pasted profile text", "source": "private-pool|manual",
  "status": "new", "notes": [], "first_seen_at": "…", "last_seen_at": "…"
}
```

Statuses: `new → shortlisted → contacted → screening → submitted → placed`; terminal `rejected`/`withdrew`/`not_interested`/`duplicate`. Match considers `new`/`shortlisted` only.

Dedupe (in order): normalized email → canonical LinkedIn URL (lowercased host, no query/hash/trailing slash) → normalized name. Duplicates update `last_seen_at` and exit 1 — existing rows are never merged or deleted.

## Scoring (transparent, textual)

For each eligible candidate against the role:

- Must-have hit (case-insensitive substring in `stack + text`): **+2** each. Missing = named gap.
- Nice-have hit: **+1** each.
- Years ≥ floor: **+2**. Unknown: 0 + `unverified` flag. Below floor: knockout, skipped with count.
- Lead evidence (`/led |tech lead|managed |mentored|team of \d+/i`) when `lead_required`: **+2**, else `no lead evidence` flag.
- Location contains role location (either direction): **+1**, else `location` flag (not a knockout unless role notes say strict).

Verdicts: all must hit = `fit`; ≥70% must hit = `partial fit (<first gap>)`; below = `stretch (<first gap>)`. Knockouts never appear in the table — only in skip lines.

## Commands

| Command | What it does |
|---|---|
| `init` | Create the store, print paths |
| `role add …` | Add a role spec |
| `role list [--json]` / `role show <id>` | List / print one role |
| `ingest <folder>` | Add one candidate per `.md`/`.txt` file (name = first `#` heading or filename) |
| `candidate add …` | Manually add one pasted profile |
| `candidate list [--status S] [--json]` | List candidates |
| `match <roleId> [--limit N]` | Ranked shortlist + skip lines, saves report |
| `status <id> <status> [--note …]` | Advance a candidate |
| `note <id> <text>` | Append a timestamped note |
| `export` | Regenerate `talent.md` on demand only (never on every write) |
| `selftest` | Built-in tests in a temp home |

Exit codes: `0` success · `1` already seen / no match · `2` usage or lookup error (stderr).
