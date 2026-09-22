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

// Level + stack strictness (the user's top rejection cause).
// Below/above-level and named-requirement-missing roles DROP by default:
// when level doesn't match, comp doesn't match, and the application dies.
// `lenient: true` (rank --lenient) restores the old soft caps.
const MIN_COVERAGE_DROP = 1.5;   // a named core requirement missing → drop
const MIN_COVERAGE_FULL = 2.25;  // cover-most bar for a clean good/strong

function applyFitGates(composite, label, gates, { lenient = false } = {}) {
  const reasons = [];
  if (gates.track_ok !== undefined && gates.track_ok <= NO) {
    return { verdict: 'ineligible', label: 'weak', composite: 0, reasons: [`track mismatch (${gates.track_ok.toFixed(2)})`] };
  }
  // Hard level gate: below/above the candidate band both kill the application.
  if (gates.level_band === 'below' || gates.level_band === 'above') {
    if (!lenient) {
      return { verdict: 'ineligible', label: 'weak', composite: 0,
        reasons: [`level ${gates.level_band} candidate band (comp won't match)`] };
    }
  }
  const dropCoverage = lenient ? 1.0 : MIN_COVERAGE_DROP;
  if (gates.coverage !== undefined && gates.coverage < dropCoverage) {
    return { verdict: 'ineligible', label: 'weak', composite: 0,
      reasons: [`requirement coverage too low (${gates.coverage.toFixed(2)} < ${dropCoverage})`] };
  }
  let capped = label;
  if (gates.level_band === 'below' || gates.level_band === 'above') {
    capped = 'partial';
    reasons.push(`level ${gates.level_band} candidate band`);
  } else if (gates.level_band === 'unclear') {
    capped = capped === 'strong' ? 'good' : capped;
    reasons.push('level unclear in posting');
  } else if (gates.level_ok !== undefined && gates.level_ok <= NO) {
    capped = 'partial';
    reasons.push(`level mismatch (${gates.level_ok.toFixed(2)})`);
  }
  const fullCoverage = lenient ? 2.0 : MIN_COVERAGE_FULL;
  if (gates.coverage !== undefined && gates.coverage < fullCoverage && (capped === 'strong' || capped === 'good')) {
    capped = 'partial';
    reasons.push(`thin requirement coverage (${gates.coverage.toFixed(2)})`);
  }
  return { verdict: null, label: capped, composite, reasons };
}

// Code backstop for the level band: titles that are unmistakably a lower rung
// (associate, engineer II/III, junior, graduate) drop even if the model reads
// the years as "senior". Staff/principal/lead/manager titles are exempt.
const BELOW_TITLE = /\b(associate|junior|jr\.?|graduate|intern|trainee)\b|\b(engineer|developer|swe|sde|scientist)\s*(i{1,3}|1|2|3)\b|\bmid[\s-]?level\b/i;
const ABOVE_EXEMPT = /staff|principal|lead|head|director|manager|architect/i;
function levelBackstop(title, band) {
  if (band === 'above' || band === 'unclear' || !band) return band;
  const t = String(title || '');
  if (BELOW_TITLE.test(t) && !ABOVE_EXEMPT.test(t)) return 'below';
  return band;
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

// Deterministic relocation answer when the data already decides it:
// candidate accepts relocation, role is in a candidate city, or fully remote.
// Returns null when the posting must be read to decide (Jev handles it).
function fastRelocation(candidate, role) {
  if (candidate.relocation_ok) return 1;
  const mode = String(role.mode || '').toLowerCase();
  if (/remote/.test(mode) && !/hybrid|on-?site/.test(mode)) return 1;
  const loc = normCity(role.location || '');
  const home = (candidate.cities || []).map(normCity).filter(Boolean);
  if (loc && home.some((c) => loc.includes(c))) return 1;
  return null;
}

// Company pre-screen verdict, composed in code from Jev dimensions. Hard skips
// need a confident signal; thin information routes to `maybe` (sweep to verify)
// rather than trusting a guess. Advisory, not final: cached with a date and
// re-screenable, and the sweep still filters roles on their own merits.
function companyScreenVerdict(a) {
  const n = (id) => a[id]?.noul;
  const dimensions = {
    product_company: n('product_company'),
    hires_in_candidate_market: n('hires_in_candidate_market'),
    pays_below_floor: n('pays_below_floor'),
    candidate_fit: n('candidate_fit'),
    enough_information: n('enough_information'),
  };
  // Thin information routes to `maybe` first: without enough context the other
  // dimensions are guesses, and a false skip hides a company from every future
  // sweep. `maybe` still fetches the board — it just flags the uncertainty.
  const info = n('enough_information');
  if (info !== undefined && info <= NO) {
    return { verdict: 'maybe', reasons: ['thin company information — verify before spending sweep effort'], dimensions };
  }
  const pc = n('product_company');
  if (pc !== undefined && pc <= NO) {
    return { verdict: 'skip', reasons: [`non-product company — staffing/consultancy/outsourcing (${pc.toFixed(2)})`], dimensions };
  }
  const hires = n('hires_in_candidate_market');
  if (hires !== undefined && hires <= NO) {
    return { verdict: 'skip', reasons: [`no hiring path in the candidate market (${hires.toFixed(2)})`], dimensions };
  }
  const pay = n('pays_below_floor');
  if (pay !== undefined && pay >= YES) {
    return { verdict: 'skip', reasons: [`pay evidence below the floor (${pay.toFixed(2)})`], dimensions };
  }
  const reasons = [];
  const fit = n('candidate_fit');
  if (fit !== undefined && fit <= NO) reasons.push(`domain fit low (${fit.toFixed(2)})`);
  if (pay !== undefined && pay > NO && pay < YES) reasons.push(`pay unverified (${pay.toFixed(2)})`);
  if (hires !== undefined && hires > NO && hires < YES) reasons.push(`hiring geography unverified (${hires.toFixed(2)})`);
  return { verdict: 'sweep', reasons, dimensions };
}

// Money-span finder for salary-parse: code locates candidates, Jev selects the
// base-salary one, code parses the number. Deterministic, no model call.
const MONEY_RE = /(?:[₹$€£]\s?\d[\d,.]*(?:\s?(?:k|lakhs?|lpa|l)?)?(?:\s?(?:-|–|to)\s?[₹$€£]?\s?\d[\d,.]*(?:\s?(?:k|lakhs?|lpa|l)?)?)?)/gi;
function salaryCandidates(text, cap = 12) {
  const out = [];
  const s = String(text || '');
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(s)) && out.length < cap) {
    const start = Math.max(0, m.index - 90);
    const end = Math.min(s.length, m.index + m[0].length + 90);
    out.push({ raw: m[0].replace(/\s+/g, ' ').trim(), context: s.slice(start, end).replace(/\s+/g, ' ') });
  }
  return out;
}

// Conservative number parse for a selected salary span. Returns null fields
// rather than guessing when the unit is ambiguous; callers use the raw string.
function parseSalaryRaw(raw, context = '') {
  const s = `${raw} ${context}`.toLowerCase();
  const currency = /₹|\binr\b|rupee|lpa|lakh/.test(s) ? 'INR'
    : /\$|\busd\b/.test(s) ? 'USD'
    : /€|\beur\b/.test(s) ? 'EUR'
    : /£|\bgbp\b/.test(s) ? 'GBP' : '';
  const nums = (raw.match(/\d[\d,.]*/g) || []).map((x) => Number(x.replace(/,/g, '')))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (!nums.length) return { currency, min: null, max: null, unit: 'unknown' };
  const lakh = /lpa|lakh|\d\s?l\b/.test(s);
  const thousand = /\d\s?k\b/.test(s) && !lakh;
  const monthly = /per month|monthly|\/month|p\.?m\.?\b/.test(s);
  const annual = /per annum|annual|annually|per year|\/yr|yearly|\blpa\b/.test(s);
  const mult = lakh ? 100000 : thousand ? 1000 : 1;
  const min = nums[0] * mult;
  const max = (nums[1] ?? nums[0]) * mult;
  const unit = monthly ? 'monthly' : annual || lakh || thousand ? 'annual' : 'unknown';
  return { currency, min, max, unit };
}

// Listing triage verdict, composed in code. Only explicit mismatches skip;
// uncertainty fetches (a thin listing must never hide a role).
function triageVerdict(a) {
  const n = (id) => a[id]?.noul;
  const loc = n('location_ok'), track = n('track_ok'), level = n('level_ok'), stack = n('stack_signal');
  if (loc !== undefined && loc <= NO) return { verdict: 'skip', reasons: [`location not eligible (${loc.toFixed(2)})`] };
  if (track !== undefined && track <= NO) return { verdict: 'skip', reasons: [`track mismatch (${track.toFixed(2)})`] };
  if (level !== undefined && level <= NO) return { verdict: 'skip', reasons: [`level mismatch (${level.toFixed(2)})`] };
  const reasons = [];
  if (stack !== undefined && stack <= NO) reasons.push(`stack signal weak (${stack.toFixed(2)})`);
  for (const [id, label, v] of [['location', 'location', loc], ['track', 'track', track], ['level', 'level', level]]) {
    if (v !== undefined && v > NO && v < YES) reasons.push(`${label} uncertain (${v.toFixed(2)})`);
  }
  const uncertain = [loc, track, level].some((v) => v !== undefined && v > NO && v < YES);
  return { verdict: uncertain ? 'maybe' : 'fetch', reasons };
}

// Requirement span finder for the requirements command: code locates
// requirement-like lines, Jev judges each. Deterministic, no model call.
function requirementCandidates(text, cap = 12) {
  const lines = String(text || '')
    .split(/\r?\n|•|·|‣|▪|●|○|\u2022/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/^[-*–—]\s*/, '').trim())
    .filter(Boolean);
  const scored = [];
  for (const line of lines) {
    if (line.length < 25 || line.length > 400) continue;
    let score = 0;
    if (/\b(must|required|requirement|proficien|experience (with|in)|expertise|strong|deep|hands-on|knowledge of|familiar|ability to|minimum)\b/i.test(line)) score += 2;
    if (/\b(\d+\+?\s*years|bachelor|master|degree|phd)\b/i.test(line)) score += 1;
    if (/^(we|our|about|why|benefit|perk|equal opportunity|compensation|salary|location|hybrid|remote|apply|join)\b/i.test(line)) score -= 2;
    if (score > 0) scored.push({ text: line, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const k = s.text.toLowerCase().slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s.text);
    if (out.length >= cap) break;
  }
  return out;
}

// Compose the requirement verdict from per-span answers (must_i + evidence_i).
function composeRequirements(items, answers) {
  const rows = items.map((text, i) => ({
    text,
    must: (answers[`must_${i}`]?.noul ?? 0) >= YES,
    evidence: answers[`evidence_${i}`]?.score ?? 0,
  }));
  const required = rows.filter((r) => r.must);
  const gaps = required.filter((r) => r.evidence < 2).map((r) => r.text);
  const coverage = required.length
    ? Math.round((required.reduce((s, r) => s + r.evidence, 0) / (3 * required.length)) * 1000) / 1000
    : null;
  return { coverage, must_count: required.length, gaps, must_haves: rows };
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
      instructions: `Candidate relocation_ok is \`candidate.relocation_ok\` and lives in \`candidate.cities\`. Does \`posting.posting_text\` force a relocation the candidate rejects? A role located in a candidate city, a fully remote role, or a posting that is silent about relocation all pass. Only an explicit requirement to move to (or work from) a place outside \`candidate.cities\` when relocation_ok is false fails.`,
      criteria: {
        true: 'In a candidate city, fully remote, silent on relocation, or candidate accepts relocation',
        false: 'Explicitly requires moving to or being located outside the candidate cities, and relocation_ok is false',
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
      instructions: 'Is the posting level within the candidate band in `candidate` (years_experience, seniority)? A mid-level, associate, or L4/III-titled role is below; a director/VP/head-of or a role demanding far more years than the candidate has is above. Both fail. About one step either way is the tolerance.',
      criteria: {
        true: 'Within about one level of the candidate band',
        false: 'Two or more levels above or below the candidate band',
      },
    },
    level_match: {
      type: 'choice',
      instructions: {
        question: 'What is the posted seniority level of `posting` relative to the candidate band in `candidate` (years_experience, seniority, titles)?',
        focus: 'Judge the level the posting hires at, from its title and required years/responsibilities. If the posted title or stated band overlaps ANY entry in `candidate.seniority` (e.g. Senior, Staff, Principal, Lead), answer "at" — even when the posting asks for fewer years than the candidate has. Fewer stated years is not "below"; only an explicitly lower rung is.',
      },
      criteria: {
        below: {
          what: 'Explicitly a lower rung: mid-level, associate, engineer II/III, junior, or a title rank clearly below every entry in `candidate.seniority`. Responsibilities scoped to executing well-defined tasks without ownership or design scope.',
          examples: ['Software Engineer II', 'Senior Associate', 'Junior/Mid-Level Engineer', 'Software Engineer III'],
        },
        at: {
          what: 'Same band: the title or stated level overlaps `candidate.seniority` (Senior/Staff/Principal/Lead IC roles), or the posting is level-flexible / a generic "Software Engineer" with 5+ years and ownership scope.',
          not_for: 'Do not choose "at" for manager/director roles when the candidate is an IC',
          examples: ['Senior Software Engineer', 'Staff Software Engineer', 'Principal Engineer', 'Forward Deployed Engineer with customer ownership'],
        },
        above: {
          what: 'Clearly above the candidate band: director, VP, head-of, or explicit requirements far beyond the candidate (managing managers, 20+ years, or a named larger scope the candidate has not held).',
          examples: ['Director of Engineering', 'VP Engineering', 'Head of Platform'],
        },
        unclear: {
          what: 'The posting states no reliable level or years signal at all.',
        },
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
  // Pre-sweep company triage: one call replaces a board fetch + parse + per-role
  // calls for companies that cannot yield eligible roles at all.
  companyScreen: () => ({
    product_company: {
      type: 'noul',
      instructions: 'Is `company.name` (with `company.context` when present) a product company — it builds and sells its own software product — rather than a staffing agency, IT consultancy, outsourcing/bodyshop, or legacy-maintenance vendor?',
      criteria: {
        true: 'Owns a software product; product engineering is its core business',
        false: 'Staffing/recruiting agency, consultancy, outsourcing vendor, or reseller of other companies\' engineers',
      },
    },
    hires_in_candidate_market: {
      type: 'noul',
      instructions: 'Given the candidate countries `candidate.countries`, cities `candidate.cities`, and remote scope `candidate.remote_scope`, does `company` hire engineers for the candidate market — an office in a candidate city, an India/APAC entity, or explicit global/India/APAC remote hiring? Judge from `company.context` when it names locations; when context is silent, judge only companies whose hiring geography is reliably established.',
      criteria: {
        true: 'Office/entity in the candidate market, or explicit candidate-market/global remote hiring',
        false: 'Hires only in other geographies (e.g. US-only, EU-only) with no candidate-market path',
      },
    },
    pays_below_floor: {
      type: 'noul',
      instructions: 'Is there credible evidence that `company.name` pays engineers at the candidate\'s level below `candidate.salary_min` `candidate.salary_currency` (or the local-currency equivalent) in the candidate market? Answer yes only for a concrete signal — a known low-band employer in that market, a published band below the floor, or an outsourcing-rate model. Absent such a signal, answer no.',
      criteria: {
        true: 'Concrete below-floor pay signal for this market and level',
        false: 'No credible below-floor signal (unknown pay, or known to pay at/above market)',
      },
    },
    candidate_fit: {
      type: 'noul',
      instructions: 'Does `company.name` plausibly match the candidate\'s target industries `candidate.industries`, titles `candidate.titles`, and skills `candidate.skills` — e.g. AI/agent platforms, developer tools, SaaS product engineering?',
      criteria: {
        true: 'Product and domain align with the candidate targets',
        false: 'Unrelated domain with no transferable product-engineering signal',
      },
    },
    enough_information: {
      type: 'noul',
      instructions: 'Does `company` contain enough information to judge these questions about this company — either a non-empty `company.context` or a company well known enough that its product, hiring geography, and pay reputation are reliably established?',
      criteria: {
        true: 'Context provided, or a widely known company whose facts are reliably established',
        false: 'Little or no context and not a company whose specifics are reliably known',
      },
    },
  }),
  // Salary extraction is select-not-generate: code finds money spans, Jev picks
  // the one that is this role's base salary; code parses the number.
  salaryParse: () => ({
    base_salary: {
      type: 'choice',
      instructions: 'Which candidate in `salary.candidates` (each has `raw` and surrounding `context`) states the annual BASE salary or base-salary band for this role in `posting`? Choose the base pay for this position — not equity value, signing bonus, benefits/insurance amounts, recruiter fees, or a band belonging to a different role. Choose none when no candidate is the base salary.',
      criteria: {
        candidates: 'Placeholder replaced in code with one option per candidate',
        none: 'No candidate states this role\'s base salary',
      },
    },
  }),
  // Listing triage: cheap per-listing judgment on title/location/snippet, run
  // before fetching full postings. Silent/ambiguous listings answer yes so a
  // thin listing never hides a role; only explicit mismatches skip.
  triage: () => ({
    location_ok: {
      type: 'noul',
      instructions: 'Given `listing.location` and `listing.mode`, can this role hire the candidate (countries `candidate.countries`, cities `candidate.cities`, remote scope `candidate.remote_scope`)? Answer yes when the listing is silent or ambiguous — only an explicit restriction to another geography (e.g. "Remote - US", "must be authorized in Canada") is a no.',
      criteria: {
        true: 'Candidate market, eligible remote scope, or no location signal at all',
        false: 'Explicitly restricted to a geography the candidate cannot work from',
      },
    },
    track_ok: {
      type: 'noul',
      instructions: 'Is `listing.title` on the candidate track in `candidate.titles` — an IC engineering role? People management (Engineering Manager, Director), sales/quota, or non-engineering functions fail.',
      criteria: {
        true: 'IC engineering title matching the candidate track',
        false: 'Management, sales, or a different function',
      },
    },
    level_ok: {
      type: 'noul',
      instructions: 'Does `listing.title` (and `listing.snippet` when present) fall within the candidate band in `candidate` (seniority, years_experience)? Explicitly junior/mid rungs (associate, engineer II/III, junior) or clearly senior-management rungs (director/VP/head-of) fail; a title with no level signal passes.',
      criteria: {
        true: 'Within about one level of the candidate band, or no level signal',
        false: 'Explicitly two or more levels below or above the candidate band',
      },
    },
    stack_signal: {
      type: 'noul',
      instructions: 'Does `listing.title` (and `listing.snippet` when present) suggest work in the candidate\'s stack or domains (`candidate.skills`, `candidate.industries`, `candidate.titles`) — frontend/full-stack, AI agents/MCP/LLM, developer platforms/DX?',
      criteria: {
        true: 'Title/snippet points at a candidate stack or domain',
        false: 'A different discipline (hardware, data engineering only, security only, mobile-only)',
      },
    },
  }),
  // Requirement extraction: code finds requirement spans, Jev judges each for
  // must-have status and candidate evidence, code composes the gap list.
  requirements: () => ({
    // Question ids are generated per span in the command (must_0..n, evidence_0..n).
  }),
  // Rejection emails/pages are the tracker's missing feedback signal: a reason
  // classification feeds `mark rejected --reason`, which tunes future ranking.
  rejectionReason: () => ({
    reason: {
      type: 'choice',
      instructions: 'Which single reason best explains the outcome in `outcome.text`? Pick the reason the employer or process actually signals — not a guess. Use unknown for a generic rejection with no concrete cause, and none when the text is not a rejection at all.',
      criteria: {
        location: { what: 'Location, geography, work authorization, or relocation is the stated or strongly implied blocker' },
        comp: { what: 'Compensation or salary expectations named as the mismatch' },
        level: { what: 'Seniority, level, or years-of-experience mismatch named' },
        stack: { what: 'A specific skills or technology gap named' },
        domain: { what: 'Industry or domain-experience gap named' },
        track: { what: 'Role-track mismatch named (IC vs management, function change)' },
        sponsorship: { what: 'Visa or sponsorship is the stated blocker' },
        unknown: { what: 'A rejection with no concrete cause stated' },
        none: { what: 'Not a rejection (interview invite, hold, general update)' },
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
  const reloc = fastRelocation(candidate, posting);
  if (reloc !== null && data.answers.relocation_ok) data.answers.relocation_ok.noul = reloc;
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
  const gates = { track_ok: a.track_ok.noul, level_ok: a.level_ok.noul,
    level_band: levelBackstop(posting.title, a.level_match?.choice),
    coverage: a.requirement_coverage.score };
  const gated = applyFitGates(composite, fitLabel(composite), gates, { lenient: Boolean(opts['--lenient']) });
  return {
    scores: { requirement_coverage: a.requirement_coverage.score,
      seniority_match: a.seniority_match.score, stack_match: a.stack_match.score, domain_match: a.domain_match.score },
    gates: { track_ok: gates.track_ok, level_ok: gates.level_ok, level_band: gates.level_band,
      coverage: gates.coverage },
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
      const reloc = fastRelocation(candidate, r);
      if (reloc !== null && data.answers.relocation_ok) data.answers.relocation_ok.noul = reloc;
      const a = data.answers;
      const ev = eligibilityVerdict(a);
      const composite = fitComposite(a.requirement_coverage.score, a.stack_match.score,
        a.seniority_match.score, a.domain_match.score);
      const gated = applyFitGates(composite, fitLabel(composite),
        { track_ok: a.track_ok.noul, level_ok: a.level_ok.noul,
          level_band: levelBackstop(r.title, a.level_match?.choice),
          coverage: a.requirement_coverage.score },
        { lenient: Boolean(opts['--lenient']) });
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
        verdict, reasons, composite: Math.round(finalComposite * 1000) / 1000, label: gated.label,
        level: levelBackstop(r.title, a.level_match?.choice) ?? null,
        coverage: Math.round((a.requirement_coverage?.score ?? 0) * 100) / 100 };
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

// Pre-sweep company triage. Context is optional but strongly improves accuracy:
// pass a careers-page/website snippet when the company is not widely known.
async function cmdCompanyScreen(opts) {
  const profile = asJson(readOpt(opts['--profile']), '--profile');
  const companyRaw = readOpt(opts['--company']);
  if (companyRaw === undefined) fail('missing --company');
  const company = typeof companyRaw === 'string' && companyRaw.trimStart()[0] !== '{'
    ? { name: companyRaw.trim(), context: '' }
    : { name: String(companyRaw.name || '').trim(), context: String(companyRaw.context || '') };
  if (!company.name) fail('--company needs a name');
  const ctx = opts['--context'] ? trunc(asText(readOpt(opts['--context']), '--context'), 2500) : trunc(company.context, 2500);
  const candidate = redactProfile(profile);
  const state = { candidate, company: { name: company.name, context: ctx } };
  const data = await systemOne(state, Q.companyScreen(), { model: opts['--model'] });
  const { verdict, reasons, dimensions } = companyScreenVerdict(data.answers);
  const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null);
  return {
    company: company.name, verdict, reasons,
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, round(v)])),
    confidences: Object.fromEntries(Object.entries(data.answers).map(([k, v]) => [k, v.confidence])),
    context_used: Boolean(ctx), model: data.model,
  };
}

// Select-not-generate salary extraction: code finds money spans, Jev picks the
// base-salary one, code parses it. `none` when the posting publishes no base.
async function cmdSalaryParse(opts) {
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { title: '', company: '', posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const text = trunc(posting.posting_text || posting.text || '');
  const candidates = salaryCandidates(text);
  if (!candidates.length) {
    return { found: false, raw: null, currency: '', min: null, max: null, unit: 'unknown',
      confidence: null, candidates: [], model: null, note: 'no money spans in the posting text' };
  }
  const criteria = Object.fromEntries(candidates.map((c, i) => [`c${i}`, `${c.raw} — ${c.context}`.slice(0, 300)]));
  criteria.none = 'No candidate states this role\'s base salary';
  const state = { posting: { title: posting.title || '', company: posting.company || '', posting_text: text },
    salary: { candidates: candidates.map((c, i) => ({ id: `c${i}`, raw: c.raw, context: c.context })) } };
  const data = await systemOne(state, { base_salary: { ...Q.salaryParse().base_salary, criteria } }, { model: opts['--model'] });
  const ans = data.answers.base_salary;
  const idx = ans.choice && ans.choice !== 'none' && ans.choice.startsWith('c') ? Number(ans.choice.slice(1)) : -1;
  if (ans.confidence < 0.5 || idx < 0) {
    return { found: false, raw: null, currency: '', min: null, max: null, unit: 'unknown',
      confidence: ans.confidence, candidates: candidates.map((c) => c.raw), model: data.model };
  }
  const picked = candidates[idx];
  const parsed = parseSalaryRaw(picked.raw, picked.context);
  return { found: true, raw: picked.raw, ...parsed, confidence: ans.confidence,
    candidates: candidates.map((c) => c.raw), model: data.model };
}

// Rejection feedback: classify the reason so `mark rejected --reason` can tune
// ranking. Works on an email body, an ATS status page, or a recruiter note.
async function cmdRejectionReason(opts) {
  const text = trunc(asText(readOpt(opts['--text']), '--text'));
  const data = await systemOne({ outcome: { text } }, Q.rejectionReason(), { model: opts['--model'] });
  const ans = data.answers.reason;
  const reason = ans.choice === 'none' ? null : ans.choice;
  return { reason, is_rejection: ans.choice !== 'none', confidence: ans.confidence, model: data.model };
}

// Per-listing triage, run on board rows before fetching full postings. The
// deterministic onsite gate fires first (free); Jev judges the rest.
async function cmdTriage(opts) {
  const profile = asJson(readOpt(opts['--profile']), '--profile');
  const listings = asJson(readOpt(opts['--listings']), '--listings');
  if (!Array.isArray(listings)) fail('--listings must be a JSON array');
  const candidate = redactProfile(profile);
  const results = await pMap(listings, 4, async (l) => {
    const base = { id: l.id ?? null, company: l.company || '', title: l.title || '', url: l.url || '' };
    const gateHit = onsiteGate(candidate, { mode: l.mode || '', location: l.location || '' });
    if (gateHit) return { ...base, verdict: 'skip', reasons: [gateHit], deterministic: true };
    const state = {
      candidate,
      listing: { title: l.title || '', company: l.company || '', location: l.location || '',
        mode: l.mode || '', snippet: trunc(l.snippet || l.description || '', 800) },
    };
    try {
      const data = await systemOne(state, Q.triage(), { model: opts['--model'] });
      const { verdict, reasons } = triageVerdict(data.answers);
      return { ...base, verdict, reasons,
        dimensions: Object.fromEntries(Object.entries(data.answers).map(([k, v]) => [k, Math.round(v.noul * 100) / 100])) };
    } catch (err) {
      return { ...base, verdict: 'maybe', reasons: [`jev error: ${err.message || err}`] };
    }
  });
  const order = { skip: 0, maybe: 1, fetch: 2 };
  results.sort((a, b) => order[a.verdict] - order[b.verdict]);
  const limit = Number(opts['--limit'] || 0);
  return { model: DEFAULT_MODEL, count: results.length, listings: limit > 0 ? results.slice(0, limit) : results };
}

// Requirement extraction + evidence scoring per posting: code finds spans,
// Jev judges must-have status and candidate evidence, code composes gaps.
async function cmdRequirements(opts) {
  const profile = opts['--cv'] ? null : asJson(readOpt(opts['--profile']), '--profile');
  const cvRaw = opts['--cv'] ? readOpt(opts['--cv']) : null;
  let candidate;
  if (cvRaw) {
    let cv; try { cv = JSON.parse(cvRaw); } catch { cv = { text: cvRaw }; }
    candidate = cv && typeof cv === 'object' && (cv.skills || cv.years_experience !== undefined)
      ? { years_experience: cv.years_experience ?? null, headline: cv.headline || cv.text?.slice(0, 200) || '',
          seniority: cv.seniority || [], titles: cv.titles || [], skills: cv.skills || [], industries: cv.industries || [] }
      : { text: trunc(typeof cv.text === 'string' ? cv.text : String(cvRaw)) };
  } else {
    if (!profile) fail('missing --profile or --cv');
    candidate = redactProfile(profile);
  }
  const postingRaw = readOpt(opts['--posting']);
  const posting = typeof postingRaw === 'string' && postingRaw.trimStart()[0] !== '{'
    ? { title: '', company: '', posting_text: postingRaw } : asJson(postingRaw, '--posting');
  const text = trunc(posting.posting_text || posting.text || '');
  const items = requirementCandidates(text, Number(opts['--max-items'] || 12));
  if (!items.length) {
    return { coverage: null, must_count: 0, gaps: [], must_haves: [], confidence: null,
      model: null, note: 'no requirement-like spans found in the posting text' };
  }
  const questions = {};
  items.forEach((t, i) => {
    questions[`must_${i}`] = {
      type: 'noul',
      instructions: `Is requirement \`requirements.items[${i}].text\` a MUST-HAVE requirement for \`posting\` — stated as required, or clearly essential to the role — rather than a nice-to-have, benefit, or boilerplate?`,
      criteria: {
        true: 'Stated as required/essential (or a core responsibility the role cannot be done without)',
        false: 'Nice-to-have, preferred, benefit, company boilerplate, or unrelated line',
      },
    };
    questions[`evidence_${i}`] = {
      type: 'score',
      instructions: `How much of requirement \`requirements.items[${i}].text\` is evidenced in \`candidate\` (skills, years_experience, headline, titles, industries)? Judge only this requirement.`,
      criteria: [
        'Not evidenced at all',
        'Minority/adjacent evidence only',
        'Mostly evidenced; small learnable gap',
        'Directly evidenced in the candidate profile',
      ],
    };
  });
  const state = {
    candidate,
    posting: { title: posting.title || '', company: posting.company || '', posting_text: text },
    requirements: { items: items.map((t, i) => ({ id: `r${i}`, text: t })) },
  };
  const data = await systemOne(state, questions, { model: opts['--model'] });
  const composed = composeRequirements(items, data.answers);
  const maxGaps = opts['--max-gaps'] !== undefined ? Number(opts['--max-gaps']) : null;
  const out = { ...composed, confidence: Math.min(...items.map((_, i) => data.answers[`evidence_${i}`]?.confidence ?? 0)),
    model: data.model };
  if (maxGaps !== null && Number.isFinite(maxGaps)) out.shortlist_ok = composed.gaps.length <= maxGaps;
  return out;
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
  ok('coverage below drop bar kills the role',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, coverage: 1.2 }).verdict === 'ineligible');
  ok('level below candidate band drops by default',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, level_band: 'below', coverage: 2.5 }).verdict === 'ineligible');
  ok('level above candidate band drops by default',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, level_band: 'above', coverage: 2.5 }).verdict === 'ineligible');
  ok('level below survives with --lenient (capped partial)',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.2, level_band: 'below', coverage: 2.5 }, { lenient: true }).label === 'partial');
  ok('unclear level caps strong to good',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, level_band: 'unclear', coverage: 2.5 }).label === 'good');
  ok('thin coverage caps strong at partial',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, level_band: 'at', coverage: 1.8 }).label === 'partial');
  ok('at-level + full coverage stays strong',
    applyFitGates(0.8, 'strong', { track_ok: 0.9, level_ok: 0.9, level_band: 'at', coverage: 2.6 }).label === 'strong');
  ok('level backstop catches engineer III',
    levelBackstop('Software Engineer III, Full Stack', 'at') === 'below');
  ok('level backstop catches senior associate',
    levelBackstop('Software Engineering Senior Associate', 'at') === 'below');
  ok('level backstop exempts staff/principal',
    levelBackstop('Staff Software Engineer', 'at') === 'at' && levelBackstop('Associate Principal Engineer', 'at') === 'at');
  ok('level backstop leaves above/unclear alone',
    levelBackstop('Software Engineer II', 'above') === 'above' && levelBackstop('Software Engineer II', 'unclear') === 'unclear');
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
  const hydCand = { cities: ['Hyderabad'], relocation_ok: false };
  ok('fastRelocation passes same-city hybrid',
    fastRelocation(hydCand, { mode: 'hybrid', location: 'Hyderabad, Telangana, India' }) === 1);
  ok('fastRelocation passes remote',
    fastRelocation(hydCand, { mode: 'remote', location: '' }) === 1);
  ok('fastRelocation defers on foreign city',
    fastRelocation(hydCand, { mode: 'on-site', location: 'Pune, India' }) === null);
  ok('fastRelocation defers when silent',
    fastRelocation(hydCand, { mode: '', location: '' }) === null);
  // Company pre-screen verdict composition.
  const sweepDims = { product_company: { noul: 0.9 }, hires_in_candidate_market: { noul: 0.85 },
    pays_below_floor: { noul: 0.15 }, candidate_fit: { noul: 0.8 }, enough_information: { noul: 0.9 } };
  ok('company-screen: product + market + info -> sweep',
    companyScreenVerdict(sweepDims).verdict === 'sweep');
  ok('company-screen: staffing -> skip',
    companyScreenVerdict({ ...sweepDims, product_company: { noul: 0.05 } }).verdict === 'skip');
  ok('company-screen: US-only hiring -> skip',
    companyScreenVerdict({ ...sweepDims, hires_in_candidate_market: { noul: 0.1 } }).verdict === 'skip');
  ok('company-screen: below-floor pay -> skip',
    companyScreenVerdict({ ...sweepDims, pays_below_floor: { noul: 0.8 } }).verdict === 'skip');
  ok('company-screen: thin information -> maybe',
    companyScreenVerdict({ ...sweepDims, enough_information: { noul: 0.2 } }).verdict === 'maybe');
  ok('company-screen: uncertain pay flags sweep',
    companyScreenVerdict({ ...sweepDims, pays_below_floor: { noul: 0.5 } }).reasons.some((r) => /pay unverified/.test(r)));
  // Salary span finder + parser.
  ok('salary spans found in text',
    salaryCandidates('Compensation: ₹75L - ₹90L per annum plus equity.').length === 1);
  ok('salary span caps at 12', salaryCandidates(Array.from({ length: 30 }, () => '$100,000').join(' or ')).length === 12);
  ok('salary parse INR lakh -> annual', (() => {
    const p = parseSalaryRaw('₹75L - ₹90L', 'per annum'); return p.currency === 'INR' && p.min === 7500000 && p.max === 9000000 && p.unit === 'annual';
  })());
  ok('salary parse USD band -> annual', (() => {
    const p = parseSalaryRaw('$120,000 - $160,000', 'base salary per year'); return p.currency === 'USD' && p.min === 120000 && p.max === 160000 && p.unit === 'annual';
  })());
  ok('salary parse monthly flagged', parseSalaryRaw('€6,000 per month', 'gross').unit === 'monthly');
  ok('salary parse unknown unit left unknown', parseSalaryRaw('$100,000', 'competitive').unit === 'unknown');
  ok('salary parse single value doubles as band', (() => {
    const p = parseSalaryRaw('£90,000', 'per annum'); return p.min === 90000 && p.max === 90000;
  })());
  // Listing triage verdict composition.
  const triageDims = { location_ok: { noul: 0.9 }, track_ok: { noul: 0.9 }, level_ok: { noul: 0.85 }, stack_signal: { noul: 0.8 } };
  ok('triage: clean listing -> fetch', triageVerdict(triageDims).verdict === 'fetch');
  ok('triage: US-only location -> skip', triageVerdict({ ...triageDims, location_ok: { noul: 0.05 } }).verdict === 'skip');
  ok('triage: manager title -> skip', triageVerdict({ ...triageDims, track_ok: { noul: 0.1 } }).verdict === 'skip');
  ok('triage: junior title -> skip', triageVerdict({ ...triageDims, level_ok: { noul: 0.2 } }).verdict === 'skip');
  ok('triage: uncertain location -> maybe', triageVerdict({ ...triageDims, location_ok: { noul: 0.5 } }).verdict === 'maybe');
  ok('triage: weak stack flags fetch', triageVerdict({ ...triageDims, stack_signal: { noul: 0.1 } }).reasons.some((r) => /stack signal weak/.test(r)));
  // Requirement span finder + composition.
  const reqText = ['About us: we are a leading company.', 'Requirements:', 'Must have 8+ years of experience with TypeScript and React.',
    'Experience with distributed systems and Kubernetes is required.', 'Nice to have: Rust.'].join('\n');
  const spans = requirementCandidates(reqText);
  ok('requirement spans: finds must-haves, drops boilerplate',
    spans.some((s) => /TypeScript and React/.test(s)) && !spans.some((s) => /About us/.test(s)));
  ok('requirement spans dedupe', requirementCandidates(Array.from({ length: 5 }, () => 'Must have strong TypeScript experience with React').join('\n')).length === 1);
  ok('requirement spans cap at 12',
    requirementCandidates(Array.from({ length: 20 }, (_, i) => `Must have strong experience with tool${i} and platform${i} engineering`).join('\n')).length === 12);
  const composed = composeRequirements(['Must have TypeScript', 'Must have Kubernetes', 'Nice to have Rust'], {
    must_0: { noul: 0.95 }, evidence_0: { score: 3 }, must_1: { noul: 0.9 }, evidence_1: { score: 0 }, must_2: { noul: 0.1 }, evidence_2: { score: 0 },
  });
  ok('requirements: gaps = unevidenced must-haves only',
    composed.gaps.length === 1 && /Kubernetes/.test(composed.gaps[0]) && composed.must_count === 2);
  ok('requirements: coverage over must-haves', Math.abs(composed.coverage - 0.5) < 1e-9);
  // Question shapes.
  const allQ = { ...Q.eligibility({}), ...Q.fit(), ...Q.liveness(), ...Q.redflags(), ...Q.knockout(), ...Q.verifySubmit(), ...Q.sameRole(), ...Q.appliedGuard(), ...Q.companyScreen(), ...Q.salaryParse(), ...Q.rejectionReason(), ...Q.triage() };
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
  company-screen --profile P --company C [--context T]   sweep|maybe|skip before fetching a board
  triage --profile P --listings L.json     fetch|maybe|skip per listing before fetching postings
  requirements --profile P --posting J [--cv C] [--max-gaps N]   must-haves + gaps + coverage
  salary-parse --posting J                 published base salary: raw + parsed band
  rejection-reason --text T                location|comp|level|stack|domain|track|sponsorship|unknown
  selftest                                 offline checks (no key needed)

P/C/J/A/T: file path, '-' (stdin), or inline JSON/text. Profiles are redacted
before send; posting/page text truncated to ~6000 chars. See reference/jev.md.`;

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const run = {
    eligibility: cmdEligibility, fit: cmdFit, rank: cmdRank, liveness: cmdLiveness,
    redflags: cmdRedflags, knockout: cmdKnockout, 'qa-match': cmdQaMatch,
    'verify-submit': cmdVerifySubmit, 'same-role': cmdSameRole, 'applied-guard': cmdAppliedGuard,
    'company-screen': cmdCompanyScreen, 'salary-parse': cmdSalaryParse,
    'rejection-reason': cmdRejectionReason, triage: cmdTriage, requirements: cmdRequirements,
  }[cmd];
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'selftest') { cmdSelftest(); return; }
  if (!run) fail(`unknown command '${cmd}'. Try: help`);
  const out = await run(opts);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => fail(err?.message || String(err)));
