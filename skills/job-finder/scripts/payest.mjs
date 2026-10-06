#!/usr/bin/env node
// payest.mjs — pay estimation for postings that don't publish salary (2026-10-06).
//
// Job postings in India rarely publish CTC. Instead of dropping them for unknown
// pay, this estimator gathers surrounding evidence and returns an educated band:
//
//   1. published  — the posting itself carries an INR amount/range      (verified)
//   2. observed   — a real range observed for this company/role before  (observed)
//   3. floor      — the company's vetted conservative floor             (floor)
//   4. unknown    — no evidence; comp-gated decisions must not assume it
//
// Evidence store: ~/.job-search/comp-bands.json (never in the repo).
// Sources: `import` pulls job-radar's comp-evidence.json + companies.json
// payVetting when present; `set` records user/recruiter-confirmed bands.
//
// Usage:
//   node payest.mjs import [--jr <job-radar dir>]
//   node payest.mjs estimate --role <role.json> | --company "<name>" [--title "<title>"]
//   node payest.mjs set "<company>" --min <LPA> --max <LPA> [--source S] [--confidence observed|floor|verified]
//   node payest.mjs list

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.JOB_SEARCH_HOME || path.join(os.homedir(), '.job-search');
const STORE = path.join(HOME, 'comp-bands.json');
const JR = process.env.JOB_RADAR_DIR || path.join(os.homedir(), 'Documents/GitHub/job-radar');

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { version: 1, companies: {}, updated: null }; }
}
function save(s) {
  s.updated = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 1));
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const key = (name) => norm(name);
const lpa = (rupees) => Math.round((Number(rupees) / 100000) * 10) / 10;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else pos.push(a);
  }
  return { pos, flags };
}

// ---- published-pay parse from a posting (INR only; mirrors jev.mjs) --------
export function publishedLpa(text) {
  const s = String(text || '');
  let min = null, max = null;
  const push = (v) => { if (Number.isFinite(v) && v > 0) { if (min === null || v < min) min = v; if (max === null || v > max) max = v; } };
  for (const m of s.matchAll(/(?:₹|INR|Rs\.?)\s?([\d]+(?:[.,]\d+)?)[\s-]*(?:-|–|to)?[\s]*(?:₹|INR|Rs\.?)?\s?([\d]+(?:[.,]\d+)?)?\s?(cr(?:ore)?s?)\b/gi)) {
    push(Number(m[1].replace(',', '.')) * 100);
    if (m[2]) push(Number(m[2].replace(',', '.')) * 100);
  }
  for (const m of s.matchAll(/([\d]+(?:[.,]\d+)?)\s?(?:cr(?:ore)?s?)\b/gi)) push(Number(m[1].replace(',', '.')) * 100);
  for (const m of s.matchAll(/(?:₹|INR|Rs\.?)\s?([\d]+(?:[.,]\d+)?)[\s-]*(?:-|–|to)?[\s]*(?:₹|INR|Rs\.?)?\s?([\d]+(?:[.,]\d+)?)?\s?(?:lpa|lakhs?)\b/gi)) {
    push(Number(m[1].replace(',', '')));
    if (m[2]) push(Number(m[2].replace(',', '')));
  }
  for (const m of s.matchAll(/([\d]+(?:[.,]\d+)?)\s?lpa\b/gi)) push(Number(m[1].replace(',', '')));
  for (const m of s.matchAll(/(?:₹|INR|Rs\.?)\s?([\d][\d,]{6,})/g)) { const v = Number(m[1].replace(/,/g, '')) / 100000; if (v >= 30) push(v); }
  if (min === null) return null;
  return { min, max: max ?? min };
}

function findCompany(store, name) {
  const k = key(name);
  if (!k) return null;
  if (store.companies[k]) return { key: k, entry: store.companies[k] };
  // containments both ways on normalized names
  for (const [ek, ev] of Object.entries(store.companies)) {
    if (!ek || !ev) continue;
    if (ek.includes(k) || k.includes(ek)) return { key: ek, entry: ev };
  }
  return null;
}

export function estimate({ store, company, title, postingText, salaryText }) {
  const published = publishedLpa([salaryText, postingText].filter(Boolean).join(' '));
  if (published) return { basis: 'published', confidence: 'verified', min_lpa: published.min, max_lpa: published.max, sources: ['posting'] };
  const hit = findCompany(store, company);
  if (hit) {
    const e = hit.entry;
    if (e.max_lpa != null && e.min_lpa != null) {
      return { basis: 'observed', confidence: e.confidence || 'observed', min_lpa: e.min_lpa, max_lpa: e.max_lpa,
        cash_lpa: e.cash_lpa ?? null, cash_min_lpa: e.cash_min_lpa ?? null, sources: e.sources || [] };
    }
    if (e.floor_lpa != null) {
      const senior = /\b(staff|principal|senior|sr\.?|lead|architect)\b/i.test(title || '');
      const floor = senior ? (e.senior_floor_lpa ?? e.floor_lpa) : e.floor_lpa;
      return { basis: 'floor', confidence: 'floor', min_lpa: floor, max_lpa: null, sources: e.sources || [] };
    }
  }
  return { basis: 'unknown', confidence: 'unknown', min_lpa: null, max_lpa: null, sources: [] };
}

// ---- merge: ingest a JSON array of {name,min_lpa,max_lpa,cash_lpa,cash_min_lpa,source,levels} ----
function runMerge(file, replace = false) {
  const store = load();
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const it of items) {
    if (!it.name) continue;
    const k = key(it.name);
    const entry = store.companies[k] || {};
    if (it.clear_band) {
      entry.min_lpa = null; entry.max_lpa = null; entry.cash_lpa = null; entry.cash_min_lpa = null;
      entry.no_staff_band = true;
      entry.sources = [...new Set([...(entry.sources || []), String(it.source || 'no staff band')])].slice(0, 5);
      store.companies[k] = entry; n++;
      continue;
    }
    if (it.max_lpa == null) continue;
    if (replace) {
      entry.min_lpa = it.min_lpa ?? entry.min_lpa;
      entry.max_lpa = it.max_lpa;
      entry.cash_lpa = it.cash_lpa ?? null;
      entry.cash_min_lpa = it.cash_min_lpa ?? null;
      entry.source_replaced = it.source || 'replace';
    } else {
      entry.min_lpa = entry.min_lpa == null ? it.min_lpa : Math.min(entry.min_lpa, it.min_lpa ?? entry.min_lpa);
      entry.max_lpa = entry.max_lpa == null ? it.max_lpa : Math.max(entry.max_lpa, it.max_lpa);
      if (it.cash_lpa != null) entry.cash_lpa = entry.cash_lpa == null ? it.cash_lpa : Math.max(entry.cash_lpa, it.cash_lpa);
      if (it.cash_min_lpa != null) entry.cash_min_lpa = entry.cash_min_lpa == null ? it.cash_min_lpa : Math.max(entry.cash_min_lpa, it.cash_min_lpa);
    }
    entry.confidence = 'observed';
    entry.sources = [...new Set([...(entry.sources || []), String(it.source || 'merge').slice(0, 140)])].slice(0, 5);
    if (it.levels) entry.levels = it.levels;
    entry.updated = new Date().toISOString().slice(0, 10);
    store.companies[k] = entry;
    n++;
  }
  save(store);
  console.log(`merged ${n} record(s) → ${STORE} (${Object.keys(store.companies).length} companies)`);
}

// ---- import from job-radar -------------------------------------------------
function runImport() {
  const store = load();
  let n = 0;
  const cePath = path.join(JR, 'data/comp-evidence.json');
  if (fs.existsSync(cePath)) {
    const ce = JSON.parse(fs.readFileSync(cePath, 'utf8'));
    for (const e of ce) {
      if (!e.company || e.baseMin == null) continue;
      const k = key(e.company);
      const entry = store.companies[k] || {};
      const minL = lpa(e.baseMin), maxL = e.baseMax != null ? lpa(e.baseMax) : minL;
      // keep the widest observed band per company
      if (entry.min_lpa == null || minL < entry.min_lpa) entry.min_lpa = minL;
      if (entry.max_lpa == null || maxL > entry.max_lpa) entry.max_lpa = maxL;
      entry.confidence = 'observed';
      entry.sources = [...new Set([...(entry.sources || []), `job-radar observed ${e.currency} ${e.raw}`.slice(0, 120)])].slice(0, 4);
      entry.updated = (e.observedOn || '').slice(0, 10);
      store.companies[k] = entry;
      n++;
    }
  }
  const cPath = path.join(JR, 'data/companies.json');
  if (fs.existsSync(cPath)) {
    const cs = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    for (const c of cs) {
      const pv = c.payVetting || {};
      if (!c.name || (pv.generalBaseMin == null && pv.seniorBaseMin == null)) continue;
      const k = key(c.name);
      const entry = store.companies[k] || {};
      entry.floor_lpa = pv.generalBaseMin != null ? lpa(pv.generalBaseMin) : entry.floor_lpa;
      entry.senior_floor_lpa = pv.seniorBaseMin != null ? lpa(pv.seniorBaseMin) : entry.senior_floor_lpa;
      entry.confidence = entry.confidence || 'floor';
      entry.sources = [...new Set([...(entry.sources || []), `job-radar floor (${pv.confidence || 'estimate'})`])].slice(0, 4);
      store.companies[k] = entry;
      n++;
    }
  }
  save(store);
  console.log(`imported ${n} record(s) → ${STORE} (${Object.keys(store.companies).length} companies)`);
}

// ---- CLI -------------------------------------------------------------------
const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
if (cmd === 'import') {
  runImport();
} else if (cmd === 'merge') {
  if (!pos[1]) { console.error('usage: payest merge <file.json> [--replace]'); process.exit(2); }
  runMerge(pos[1], Boolean(flags.replace));
} else if (cmd === 'estimate') {
  const store = load();
  let company = flags.company || '';
  let title = flags.title || '';
  let postingText = '', salaryText = '';
  if (flags.role) {
    const r = JSON.parse(fs.readFileSync(flags.role, 'utf8'));
    company = company || r.company || '';
    title = title || r.title || '';
    postingText = r.posting_text || r.description || '';
    salaryText = typeof r.salary === 'string' ? r.salary : '';
  }
  console.log(JSON.stringify({ company, title, ...estimate({ store, company, title, postingText, salaryText }) }, null, 1));
} else if (cmd === 'set') {
  const store = load();
  const k = key(pos[1] || flags.company);
  if (!k) { console.error('usage: payest set "<company>" --min L --max L [--source S]'); process.exit(2); }
  const entry = store.companies[k] || {};
  if (flags.min) entry.min_lpa = Number(flags.min);
  if (flags.max) entry.max_lpa = Number(flags.max);
  if (flags.floor) entry.floor_lpa = Number(flags.floor);
  if (flags.confidence) entry.confidence = String(flags.confidence);
  entry.sources = [...new Set([...(entry.sources || []), String(flags.source || 'manual')].slice(0, 5))].slice(0, 5);
  entry.updated = new Date().toISOString().slice(0, 10);
  store.companies[k] = entry;
  save(store);
  console.log(`saved ${k}: ${JSON.stringify(entry)}`);
} else if (cmd === 'list') {
  const store = load();
  const rows = Object.entries(store.companies).sort((a, b) => (b[1].max_lpa ?? b[1].senior_floor_lpa ?? 0) - (a[1].max_lpa ?? a[1].senior_floor_lpa ?? 0));
  for (const [k, e] of rows) {
    const band = e.min_lpa != null ? `₹${e.min_lpa}–${e.max_lpa ?? '?'}L` : e.senior_floor_lpa != null ? `floor ₹${e.floor_lpa ?? '?'}/₹${e.senior_floor_lpa}L` : '';
    const cash = e.cash_lpa != null ? ` cash~₹${e.cash_lpa}L` : '';
    console.log(`${k.padEnd(28)} ${(band + cash).padEnd(32)} [${e.confidence || '?'}] ${(e.sources || [])[0] || ''}`.slice(0, 150));
  }
  console.log(`total: ${rows.length} companies`);
} else {
  console.log('usage: payest.mjs import | estimate --role R.json | set "<company>" --min L --max L | list');
}
