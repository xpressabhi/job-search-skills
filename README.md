# job-search-skills

Two agent skills that run your entire job search — and keep everything on your machine.

- **`job-finder`** — interviews you once to build a profile, sweeps your target companies and job
  boards, filters roles by what you can actually get (remote eligibility, timezone, comp floor,
  exclusions), ranks by CV fit, and remembers every role so nothing is ever surfaced twice.
- **`apply-to-jobs`** — drives your own Chrome to autofill and submit ATS applications (Ashby,
  Greenhouse, Lever, Workable, iCIMS, Workday, SmartRecruiters, Microsoft, LinkedIn including Easy
  Apply, company portals), pausing for you only on captchas, logins, consent walls, or knockout
  mismatches — and checking for prior applications first so nothing is ever submitted twice.
- **a Jev decision layer** — every semantic judgment (eligibility, fit, liveness, duplicates, form
  answers) is a typed answer with a calibrated confidence from [Jev](https://typesafe.ai), a TypeSafe
  System One model — uncertain stays uncertain, and nothing is invented to fill a report.

No server, no account, no external apply service. Profile, tracker, notes, and CV stay in
`~/.job-search/`; if you set `TYPESAFE_API_KEY`, the only thing that leaves the machine is Jev's
redacted judgment input — years, skills, regions, posting text — never your name, email, phone, or links.

## Install

```bash
npx skills add xpressabhi/job-search-skills -s job-finder -s apply-to-jobs -a '*' -g -y
```

`-g` installs for your user (all projects), `-a '*'` targets every agent it can detect (Claude Code,
Codex, OpenCode, Cursor, …), `-y` skips the symlink/copy prompt (symlink is the recommended default —
one canonical copy that `npx skills update` refreshes; add `--copy` instead if symlinks aren't your
thing). `apply-to-jobs` expects `job-finder` — install both.

<details>
<summary>Manual install (no npx)</summary>

```bash
git clone https://github.com/xpressabhi/job-search-skills
ln -s "$PWD/job-search-skills/skills/job-finder"    ~/.agents/skills/job-finder
ln -s "$PWD/job-search-skills/skills/apply-to-jobs" ~/.agents/skills/apply-to-jobs
# repeat into ~/.claude/skills, ~/.codex/skills, ~/.config/opencode/skills as needed
```
</details>

## Updating

```bash
npx -y skills update -g -y     # refresh global installs
```

<details>
<summary>Auto-update in OpenCode</summary>

Save to `~/.config/opencode/plugins/skills-update.js` — runs on every session start:

```js
export const SkillsUpdate = async ({ $ }) => ({
  event: async ({ event }) => {
    if (event.type === "session.created") await $`npx -y skills update -g -y`.quiet().nothrow()
  },
})
```
</details>

Clone+symlink installs (manual install above) just need `git pull`; other agents can cron
`0 9 * * * npx -y skills update -g -y`.

## Start free with OpenCode

You can run both skills for free with [OpenCode](https://opencode.ai): install it, `/connect` to
OpenCode Zen, and pick any `*-free` model with `/models` — a $0 setup.

When the free models aren't enough, [OpenCode Go](https://opencode.ai/go?ref=0NM6X94JBD) gets you
more tokens on open coding models for $10/month (referral link).

## First run

Just say **"find me jobs"** (or "set up my job search"). The first run asks for your **CV — a local
file or URL** — parses it, shows you what it found (name, contact, links, years, titles, skills) for
you to correct, then asks only the questions the CV can't answer: target roles, locations and work
modes, salary floor, dealbreakers. That becomes your profile. Everything after that is
profile-driven: one-line requests like "any new remote jobs?" or "who's hiring in Berlin?" just work.

Then say **"apply to role 214"** or **"apply to all interested"** to run applications.

## The decision layer: Jev

The skills don't guess. Every language-understanding decision — is this posting live, can you work
there, how well does it fit, is this the same job, has this question already been answered — is one
[Jev](https://typesafe.ai) call that returns a *typed* answer with a calibrated confidence, in well
under a second:

- **Uncertain stays uncertain.** A verdict below the confidence bar is reported as `unverified` or
  `partial`, never rounded up to a yes — that's what makes the report trustworthy.
- **Nothing is invented.** Answers are fixed types (yes/no/choice/score) with no free text to go off
  the rails — no hallucinated verdicts and no invented form answers.
- **Measured against your own rejections.** `evals/` replays real mismatches and real fits from your
  tracker history through the matcher, with a 90%-drops / 90%-keeps bar.
- **Private by construction.** Profiles are redacted before every call: years, seniority, skills,
  regions only.

`TYPESAFE_API_KEY` turns it on (early access at [typesafe.ai](https://typesafe.ai)). Without a key
the skills fall back to the agent's own judgment and say so — everything else still works.

## Where your data lives

```
~/.job-search/
  profile.json       your profile: identity, CV path, targets, comp floor, exclusions, answers
  data.json          every role seen, its status, notes and history (the source of truth)
  companies.json     learned sweep list + ignored companies (never crawled again)
  applications.md    auto-generated human-readable tracker — open it in any editor
  reports/           saved search reports
  cv/                optional copy of your CV for stable uploads
  chrome-profile/    dedicated Chrome profile for applications (log in to sites once)
```

Nothing is ever written into this repo. Back it up by making `~/.job-search/` its own git repo or
including it in your backups — delete it and your tracker history is gone.

Status lifecycle per role:
`shown → interested → applied → oa → phone → onsite → offer → accepted`,
with terminal states `rejected`, `withdrew`, `not_interested`, `expired`.

The skills drive the tracker for you; if you ever want it directly,
`node <skill-dir>/scripts/tracker.mjs help` lists the CLI.

## Requirements

- Node 18+ (to install and run the tracker)
- Node 22+ for `apply-to-jobs` — its Chrome helper uses the built-in WebSocket; with older Node use
  the `chrome-devtools` MCP tools instead
- Chrome for applications (the helper can launch it with a dedicated profile:
  `node skills/apply-to-jobs/scripts/chrome.mjs launch`)
- `TYPESAFE_API_KEY` for the Jev decision layer — optional; without it the skills fall back to the
  agent's own judgment and note it in the report
- macOS Keychain is optional — only if you preconfigure credentials for login-walled portals

## How the skills stay honest

- Never re-surfaces a role you've already seen (`applied`/`rejected`/`shown` are permanent memory;
  only `interested` roles may come back)
- Never re-crawls or re-surfaces an ignored company — pass on enough roles from one and it offers to
  ignore the company outright; companies you discover can be added to the sweep list for next time
- Never trusts a rotting board — `company verify` health-checks every starter + learned portal
  (dead/moved/blocked) and re-checks learned entries older than 90 days
- Never fabricates an answer: unknown required form questions pause the run and are stored for next time
- Never dresses up a judgment: every Jev answer carries a calibrated confidence, and a below-bar
  verdict is reported as `unverified` — not sold as a match
- Never stretches your CV to fit a role — partial fits are labeled as such
- Never reports an aggregator link when the real posting is on the company's own ATS

## License

MIT — see [LICENSE](LICENSE).
