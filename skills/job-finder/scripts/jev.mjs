#!/usr/bin/env node
// jev.mjs — Jev (TypeSafe System One) judgments for job-finder + apply-to-jobs.
//
// Zero dependencies; Node 18+. Requires TYPESAFE_API_KEY for live calls.
// Every decision the skills take through language understanding has a
// subcommand here; deterministic checks (comp floor, URL dedupe, portal
// regex) stay in code and are NOT sent to Jev.
//
//   job-finder:  eligibility · fit · rank · liveness · redflags · same-role
//   apply-to-jobs: knockout · qa-match · verify-submit · applied-guard
//
// Privacy: profiles are redacted before send (years/skills/regions only —
// never name, email, phone, or links). Posting/page text is truncated.
// See ../reference/jev.md for questions, thresholds, and fallback rules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = process.env.JEV_MODEL || 'jev-latest';
const MAX_TEXT = 6000;

const fail = (msg, code = 2) => { console.error(`error: ${msg}`); process.exit(code); };
const warn = (msg) => console.error(`warn: ${msg}`);

function getKey() {
  const k = (process.env.TYPESAFE_API_KEY || '').trim();
  if (!k) fail('TYPESAFE_API_KEY is not set. Export it, or fall back to agent judgment (see reference/jev.md).');
  return k;
}

// ---------------------------------------------------------------- IO helpers

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// --opt <value>: value may be a file path, '-' (stdin), or inline text/JSON.
function readOpt(val) {
  if (val === undefined) return undefined;
  if (val === '-') return readStdin();
  if (typeof val === 'string' && val.length < 4096) {
    try {
      if (fs.existsSync(val) && fs.statSync(val).isFile()) return fs.readFileSync(val, 'utf8');
    } catch { /* fall through to inline */ }
  }
  return val;
}

function asJson(val, what) {
  if (val === undefined) fail(`missing ${what}`);
  try { return JSON.parse(val); }
  catch { fail(`${what} is not valid JSON`); }
}

function asText(val, what) {
  if (val === undefined) fail(`missing ${what}`);
  return String(val);
}

const trunc = (s, n = MAX_TEXT) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s;
};

// Strip everything that identifies the user. Only capability + location
// facts reach Jev — never name, email, phone, or profile links.
function redactProfile(p = {}) {
  p = p && typeof p === 'object' ? p : {};
  const ident = p.identity || {};
  const targets = p.targets || {};
  const search = p.search || {};
  const apply = p.apply || {};
  return {
    years_experience: ident.years_experience ?? null,
    headline: ident.headline || '',
    seniority: targets.seniority || [],
    titles: targets.titles || [],
    skills: targets.skills || [],
    industries: targets.industries || [],
    modes: search.modes || [],
    cities: search.cities || [],
    countries: search.countries || [],
    remote_scope: search.remote_scope || [],
    timezone_max_offset_hours: search.timezone?.max_offset_hours ?? null,
    relocation_ok: Boolean(search.relocation || apply.willing_to_relocate),
    work_authorization: apply.work_authorization || '',
    sponsorship_required: Boolean(apply.sponsorship_required),
    salary_min: search.salary?.full_time_min ?? null,
    salary_currency: search.salary?.currency || '',
  };
}

// ---------------------------------------------------------------- Jev client

async function systemOne(state, questions, { model = DEFAULT_MODEL, timeoutMs = 60000 } = {}) {
  const key = getKey();
  const body = JSON.stringify({ model, state, questions });
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 529) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const wait = Math.min((retryAfter || (500 * 2 ** attempt)), 10000);
        warn(`jev ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/4)`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401) fail('jev 401 Unauthorized — check TYPESAFE_API_KEY.');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        fail(`jev ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      if (!data || typeof data.answers !== 'object') fail('jev returned no answers object.');
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err?.name === 'AbortError') fail('jev request timed out.');
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  fail(`jev request failed after retries: ${lastErr?.message || lastErr}`);
}

// ---------------------------------------------------------------- verdicts
// Thresholds are starting points — tune against labeled outcomes
// (see reference/jev.md). Noul: >=0.7 yes, <=0.3 no, else uncertain.

const YES = 0.7, NO = 0.3;

function eligibilityVerdict(a) {
  const g = (id) => a[id]?.noul;
  const reasons = [];
  for (const [id, label] of [
    ['location_eligible', 'location'], ['auth_ok', 'work-auth'],
    ['timezone_ok', 'timezone'], ['payroll_ok', 'payroll'], ['relocation_ok', 'relocation'],
  ]) {
    const v = g(id);
    if (v === undefined) continue;
    if (v <= NO) reasons.push(`${label} fails (${v.toFixed(2)})`);
    else if (v < YES) reasons.push(`${label} uncertain (${v.toFixed(2)})`);
  }
  let verdict = 'eligible';
  if (g('location_eligible') <= NO || g('auth_ok') <= NO) verdict = 'ineligible';
  else if (Object.values(a).some((x) => x && typeof x.noul === 'number' && x.noul < YES)) verdict = 'unverified';
  return { verdict, reasons };
}

function fitLabel(composite) {
  if (composite >= 0.75) return 'strong';
  if (composite >= 0.55) return 'good';
  if (composite >= 0.35) return 'partial';
  return 'weak';
}

// Scores are 0..3 (four levels); normalize to 0..1 then weight.
// requirement_coverage is heaviest: a title match with no evidenced
// must-haves must never outrank a covered partial fit.
function fitComposite(coverage, stack, seniority, domain) {
  return 0.40 * (coverage / 3) + 0.25 * (stack / 3)
       + 0.20 * (seniority / 3) + 0.15 * (domain / 3);
}

// Guardrails: track fails and near-zero coverage drop the role; level
// mismatches and thin coverage cap the label at partial (never good/strong).
function applyFitGates(composite, label, gates) {
  const reasons = [];
  if (gates.track_ok !== undefined && gates.track_ok <= NO) {
    return { verdict: 'ineligible', label: 'weak', composite: 0, reasons: [`track mismatch (${gates.track_ok.toFixed(2)})`] };
  }
  if (gates.coverage !== undefined && gates.coverage < 1.0) {
    return { verdict: 'ineligible', label: 'weak', composite: 0, reasons: [`zero requirement coverage (${gates.coverage.toFixed(2)})`] };
  }
  let capped = label;
  if (gates.level_ok !== undefined && gates.level_ok <= NO) {
    capped = 'partial';
    reasons.push(`level mismatch (${gates.level_ok.toFixed(2)})`);
  }
  if (gates.coverage !== undefined && gates.coverage < 2.0 && (capped === 'strong' || capped === 'good')) {
    capped = 'partial';
    reasons.push(`thin requirement coverage (${gates.coverage.toFixed(2)})`);
  }
  return { verdict: null, label: capped, composite, reasons };
}

// Deterministic onsite/hybrid gate (code, not Jev): an office-bound role in a
// city outside the candidate's cities with relocation rejected is ineligible
// by rule — no model call needed. Only fires when the location names a
// specific non-candidate metro; bare country/region ("India") stays with Jev.
const METROS = ['delhi', 'ncr', 'noida', 'gurugram', 'gurgaon', 'mumbai', 'pune',
  'bangalore', 'bengaluru', 'chennai', 'hyderabad', 'kolkata', 'ahmedabad', 'kochi',
  'jaipur', 'lucknow', 'chandigarh', 'indore', 'coimbatore', 'bhubaneswar',
  'san francisco', 'new york', 'austin', 'seattle', 'boston', 'chicago', 'london',
  'berlin', 'amsterdam', 'dublin', 'singapore', 'tokyo', 'sydney', 'toronto'];
const normCity = (s) => String(s || '').toLowerCase().replace(/bengaluru/g, 'bangalore').replace(/gurgaon/g, 'gurugram');
function onsiteGate(candidate, role) {
  const mode = String(role.mode || '').toLowerCase();
  if (!/on-?site|hybrid/.test(mode) || /remote/.test(mode)) return null;
  if (candidate.relocation_ok) return null;
  const loc = normCity(role.location || '');
  if (!loc) return null;
  const home = (candidate.cities || []).map(normCity).filter(Boolean);
  if (home.some((c) => loc.includes(c))) return null;
  const foreign = METROS.filter((m) => loc.includes(m) && !home.some((c) => c.includes(m) || m.includes(c)));
  if (!foreign.length) return null;
  return `office-bound in ${foreign[0]} — outside candidate cities, relocation rejected`;
}

// Low-yield companies from the tracker's own history: 3+ applications,
// none ever past `applied`. Same rule as tracker.mjs lowYieldCompanies.
function lowYieldSet(homeDir) {
  try {
    const home = homeDir || process.env.JOB_SEARCH_HOME || path.join(os.homedir(), '.job-search');
    const data = JSON.parse(fs.readFileSync(path.join(home, 'data.json'), 'utf8'));
    const by = new Map();
    for (const r of data.roles || []) {
      const key = String(r.company || '').trim().toLowerCase();
      if (!key) continue;
      if (!by.has(key)) by.set(key, { applied: 0, advanced: 0 });
      const e = by.get(key);
      if (r.applied_at || ['applied', 'oa', 'phone', 'onsite', 'offer', 'accepted'].includes(r.status)) e.applied += 1;
      if (['oa', 'phone', 'onsite', 'offer', 'accepted'].includes(r.status)) e.advanced += 1;
    }
    return new Set([...by.entries()].filter(([, e]) => e.applied >= 3 && e.advanced === 0).map(([k]) => k));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------- questions

const Q = {
  eligibility: (cand) => ({
    location_eligible: {
      type: 'noul',
      instructions: `Does \`posting.posting_text\` show the role can hire in the candidate's countries (\`candidate.countries\`) or remote scope (\`candidate.remote_scope\`)? Judge the posting's location scope, not the company's HQ.`,
      criteria: {
        true: 'Posting lists worldwide, the candidate country/region, or remote within an eligible region',
        false: 'Posting restricts to other countries (e.g. US-only, EU-only) or requires work authorization the candidate lacks',
      },
    },
    timezone_ok: {
      type: 'noul',
      instructions: `Is the posting's required timezone overlap compatible with a candidate allowing max \`candidate.timezone_max_offset_hours\` hours difference? Absent any timezone demand, answer yes.`,
      criteria: {
        true: 'No timezone demand, async-friendly, or overlap within the allowed offset',
        false: 'Locks core hours to a far timezone with no async flexibility',
      },
    },
    payroll_ok: {
      type: 'noul',
      instructions: 'Does `posting.posting_text` offer a payroll path for the candidate country — local entity, EOR (Deel/Remote/Oyster/Multiplier/Skuad/Papaya), or contractors-globally? Absent contrary signals, lean yes.',
      criteria: {
        true: 'Entity, EOR, or global-contractor path present or nothing contradicting it',
        false: 'Explicitly no entity/EOR for the candidate country, local-currency-only anomalies, sanctioned jurisdictions',
      },
    },
    auth_ok: {
      type: 'noul',
      instructions: `Given candidate work authorization \`candidate.work_authorization\` (sponsorship required: \`candidate.sponsorship_required\`), does \`posting.posting_text\` permit this candidate? A generic "must be authorized" with no country lock is not a fail.`,
      criteria: {
        true: 'No blocking authorization demand, or sponsorship offered when needed',
        false: 'Hard requirement the candidate fails (e.g. US-citizen-only, no sponsorship when required)',
      },
    },
    relocation_ok: {
      type: 'noul',
      instructions: `Candidate relocation_ok is \`candidate.relocation_ok\`. Does \`posting.posting_text\` force a relocation the candidate rejects? Fully remote roles always pass. If the posting says nothing about relocation, answer yes (near 1): silence means no forced relocation.`,
      criteria: {
        true: 'Remote, no relocation mentioned, no forced relocation, or candidate accepts relocation',
        false: '"Remote now, relocate later" or relocation-required while the candidate rejects it',
      },
    },
  }),
  fit: () => ({
    requirement_coverage: {
      type: 'score',
      instructions: 'What fraction of the posting MUST-HAVE requirements (named skills, years, credentials, domain experience stated as required) is evidenced in `candidate` (skills, years_experience, headline, titles)? Judge evidenced must-haves only — nice-to-haves do not count.',
      criteria: [
        'None of the must-haves evidenced in the candidate profile',
        'A minority covered; a named core requirement is missing',
        'Most must-haves covered; gaps are learnable tooling or adjacent experience',
        'All must-haves evidenced directly in the candidate profile',
      ],
    },
    seniority_match: {
      type: 'score',
      instructions: 'How does the posting seniority demand compare to the candidate level in `candidate` (years, headline, seniority, titles)?',
      criteria: [
        'Clear mismatch: posting demands a level the candidate has not reached, or far below (would be a demotion)',
        'Stretch: candidate is close but missing a level or a stated year requirement',
        'Good: levels align, minor gaps only',
        'Strong: candidate level meets or slightly exceeds the ask with matching titles',
      ],
    },
    stack_match: {
      type: 'score',
      instructions: 'How much of the posting required stack appears in `candidate.skills` and `candidate.headline`?',
      criteria: [
        'Core required skills absent from the candidate profile',
        'Some overlap but a named core requirement is missing (name the gap in code from skill lists)',
        'Most required skills present, gaps are learnable tooling',
        'Required stack squarely covered by candidate skills and headline',
      ],
    },
    domain_match: {
      type: 'score',
      instructions: 'How well does the posting domain/team match `candidate.industries` and `candidate.titles`?',
      criteria: [
        'Unrelated domain with no transferable signal',
        'Adjacent domain, transferable but not direct',
        'Same function, different industry, or matching industry with adjacent function',
        'Direct domain and function match',
      ],
    },
    track_ok: {
      type: 'noul',
      instructions: 'Is `posting` on the candidate track in `candidate.titles`? A people-management (Engineering Manager, Director, VP), strategy, or sales-quota role fails an IC engineering candidate, and vice versa. "Tech Lead" without reports and listed target titles pass.',
      criteria: {
        true: 'Same track: IC engineering vs IC, management vs management, or a listed target title',
        false: 'Different track: management/strategy/sales-quota role for an IC candidate or vice versa',
      },
    },
    level_ok: {
      type: 'noul',
      instructions: 'Is the posting level within the candidate band in `candidate` (years_experience, seniority)? More than about one level above (unreachable stretch) or below (demotion, e.g. mid-level/III posting for a Staff+ candidate) fails.',
      criteria: {
        true: 'Within about one level of the candidate band',
        false: 'Two or more levels above or below the candidate band',
      },
    },
  }),
  liveness: () => ({
    is_expired: {
      type: 'noul',
      instructions: 'Does `page.page_text` say the posting no longer accepts applications ("no longer accepting", "position filled", "posting removed", "job no longer available")?',
      criteria: {
        true: 'Explicit filled/removed/closed language about this posting',
        false: 'Live application form, Apply button, or ordinary job description',
      },
    },
    is_wrong_role: {
      type: 'noul',
      instructions: 'Does `page.page_text` show a DIFFERENT role than `page.expected_title` at `page.expected_company` (redirect to careers home, search page, or another job)? Minor wording differences do not count.',
      criteria: {
        true: 'Bounced to listing index, homepage, or a clearly different job',
        false: 'Same role (fuzzy title/company wording is fine)',
      },
    },
    looks_suspicious: {
      type: 'noul',
      instructions: 'Does `page.page_text` show scam signals: application/verification fees, no employer name, recruiter-only contact with no company site, Telegram/Discord-only hiring, crypto/token-only pay?',
      criteria: {
        true: 'One or more concrete scam signals present',
        false: 'Named employer with a real careers presence and no fee/extortion signals',
      },
    },
  }),
  redflags: () => ({
    fee_or_kyc_scam: {
      type: 'noul',
      instructions: 'Does `posting.posting_text` request upfront/verification fees, bank details, OTP/KYC early, or token-only pay?',
      criteria: {
        true: 'Concrete fee, credential-harvest, or token-pay demand',
        false: 'Normal application process with no money-extracting demands',
      },
    },
    surveillance_terms: {
      type: 'noul',
      instructions: 'Does `posting.posting_text` demand screen-time/activity tracking, rigid far-timezone online hours, granular hour logging, or standing 6-day weeks?',
      criteria: {
        true: 'Explicit micromanagement/surveillance terms',
        false: 'No such terms',
      },
    },
    bodyshop_repost: {
      type: 'noul',
      instructions: 'Does `posting.posting_text` read as a staffing-agency repost ("via X Recruitment", "client: Confidential") rather than the hiring company itself?',
      criteria: {
        true: 'Agency/bodyshop repost markers',
        false: 'Direct hiring-company posting',
      },
    },
  }),
  knockout: () => ({
    fails_years: {
      type: 'noul',
      instructions: 'Does `posting.posting_text` or `form.form_text` state a minimum-years requirement strictly above `candidate.years_experience`?',
      criteria: {
        true: 'Named minimum clearly exceeds candidate years',
        false: 'No minimum, or candidate meets it',
      },
    },
    fails_degree: {
      type: 'noul',
      instructions: 'Does the posting/form demand a degree or credential the candidate profile does not evidence, stated as a hard requirement (not "or equivalent experience")?',
      criteria: {
        true: 'Hard credential demand the candidate fails',
        false: 'No hard demand, or equivalent-experience path exists',
      },
    },
    fails_auth: {
      type: 'noul',
      instructions: 'Does the posting/form impose a work-authorization or location rule the candidate fails (country lock, citizenship, no-sponsorship) given `candidate`?',
      criteria: {
        true: 'Concrete authorization/location block',
        false: 'No block for this candidate',
      },
    },
    fails_comp: {
      type: 'noul',
      instructions: 'Does the posting/form name a fixed salary or band whose TOP is below the candidate minimum `candidate.salary_min`? Only judge stated numbers, never estimates.',
      criteria: {
        true: 'Stated band top below candidate minimum',
        false: 'No stated numbers, or band overlaps the minimum',
      },
    },
  }),
  verifySubmit: () => ({
    applied_confirmed: {
      type: 'noul',
      instructions: 'Does `page.page_text` confirm the application for `page.expected_title` at `page.expected_company` was received ("application submitted", "we received your application", "you already applied", application dashboard showing applied)?',
      criteria: {
        true: 'Explicit submitted/received/already-applied confirmation tied to this role',
        false: 'Still on the form, error state, or generic page with no confirmation',
      },
    },
  }),
  sameRole: () => ({
    same_application: {
      type: 'noul',
      instructions: 'Do `role_a` and `role_b` describe the same application (same company and same role)? Parenthetical qualifiers like (Backend) or (Remote), LinkedIn-vs-ATS title rewrites, and URL differences do not make it a different application. Only a different seniority level, team requisition, or location counts as different.',
      criteria: {
        true: 'Same company + same role, wording/URL differences only',
        false: 'Different company, different role, or different seniority/team',
      },
    },
  }),
  appliedGuard: () => ({
    shows_applied: {
      type: 'noul',
      instructions: 'Does `page.page_text` show the candidate already applied ("Applied" badge, "you already applied", submitted-application banner)?',
      criteria: {
        true: 'Visible already-applied state',
        false: 'Fresh form with an active Submit/Apply control and no applied banner',
      },
    },
  }),
};

// ---------------------------------------------------------------- commands

async function cmdEligibility(opts) {
  const profile = asJson(readOpt(opts['--profile']), '--profile');
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const candidate = redactProfile(profile);
  const gateHit = onsiteGate(candidate, posting);
  if (gateHit) return { verdict: 'ineligible', reasons: [gateHit], deterministic: true, nouls: {}, model: null };
  const state = {
    candidate,
    posting: {
      title: posting.title || '', company: posting.company || '',
      location: posting.location || '', mode: posting.mode || '',
      posting_text: trunc(posting.posting_text || posting.text || ''),
    },
  };
  const data = await systemOne(state, Q.eligibility(candidate), { model: opts['--model'] });
  const { verdict, reasons } = eligibilityVerdict(data.answers);
  return { verdict, reasons, nouls: Object.fromEntries(
    Object.entries(data.answers).map(([k, v]) => [k, v.noul])), model: data.model };
}

async function cmdFit(opts) {
  const cvRaw = readOpt(opts['--cv']);
  let cv;
  try { cv = JSON.parse(cvRaw); } catch { cv = { text: cvRaw }; }
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const candidate = cv && typeof cv === 'object' && (cv.skills || cv.years_experience !== undefined)
    ? { years_experience: cv.years_experience ?? null, headline: cv.headline || cv.text?.slice(0, 200) || '',
        seniority: cv.seniority || [], titles: cv.titles || [], skills: cv.skills || [], industries: cv.industries || [] }
    : { text: trunc(typeof cv.text === 'string' ? cv.text : String(cvRaw)) };
  const state = {
    candidate,
    posting: { title: posting.title || '', company: posting.company || '', posting_text: trunc(posting.posting_text || posting.text || '') },
  };
  const data = await systemOne(state, Q.fit(), { model: opts['--model'] });
  const a = data.answers;
  const composite = fitComposite(a.requirement_coverage.score, a.stack_match.score,
    a.seniority_match.score, a.domain_match.score);
  const gates = { track_ok: a.track_ok.noul, level_ok: a.level_ok.noul, coverage: a.requirement_coverage.score };
  const gated = applyFitGates(composite, fitLabel(composite), gates);
  return {
    scores: { requirement_coverage: a.requirement_coverage.score,
      seniority_match: a.seniority_match.score, stack_match: a.stack_match.score, domain_match: a.domain_match.score },
    gates: { track_ok: gates.track_ok, level_ok: gates.level_ok },
    confidences: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.confidence])),
    composite: Math.round(gated.composite * 1000) / 1000, label: gated.label,
    gate_reasons: gated.reasons, model: data.model,
  };
}

async function pMap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function cmdRank(opts) {
  const profile = asJson(readOpt(opts['--profile']), '--profile');
  const roles = asJson(readOpt(opts['--roles']), '--roles');
  if (!Array.isArray(roles)) fail('--roles must be a JSON array');
  const candidate = redactProfile(profile);
  const eligQ = Q.eligibility(candidate), fitQ = Q.fit();
  const lowYield = opts['--no-history'] ? new Set() : lowYieldSet();
  const base = { id: null, url: '', company: '', title: '', verdict: 'ineligible',
    reasons: [], composite: 0, label: 'weak' };
  const results = await pMap(roles, 4, async (r) => {
    // Deterministic drops cost nothing — skip the Jev call entirely.
    const gateHit = onsiteGate(candidate, r);
    if (gateHit) {
      return { ...base, id: r.id ?? null, url: r.url || '', company: r.company || '',
        title: r.title || '', reasons: [gateHit], deterministic: true };
    }
    const state = {
      candidate,
      posting: { title: r.title || '', company: r.company || '', location: r.location || '',
        mode: r.mode || '', posting_text: trunc(r.posting_text || r.text || r.description || '') },
    };
    try {
      const data = await systemOne(state, { ...eligQ, ...fitQ }, { model: opts['--model'] });
      const a = data.answers;
      const ev = eligibilityVerdict(a);
      const composite = fitComposite(a.requirement_coverage.score, a.stack_match.score,
        a.seniority_match.score, a.domain_match.score);
      const gated = applyFitGates(composite, fitLabel(composite),
        { track_ok: a.track_ok.noul, level_ok: a.level_ok.noul, coverage: a.requirement_coverage.score });
      const reasons = [...ev.reasons, ...gated.reasons];
      let verdict = gated.verdict || ev.verdict;
      let finalComposite = gated.composite;
      const key = String(r.company || '').trim().toLowerCase();
      if (lowYield.has(key)) {
        finalComposite = Math.max(0, finalComposite - 0.15);
        reasons.push(`low-yield company (${r.company}: 3+ applied, none advanced)`);
      }
      if (verdict === 'eligible' && gated.label !== 'strong' && gated.label !== 'good'
        && a.requirement_coverage.score < 2.0) verdict = 'unverified';
      return { id: r.id ?? null, url: r.url || '', company: r.company || '', title: r.title || '',
        verdict, reasons, composite: Math.round(finalComposite * 1000) / 1000, label: gated.label };
    } catch (err) {
      return { id: r.id ?? null, url: r.url || '', company: r.company || '', title: r.title || '',
        verdict: 'unverified', reasons: [`jev error: ${err.message || err}`], composite: 0, label: 'weak' };
    }
  });
  const order = { eligible: 0, unverified: 1, ineligible: 2 };
  results.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.composite - a.composite));
  const limit = Number(opts['--limit'] || 0);
  return { model: DEFAULT_MODEL, count: results.length, roles: limit > 0 ? results.slice(0, limit) : results };
}

async function cmdLiveness(opts) {
  const pageText = trunc(asText(readOpt(opts['--page']), '--page'));
  const meta = (() => { try { return JSON.parse(readOpt(opts['--role']) || '{}'); } catch { return {}; } })();
  const state = { page: { page_text: pageText,
    expected_title: meta.title || opts['--title'] || '', expected_company: meta.company || opts['--company'] || '' } };
  const data = await systemOne(state, Q.liveness(), { model: opts['--model'] });
  const n = (id) => data.answers[id].noul;
  const verdict = n('is_expired') >= YES || n('is_wrong_role') >= YES ? 'dead'
    : n('looks_suspicious') >= YES ? 'suspicious'
    : Math.max(n('is_expired'), n('is_wrong_role'), n('looks_suspicious')) > 0.4 ? 'unverified' : 'live';
  return { verdict, nouls: Object.fromEntries(Object.entries(data.answers).map(([k, v]) => [k, v.noul])), model: data.model };
}

async function cmdRedflags(opts) {
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const state = { posting: { title: posting.title || '', company: posting.company || '',
    posting_text: trunc(posting.posting_text || posting.text || '') } };
  const data = await systemOne(state, Q.redflags(), { model: opts['--model'] });
  const flags = Object.entries(data.answers).filter(([, v]) => v.noul >= YES).map(([k]) => k);
  return { flags, nouls: Object.fromEntries(Object.entries(data.answers).map(([k, v]) => [k, v.noul])), model: data.model };
}

async function cmdKnockout(opts) {
  const profile = asJson(readOpt(opts['--profile']), '--profile');
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const formText = opts['--form'] ? trunc(asText(readOpt(opts['--form']), '--form')) : '';
  const state = { candidate: redactProfile(profile),
    posting: { title: posting.title || '', company: posting.company || '',
      posting_text: trunc(posting.posting_text || posting.text || '') },
    form: { form_text: formText } };
  const data = await systemOne(state, Q.knockout(), { model: opts['--model'] });
  const hits = Object.entries(data.answers).filter(([, v]) => v.noul >= YES).map(([k, v]) => `${k} (${v.noul.toFixed(2)})`);
  const uncertain = Object.entries(data.answers).filter(([, v]) => v.noul > NO && v.noul < YES).map(([k]) => k);
  return { knockout: hits.length > 0, hits, uncertain,
    nouls: Object.fromEntries(Object.entries(data.answers).map(([k, v]) => [k, v.noul])), model: data.model };
}

async function cmdQaMatch(opts) {
  const question = asText(readOpt(opts['--question']), '--question');
  const answers = asJson(readOpt(opts['--answers']), '--answers');
  if (!Array.isArray(answers) || answers.length === 0) fail('--answers must be a non-empty JSON array');
  const cap = answers.slice(0, 20);
  const criteria = Object.fromEntries(cap.map((a, i) => [`a${i}`, typeof a === 'string' ? a : `${a.question || ''} → ${a.answer || ''}`.slice(0, 300)]));
  criteria.none = 'No stored answer addresses the form question';
  const data = await systemOne(
    { form_question: question, stored_answers: cap.map((a, i) => ({ id: `a${i}`, text: typeof a === 'string' ? a : a })) },
    { best_match: { type: 'choice',
      instructions: 'Which stored answer (`stored_answers`) answers `form_question`? Match meaning, not wording (notice period, sponsorship, "why this role", "how did you hear" equivalents count). If none fits, pick none.',
      criteria } },
    { model: opts['--model'] });
  const ans = data.answers.best_match;
  const idx = ans.choice.startsWith('a') && ans.choice !== 'none' ? Number(ans.choice.slice(1)) : -1;
  return { match_index: ans.confidence < 0.5 ? -1 : idx, choice: ans.choice,
    confidence: ans.confidence, matched: ans.confidence >= 0.5 && idx >= 0 ? cap[idx] : null, model: data.model };
}

async function cmdVerifySubmit(opts) {
  const pageText = trunc(asText(readOpt(opts['--page']), '--page'));
  const meta = (() => { try { return JSON.parse(readOpt(opts['--role']) || '{}'); } catch { return {}; } })();
  const state = { page: { page_text: pageText,
    expected_title: meta.title || opts['--title'] || '', expected_company: meta.company || opts['--company'] || '' } };
  const data = await systemOne(state, Q.verifySubmit(), { model: opts['--model'] });
  const v = data.answers.applied_confirmed.noul;
  return { confirmed: v >= 0.8, ambiguous: v > 0.4 && v < 0.8, noul: v, model: data.model };
}

async function cmdSameRole(opts) {
  const a = asJson(readOpt(opts['--a']), '--a');
  const b = asJson(readOpt(opts['--b']), '--b');
  const data = await systemOne({ role_a: a, role_b: b }, Q.sameRole(), { model: opts['--model'] });
  return { same: data.answers.same_application.noul >= YES,
    uncertain: data.answers.same_application.noul > NO && data.answers.same_application.noul < YES,
    noul: data.answers.same_application.noul, model: data.model };
}

async function cmdAppliedGuard(opts) {
  const pageText = trunc(asText(readOpt(opts['--page']), '--page'));
  const data = await systemOne({ page: { page_text: pageText } }, Q.appliedGuard(), { model: opts['--model'] });
  return { already_applied: data.answers.shows_applied.noul >= YES, noul: data.answers.shows_applied.noul, model: data.model };
}

function cmdSelftest() {
  const checks = [];
  const ok = (name, cond) => checks.push({ name, pass: Boolean(cond) });
  // Redaction strips PII.
  const red = redactProfile({ identity: { name: 'Jane Doe', email: 'j@x.com', phone: '+1', location: 'Berlin',
    links: { linkedin: 'https://..' }, years_experience: 8, headline: 'Staff Eng' },
    targets: { skills: ['Go'] }, search: { countries: ['Germany'] }, apply: {} });
  ok('redact drops name/email/phone/links', !('name' in red) && !('email' in red) && !('phone' in red)
    && JSON.stringify(red).includes('Go') && !JSON.stringify(red).includes('Jane'));
  // Verdict math.
  ok('eligibility ineligible on location fail',
    eligibilityVerdict({ location_eligible: { noul: 0.1 }, auth_ok: { noul: 0.9 }, timezone_ok: { noul: 0.9 }, payroll_ok: { noul: 0.9 }, relocation_ok: { noul: 0.9 } }).verdict === 'ineligible');
  ok('eligibility unverified on uncertainty',
    eligibilityVerdict({ location_eligible: { noul: 0.8 }, auth_ok: { noul: 0.9 }, timezone_ok: { noul: 0.5 }, payroll_ok: { noul: 0.9 }, relocation_ok: { noul: 0.9 } }).verdict === 'unverified');
  ok('fit composite weights', Math.abs(fitComposite(3, 3, 3, 3) - 1) < 1e-9 && fitLabel(0.8) === 'strong' && fitLabel(0.2) === 'weak');
  ok('coverage dominates: zero coverage can never score well',
    fitComposite(0, 3, 3, 3) < 0.62);
  ok('track mismatch drops the role',
    applyFitGates(0.9, 'strong', { track_ok: 0.1, level_ok: 0.9, coverage: 2.5 }).verdict === 'ineligible');
  ok('zero coverage drops the role',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, coverage: 0.5 }).verdict === 'ineligible');
  ok('level mismatch caps at partial',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.1, coverage: 2.5 }).label === 'partial');
  ok('thin coverage caps strong at partial',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, coverage: 1.5 }).label === 'partial');
  const hyd = { cities: ['Hyderabad'], relocation_ok: false };
  ok('onsite gate drops Delhi onsite, no relocation',
    typeof onsiteGate(hyd, { mode: 'on-site', location: 'Delhi' }) === 'string');
  ok('onsite gate drops Bangalore/Bengaluru alias',
    typeof onsiteGate(hyd, { mode: 'onsite', location: 'Bengaluru' }) === 'string');
  ok('onsite gate drops hybrid outside cities',
    typeof onsiteGate(hyd, { mode: 'hybrid', location: 'Bangalore, India' }) === 'string');
  ok('onsite gate passes home city', onsiteGate(hyd, { mode: 'on-site', location: 'Hyderabad, India' }) === null);
  ok('onsite gate passes bare country', onsiteGate(hyd, { mode: 'hybrid', location: 'India' }) === null);
  ok('onsite gate passes remote anywhere', onsiteGate(hyd, { mode: 'remote', location: 'Delhi' }) === null);
  ok('onsite gate passes when relocation accepted',
    onsiteGate({ cities: ['Hyderabad'], relocation_ok: true }, { mode: 'on-site', location: 'Delhi' }) === null);
  // Question shapes.
  const allQ = { ...Q.eligibility({}), ...Q.fit(), ...Q.liveness(), ...Q.redflags(), ...Q.knockout(), ...Q.verifySubmit(), ...Q.sameRole(), ...Q.appliedGuard() };
  ok('all questions have type+instructions', Object.values(allQ).every((q) => q.type && q.instructions));
  ok('truncation caps state', trunc('x'.repeat(9000)).length < 7000);
  const failed = checks.filter((c) => !c.pass);
  console.log(JSON.stringify({ pass: failed.length === 0, checks: checks.map((c) => `${c.pass ? 'ok' : 'FAIL'} ${c.name}`) }, null, 2));
  if (failed.length) process.exit(1);
  if (process.env.TYPESAFE_API_KEY) console.error('note: TYPESAFE_API_KEY set — run a live command to verify the endpoint.');
  else console.error('note: TYPESAFE_API_KEY not set — live calls skipped.');
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const cmd = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > -1) opts[t.slice(0, eq)] = t.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[t] = argv[++i];
      else opts[t] = '1';
    }
  }
  return { cmd, opts };
}

const HELP = `jev.mjs — Jev judgments for job-finder + apply-to-jobs (needs TYPESAFE_API_KEY)

  eligibility --profile P --posting J      eligible|unverified|ineligible + reasons
  fit --cv C --posting J                   scores + composite 0..1 + label
  rank --profile P --roles R.json [--limit N] [--no-history]  one fan-out call per role, sorted
  liveness --page T --role J               live|dead|suspicious|unverified
  redflags --posting J                     scam/surveillance/bodyshop flags
  knockout --profile P --posting J [--form T]  true + hits before apply fills
  qa-match --question T --answers A.json   best stored answer or null
  verify-submit --page T --role J          confirmed|ambiguous after submit
  same-role --a A.json --b B.json          LinkedIn-vs-ATS duplicate check
  applied-guard --page T                   already-applied banner check
  selftest                                 offline checks (no key needed)

P/C/J/A/T: file path, '-' (stdin), or inline JSON/text. Profiles are redacted
before send; posting/page text truncated to ~6000 chars. See reference/jev.md.`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const run = {
    eligibility: cmdEligibility, fit: cmdFit, rank: cmdRank, liveness: cmdLiveness,
    redflags: cmdRedflags, knockout: cmdKnockout, 'qa-match': cmdQaMatch,
    'verify-submit': cmdVerifySubmit, 'same-role': cmdSameRole, 'applied-guard': cmdAppliedGuard,
  }[cmd];
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'selftest') { cmdSelftest(); return; }
  if (!run) fail(`unknown command '${cmd}'. Try: help`);
  const out = await run(opts);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => fail(err?.message || String(err)));
