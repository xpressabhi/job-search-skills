# Jev judgments — when code needs semantic understanding

`scripts/jev.mjs` routes every language-understanding decision in both skills
through Jev (TypeSafe System One: typed `Noul`/`Choice`/`Score` answers with
calibrated probabilities). Deterministic checks stay in code and never call
Jev: comp floor (numeric), URL dedupe (`tracker seen`), portal detection (URL
regex), tab management.

Requires `TYPESAFE_API_KEY`. Without it, fall back to agent judgment and say
so in the report. Zero npm dependencies; Node 18+.

## Commands

`node <skill-dir>/scripts/jev.mjs <command>` (`apply-to-jobs` uses
`../job-finder/scripts/jev.mjs`). Args accept a file path, `-` (stdin), or
inline JSON/text. Output is JSON on stdout.

| Command | Decision it owns | Skill step |
|---|---|---|
| `eligibility --profile P --posting J` | remote/timezone/payroll/auth/relocation → `eligible`/`unverified`/`ineligible` + reasons (deterministic onsite gate first, no call when it fires) | finder §2.4, playbook §9 |
| `fit --cv C --posting J` | coverage/stack/seniority/domain scores + composite 0..1 + capped `strong`/`good`/`partial`/`weak` | finder §2.6, §3 |
| `rank --profile P --roles R.json [--limit N] [--no-history] [--lenient]` | deterministic pre-pass (free drops, Jev call skipped) → one fan-out call per survivor (eligibility + fit together) → history penalty → sorted | finder §3 |
| `liveness --page T --role J` | `live`/`dead`/`suspicious`/`unverified` | finder §2.3, playbook §9a |
| `redflags --posting J` | `fee_or_kyc_scam`, `surveillance_terms`, `bodyshop_repost` | playbook §10 |
| `same-role --a A --b B` | LinkedIn-vs-ATS duplicate check | finder §2.1, apply duplicate guard |
| `knockout --profile P --posting J [--form T]` | `knockout:true` + hits before any fill | apply §2 |
| `qa-match --question T --answers A.json` | best stored answer or `null` | apply §3 |
| `verify-submit --page T --role J` | `confirmed` / ambiguous after submit | apply §5 (OPTIMIZATIONS gap 3) |
| `applied-guard --page T` | already-applied banner check | apply duplicate guard |
| `selftest` | offline checks, no key needed | — |

Browser actions use the **jev-browser loop** (apply-to-jobs): `chrome.mjs decide` builds the
observed action space and asks Jev for the next `operation` + `target`; `chrome.mjs do`
executes exactly that target (or the same request goes to the `jev_decide` MCP tool).
See `apply-to-jobs/portals/_common.md` § Deciding what to click.

Prefer `rank` over per-role `eligibility`+`fit` (one call per role, questions
run in parallel). Prefer `eligibility`+`fit` over asking Jev "is this a good
role?" — broad questions hide judgments; atomic ones compose in code.

## Reading answers

- `Noul` ≥ 0.7 yes · ≤ 0.3 no · between = uncertain (not "medium").
- `Choice`/`Score` carry `confidence`; below 0.5 do not act (`qa-match`
  returns `match_index:-1`, rank treats low-confidence fits as `unverified`).
- `eligibility` hard fails: `location_eligible` or `auth_ok` ≤ 0.3 →
  `ineligible`. Anything < 0.7 → `unverified`, ranked below `eligible`.
- `fit` composite = 0.40·coverage + 0.25·stack + 0.20·seniority + 0.15·domain
  (scores are 0..3). Coverage is heaviest: a title match with no evidenced
  must-haves can never outrank a covered partial fit.
  Labels: ≥0.75 strong · ≥0.55 good · ≥0.35 partial · else weak.
- Hard gates (fail = `ineligible`, role dropped): `track_ok` ≤ 0.3 (management/
  strategy/sales track vs IC candidate or vice versa); **level band below/above the
  candidate** (model Choice `level_match` + a code backstop that catches obvious
  lower rungs: associate, engineer II/III, junior, graduate — staff/principal/lead
  titles exempt); `requirement_coverage` < 1.5 (a named core requirement missing);
  deterministic onsite gate (office-bound role in a non-candidate metro,
  relocation rejected — decided in code, no call).
- Strict by default: level and stack mismatches are dropped, not surfaced — when
  the level doesn't match, comp and interviews don't either. `--lenient` restores
  soft caps (level ±2 → `partial`, coverage < 1.0 → drop) for wide-net runs.
- Soft caps (label capped at `partial`, never `good`/`strong`): `level_match` =
  `unclear` (strong→good), coverage < 2.25 (cover-most bar); with `--lenient`,
  level mismatches also cap at partial.
- Level semantics: `at` means the posting band overlaps `candidate.seniority`
  (Senior/Staff/Principal/Lead IC). Fewer stated years is NOT "below" — only an
  explicitly lower rung is. A `partial` label means "possible but not recommended";
  only `good`/`strong` level+stack matches belong in the top of a report.
- `rank` applies a −0.15 history penalty for low-yield companies (3+ applied,
  none past `applied` in the tracker) and flags them; `--no-history` opts out.
- `knockout:true` (any hit ≥ 0.7) → do NOT fill/submit → `awaiting_user`.
  Uncertain hits → surface to the user, never auto-submit past them.
- `verify-submit` `confirmed` needs ≥ 0.8; 0.4–0.8 is ambiguous → record
  `awaiting_user` with the page evidence, not `queue complete`.

Thresholds are starting points. If verdicts disagree with hired outcomes,
retune the numbers here — never rewrite a question to chase one role.

## Eval

`evals/rejection-eval.json` holds 10 real mismatches (must drop) + 8 real fits
(must keep) from tracker history; `node evals/run.mjs` checks ≥90% on both.
Re-run after any question, weight, or threshold change.

## Privacy

`jev.mjs` redacts profiles before send: years, headline, seniority, titles,
skills, industries, modes, cities, countries, remote scope, timezone budget,
relocation/auth/sponsorship flags, salary floor. **Never** name, email, phone,
or links. Posting/page text is truncated to ~6000 chars. Never paste full CV
text — pass the derived `targets`/`identity` fields or a skills summary.

## Cost

~300–800 input tokens per judgment (~$0.00003); `rank` on 100 roles ≈ $0.01.
Output tokens are free. Pack independent questions into one call.
