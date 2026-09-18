#!/usr/bin/env node
// tracker.mjs — local job-search tracker (roles, applications, answer bank, apply queue).
// Zero dependencies; Node 18+. Data lives in JOB_SEARCH_HOME (default ~/.job-search).
//
//   profile.json   user profile + search preferences (written by onboarding)
//   data.json      roles, statuses, notes, history, Q&A bank, apply queue (source of truth)
//   companies.json   learned sweep targets + ignored companies
//   applications.md  auto-generated human-readable view
//   reports/       saved search reports

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.JOB_SEARCH_HOME
  ? path.resolve(process.env.JOB_SEARCH_HOME)
  : path.join(os.homedir(), '.job-search');
const DATA_FILE = path.join(HOME, 'data.json');
const PROFILE_FILE = path.join(HOME, 'profile.json');
const EXPORT_FILE = path.join(HOME, 'applications.md');
const REPORTS_DIR = path.join(HOME, 'reports');
const COMPANIES_FILE = path.join(HOME, 'companies.json');
const SKILL_REF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reference');
const STARTER_FILE = process.env.JOB_SEARCH_COMPANIES_FILE || path.join(SKILL_REF_DIR, 'companies.md');

const STATUSES = [
  'shown', 'interested', 'applied', 'oa', 'phone', 'onsite', 'offer', 'accepted',
  'rejected', 'withdrew', 'not_interested', 'expired',
];
const ACTIVE_STATUSES = ['interested', 'applied', 'oa', 'phone', 'onsite', 'offer'];
const APPLIED_STATUSES = ['applied', 'oa', 'phone', 'onsite', 'offer', 'accepted'];
const QUEUE_STATUSES = ['queued', 'filling', 'awaiting_user', 'applied', 'skipped', 'failed', 'aborted'];
const OPEN_QUEUE_STATUSES = ['queued', 'filling', 'awaiting_user'];

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- store

function emptyData() {
  return { version: 1, roles: [], answers: [], queue: [] };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) return emptyData();
  const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
  if (!raw) return emptyData();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Fail closed: never delete or overwrite a corrupt store.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${DATA_FILE}.corrupt-${stamp}.bak`;
      fs.copyFileSync(DATA_FILE, backup);
      console.error(`error: ${DATA_FILE} is not valid JSON (${err.message}). Left untouched; backup at ${backup}`);
    } catch {
      console.error(`error: ${DATA_FILE} is not valid JSON (${err.message}). Left untouched.`);
    }
    process.exit(2);
  }
  data.roles ||= [];
  data.answers ||= [];
  data.queue ||= [];
  return data;
}

function save(data) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, DATA_FILE);
  writeExport(data);
}

function saveProfile(profile) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${PROFILE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`);
  fs.renameSync(tmp, PROFILE_FILE);
}

function nextId(rows) {
  return rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase();
// Canonicalize posting URLs for dedupe without merging distinct roles:
// strip hash + known tracking params only (utm_*, gh_src/gh_jid, lever-*,
// click IDs). All other query params (e.g. ?jobId=) are preserved so
// query-identified postings still dedupe distinctly. No stored data is
// rewritten — both sides go through this on lookup.
const normUrl = (u) => {
  const s = norm(u);
  if (!s) return s;
  try {
    const parsed = new URL(s);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.*|gh_src|gh_jid|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|vero_id)$/i.test(key) || /^lever-/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname) pathname = '';
    const query = parsed.searchParams.toString();
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${query ? `?${query}` : ''}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
};

function findRole(data, query, flags = {}) {
  const q = norm(query);
  if (!q) fail('missing role query (id | url | company | "company:title")');
  if (/^\d+$/.test(q)) {
    const role = data.roles.find((r) => r.id === Number(q));
    if (!role) fail(`no role with id ${q}`);
    return role;
  }
  if (/^https?:\/\//i.test(q)) {
    const role = data.roles.find((r) => normUrl(r.url) === normUrl(q));
    if (!role) fail(`no role with url ${q}`);
    return role;
  }
  if (q.includes(':')) {
    const [company, ...rest] = q.split(':');
    const title = rest.join(':');
    const role = data.roles.find(
      (r) => normKey(r.company) === normKey(company) && normKey(r.title) === normKey(title),
    );
    if (!role) fail(`no role matching "${q}"`);
    return role;
  }
  const exact = data.roles.filter(
    (r) => normKey(r.company) === normKey(q) || normKey(r.title) === normKey(q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail(`"${q}" matches ${exact.length} roles — use the id (tracker list)`);
  const loose = data.roles.filter(
    (r) => normKey(`${r.company} ${r.title}`).includes(normKey(q)),
  );
  if (loose.length === 1) return loose[0];
  if (!loose.length) fail(`no role matching "${q}"`);
  fail(`"${q}" matches ${loose.length} roles — use the id (tracker list)`);
}

function findByDedupe(data, url, company, title) {
  if (norm(url)) {
    const hit = data.roles.find((r) => r.url && normUrl(r.url) === normUrl(url));
    if (hit) return hit;
  }
  return data.roles.find(
    (r) => normKey(r.company) === normKey(company) && normKey(r.title) === normKey(title),
  );
}

function buildRole(input) {
  const at = nowIso();
  return {
    id: 0,
    url: norm(input.url) || null,
    company: norm(input.company),
    title: norm(input.title),
    mode: norm(input.mode) || null,
    location: norm(input.location) || null,
    salary: norm(input.salary ?? input.salary_est) || null,
    posted_at: norm(input.posted_at ?? input.posted) || null,
    source: norm(input.source) || null,
    status: 'shown',
    score: input.score ?? null,
    first_seen_at: at,
    last_seen_at: at,
    applied_at: null,
    notes: input.notes ? [{ at, text: norm(input.notes) }] : [],
    history: [{ at, status: 'shown' }],
  };
}

function insertRole(data, input) {
  const existing = findByDedupe(data, input.url, input.company, input.title);
  if (existing) {
    existing.last_seen_at = nowIso();
    return { role: existing, isNew: false };
  }
  const role = buildRole(input);
  role.id = nextId(data.roles);
  data.roles.push(role);
  return { role, isNew: true };
}

function setStatus(role, status, note) {
  const at = nowIso();
  role.status = status;
  role.last_seen_at = at;
  role.history.push({ at, status });
  if (status === 'applied' && !role.applied_at) role.applied_at = at;
  if (note) role.notes.push({ at, text: note });
}

// ---------------------------------------------------------------- export

function tableRow(cells) {
  return `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
}

function roleTable(roles) {
  const lines = [
    tableRow(['#', 'status', 'company', 'title', 'mode', 'location', 'applied', 'link']),
    tableRow(['--', '------', '-------', '-----', '----', '--------', '-------', '----']),
  ];
  for (const r of roles) {
    const link = r.url ? `[open](${r.url})` : '';
    const applied = r.applied_at ? r.applied_at.slice(0, 10) : '';
    lines.push(tableRow([r.id, r.status, r.company, r.title, r.mode, r.location, applied, link]));
  }
  return lines.join('\n');
}

function buildMarkdown(data) {
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const r of data.roles) counts[r.status] = (counts[r.status] || 0) + 1;
  const byRecency = [...data.roles].sort((a, b) =>
    String(b.last_seen_at).localeCompare(String(a.last_seen_at)),
  );
  const sections = [
    ['Active', byRecency.filter((r) => ACTIVE_STATUSES.includes(r.status))],
    ['Offers & accepted', byRecency.filter((r) => ['offer', 'accepted'].includes(r.status))],
    ['Rejected', byRecency.filter((r) => r.status === 'rejected')],
    ['Withdrew', byRecency.filter((r) => r.status === 'withdrew')],
    ['Expired', byRecency.filter((r) => r.status === 'expired')],
    ['Not interested', byRecency.filter((r) => r.status === 'not_interested')],
    ['Surfaced (not actioned)', byRecency.filter((r) => r.status === 'shown')],
  ];
  const out = [
    '# Job applications',
    '',
    `_Auto-generated by tracker.mjs — last updated ${nowIso()}. Source of truth: data.json (edit that, or use the tracker CLI)._`,
    '',
    '## Summary',
    '',
    tableRow(['status', 'count']),
    tableRow(['------', '-----']),
    ...STATUSES.map((s) => tableRow([s, counts[s]])),
    tableRow(['**total**', `**${data.roles.length}**`]),
  ];
  for (const [name, roles] of sections) {
    if (!roles.length) continue;
    out.push('', `## ${name} (${roles.length})`, '', roleTable(roles));
  }
  out.push('');
  return out.join('\n');
}

function writeExport(data) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(EXPORT_FILE, buildMarkdown(data));
}

// ---------------------------------------------------------------- profile

function defaultProfile() {
  return {
    version: 1,
    identity: {
      name: '', email: '', phone: '', location: '', country: '',
      links: { linkedin: '', github: '', portfolio: '', website: '' },
      years_experience: null,
      headline: '',
    },
    cv: { path: '', stored_path: '', text_path: '', resume_filename: '' },
    targets: { seniority: [], titles: [], skills: [], industries: [], summary: '' },
    search: {
      modes: ['remote', 'hybrid', 'onsite'],
      cities: [], countries: [], remote_scope: [],
      relocation: false,
      timezone: { max_offset_hours: null, notes: '' },
      salary: {
        currency: 'USD', full_time_min: null, full_time_target: null,
        local_currency: '', local_min: null, local_target: null, contract_min: null,
      },
      company_rules: {
        product_only: true,
        exclude_types: ['consultancy', 'staffing', 'bodyshop'],
        exclude_companies: [],
      },
      freshness_days: 7,
      notes: '',
    },
    apply: {
      work_authorization: '', sponsorship_required: false, notice_period: '',
      willing_to_relocate: false, pronouns: '', eeoc: 'decline',
      keychain_service: 'job-search-apply',
      extra: {},
    },
    company_list_urls: [],
    answers: [],
  };
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (base && extra && typeof base === 'object' && typeof extra === 'object') {
    const out = { ...base };
    for (const key of Object.keys(extra)) out[key] = deepMerge(base[key], extra[key]);
    return out;
  }
  return extra === undefined ? base : extra;
}

function loadProfile() {
  if (!fs.existsSync(PROFILE_FILE)) fail(`no profile at ${PROFILE_FILE} — run onboarding first`);
  return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
}

function seedAnswers(data, answers = []) {
  const at = nowIso();
  let n = 0;
  for (const a of answers) {
    if (!a || !a.question || a.answer === undefined) continue;
    const hit = data.answers.find((x) => normKey(x.question) === normKey(a.question));
    if (hit) {
      hit.answer = String(a.answer);
      hit.category = a.category || hit.category || null;
      hit.updated_at = at;
    } else {
      data.answers.push({
        question: String(a.question),
        answer: String(a.answer),
        category: a.category || null,
        updated_at: at,
      });
    }
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------- companies

function emptyCompanies() {
  return { version: 1, learned: [], blocked: [] };
}

function loadCompanies() {
  if (!fs.existsSync(COMPANIES_FILE)) return emptyCompanies();
  const raw = fs.readFileSync(COMPANIES_FILE, 'utf8').trim();
  if (!raw) return emptyCompanies();
  const c = JSON.parse(raw);
  c.learned ||= [];
  c.blocked ||= [];
  c.verified ||= {};
  return c;
}

function saveCompanies(c) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${COMPANIES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`);
  fs.renameSync(tmp, COMPANIES_FILE);
}

function profileBlockedEntries() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return [];
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    const list = profile?.search?.company_rules?.exclude_companies;
    if (!Array.isArray(list)) return [];
    return list
      .map((e) => (typeof e === 'string' ? { name: e } : e))
      .filter((e) => e && e.name)
      .map((e) => ({ name: e.name, reason: e.reason || null, at: e.at || null }));
  } catch {
    return [];
  }
}

function blockedEntries() {
  const map = new Map();
  for (const e of loadCompanies().blocked) {
    if (e && e.name) map.set(normKey(e.name), { name: e.name, reason: e.reason || null, at: e.at || null });
  }
  for (const e of profileBlockedEntries()) {
    if (!map.has(normKey(e.name))) map.set(normKey(e.name), e);
  }
  return [...map.values()];
}

function isBlockedCompany(name) {
  const key = normKey(name);
  if (!key) return false;
  return blockedEntries().some((e) => normKey(e.name) === key);
}

function portalUrl(cell) {
  const clean = String(cell || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const token = clean.split(/\s+/)[0];
  if (!token || !token.includes('.')) return null;
  return /^https?:\/\//i.test(token) ? token : `https://${token}`;
}

function loadStarterCompanies() {
  if (!fs.existsSync(STARTER_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(STARTER_FILE, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const [name, portal, ats] = cells;
    if (!name || name === 'Company' || /^[-: ]+$/.test(name)) continue;
    const url = portalUrl(portal);
    if (!url) continue;
    out.push({ name, url, ats: ats || null, source: 'starter' });
  }
  return out;
}

const VERIFY_ORDER = { dead: 0, moved: 1, error: 2, unreachable: 3, blocked: 4, warn: 5, ok: 6 };
const daysSince = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchStatus(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const normalize = (u) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'job-search-skills/1.0 (portal health check)' },
    });
    const ms = Date.now() - started;
    const finalUrl = res.url || url;
    try {
      await res.body?.cancel();
    } catch { /* body already gone */ }
    const http = res.status;
    if (http >= 200 && http < 300) {
      return normalize(finalUrl) === normalize(url)
        ? { status: 'ok', http, finalUrl, ms }
        : { status: 'moved', http, finalUrl, ms };
    }
    if (http === 404 || http === 410) return { status: 'dead', http, finalUrl, ms };
    const workday = /myworkdayjobs\.com/i.test(url);
    if (http === 403 || http === 406 || http === 429 || (workday && http >= 500)) {
      return { status: 'blocked', http, finalUrl, ms };
    }
    if (http >= 500) return { status: 'error', http, finalUrl, ms };
    return { status: 'warn', http, finalUrl, ms };
  } catch (err) {
    return {
      status: 'unreachable',
      http: null,
      error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function atsApiUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (!slug) return null;
    if (host === 'ashbyhq.com' || host.endsWith('.ashbyhq.com')) {
      return { ats: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${slug}` };
    }
    if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
      return { ats: 'gh', url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` };
    }
    if (host === 'lever.co' || host.endsWith('.lever.co')) {
      return { ats: 'lever', url: `https://api.lever.co/v0/postings/${slug}?mode=json` };
    }
    return null;
  } catch {
    return null;
  }
}

async function checkPortal(url, timeoutMs) {
  const res = await fetchStatus(url, timeoutMs);
  if (res.status !== 'ok' && res.status !== 'moved') return res;
  const api = atsApiUrl(url);
  if (!api) return res;
  const apiRes = await fetchStatus(api.url, timeoutMs);
  res.api = { url: api.url, http: apiRes.http ?? null };
  if (apiRes.http === 404 || apiRes.http === 410) {
    return { ...res, status: 'dead', http: apiRes.http, via: 'board API' };
  }
  return res;
}

// ---------------------------------------------------------------- args + output

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function fail(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function requireStatus(status, list) {
  if (!list.includes(status)) fail(`bad status "${status}" (use one of: ${list.join(', ')})`);
}

// ---------------------------------------------------------------- commands

const commands = {
  init() {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) save(load());
    console.log(`tracker ready: ${DATA_FILE}`);
    console.log(`profile:  ${PROFILE_FILE}${fs.existsSync(PROFILE_FILE) ? '' : ' (missing — run onboarding)'}`);
  },

  stats() {
    const data = load();
    const counts = {};
    for (const r of data.roles) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const s of STATUSES) console.log(`${String(counts[s] || 0).padStart(4)}  ${s}`);
    console.log(`${String(data.roles.length).padStart(4)}  total`);
    console.log(`${String(data.answers.length).padStart(4)}  stored answers`);
    const open = data.queue.filter((q) => OPEN_QUEUE_STATUSES.includes(q.status)).length;
    console.log(`${String(open).padStart(4)}  open apply-queue rows`);
  },

  seen(pos, flags) {
    const [url, company, title] = pos;
    if (!url && !company) fail('usage: seen <url> <company> <title> [--mode M --location L --salary S --posted D --source SRC]');
    const data = load();
    const { role, isNew } = insertRole(data, {
      url, company, title,
      mode: flags.mode, location: flags.location, salary: flags.salary,
      posted_at: flags.posted, source: flags.source || 'job_search',
    });
    save(data);
    if (company && isBlockedCompany(company)) {
      console.error(`warn: "${norm(company)}" is on the ignored list — do not surface this role`);
    }
    if (!isNew) {
      console.log('ALREADY SEEN');
      console.log(`id=${role.id}`);
      process.exit(1);
    }
    console.log('NEW');
    console.log(`id=${role.id}`);
  },

  'add-batch'(pos) {
    const file = pos[0];
    if (!file) fail('usage: add-batch <file.json|->  (JSON array of role objects)');
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) fail('add-batch expects a JSON array');
    const data = load();
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const { isNew } = insertRole(data, row);
      if (isNew) added += 1;
      else skipped += 1;
    }
    save(data);
    console.log(`added ${added} new / ${skipped} already seen`);
  },

  mark(pos, flags) {
    const [status, ...rest] = pos;
    const query = rest.join(' ');
    requireStatus(status, STATUSES);
    const data = load();
    const role = findRole(data, query, flags);
    setStatus(role, status, flags.note || null);
    save(data);
    console.log(`role ${role.id} (${role.company} — ${role.title}) -> ${status}`);
  },

  note(pos) {
    const [query, ...rest] = pos;
    const text = rest.join(' ');
    if (!query || !text) fail('usage: note <id|url|company|"company:title"> <text>');
    const data = load();
    const role = findRole(data, query);
    role.notes.push({ at: nowIso(), text });
    role.last_seen_at = nowIso();
    save(data);
    console.log(`note saved on role ${role.id}`);
  },

  role(pos, flags) {
    const data = load();
    const role = findRole(data, pos.join(' '), flags);
    console.log(JSON.stringify(role, null, 2));
  },

  list(pos, flags) {
    const data = load();
    let roles = [...data.roles].sort((a, b) =>
      String(b.last_seen_at).localeCompare(String(a.last_seen_at)),
    );
    if (flags.status && flags.status !== 'all') {
      requireStatus(flags.status, STATUSES);
      roles = roles.filter((r) => r.status === flags.status);
    }
    if (!flags.all) roles = roles.slice(0, Number(flags.limit || 20));
    if (flags.json) {
      console.log(JSON.stringify(roles, null, 2));
      return;
    }
    if (!roles.length) {
      console.log('(no roles)');
      return;
    }
    for (const r of roles) {
      const loc = [r.mode, r.location].filter(Boolean).join(' · ');
      console.log(`#${r.id} [${r.status}] ${r.company} — ${r.title}${loc ? ` (${loc})` : ''}`);
    }
  },

  async company(pos, flags) {
    const sub = pos[0];
    if (sub === 'list') {
      const c = loadCompanies();
      const ignored = blockedEntries();
      if (flags.json) {
        console.log(JSON.stringify({ learned: c.learned, ignored }, null, 2));
        return;
      }
      if (c.learned.length) {
        console.log('learned sweep targets (sweep after the starter universe):');
        for (const e of c.learned) {
          const rec = c.verified?.[normKey(e.name)];
          const checked = rec ? `checked ${String(rec.at).slice(0, 10)} ${rec.status}` : null;
          const meta = [e.portal, e.ats && `[${e.ats}]`, e.note && `(${e.note})`, checked].filter(Boolean).join(' ');
          console.log(`  ${e.name}${meta ? ` — ${meta}` : ''}`);
        }
      } else {
        console.log('learned sweep targets: (none — add one with "company add <name> <portal>")');
      }
      if (ignored.length) {
        console.log('ignored companies (never sweep or surface):');
        for (const e of ignored) console.log(`  ${e.name}${e.reason ? ` — ${e.reason}` : ''}`);
      } else {
        console.log('ignored companies: (none)');
      }
      return;
    }

    if (sub === 'add') {
      const [name, portal] = pos.slice(1);
      if (!name) fail('usage: company add <name> <portal> [--ats ashby|gh|lever|wd|sr|workable|icims|own] [--note text]');
      const c = loadCompanies();
      const hit = c.learned.find((e) => normKey(e.name) === normKey(name));
      const at = nowIso();
      if (hit) {
        if (portal) {
          hit.portal = norm(portal);
          delete c.verified?.[normKey(name)];
        }
        if (flags.ats) hit.ats = norm(flags.ats);
        if (flags.note) hit.note = norm(flags.note);
        hit.updated_at = at;
      } else {
        c.learned.push({
          name: norm(name),
          portal: norm(portal) || null,
          ats: norm(flags.ats) || null,
          note: norm(flags.note) || null,
          added_at: at,
          updated_at: at,
        });
      }
      saveCompanies(c);
      console.log(`company ${hit ? 'updated' : 'learned'}: ${norm(name)}${portal ? ` (${norm(portal)})` : ''}`);
      return;
    }

    if (sub === 'ignore') {
      const name = pos.slice(1).join(' ');
      if (!name) fail('usage: company ignore <name> [--reason "..."]');
      if (!fs.existsSync(PROFILE_FILE)) fail(`no profile at ${PROFILE_FILE} — run onboarding first`);
      const reason = norm(flags.reason) || null;
      const key = normKey(name);

      const profile = loadProfile();
      profile.search ||= {};
      profile.search.company_rules ||= {};
      if (!Array.isArray(profile.search.company_rules.exclude_companies)) {
        profile.search.company_rules.exclude_companies = [];
      }
      const list = profile.search.company_rules.exclude_companies;
      const already = list.some((e) => normKey(typeof e === 'string' ? e : e?.name) === key);
      if (!already) list.push(norm(name));
      saveProfile(profile);

      const c = loadCompanies();
      const learnedBefore = c.learned.length;
      c.learned = c.learned.filter((e) => normKey(e.name) !== key);
      delete c.verified?.[key];
      const at = nowIso();
      const meta = c.blocked.find((e) => normKey(e.name) === key);
      if (meta) {
        meta.reason = reason || meta.reason || null;
        meta.updated_at = at;
      } else {
        c.blocked.push({ name: norm(name), reason, at, updated_at: at });
      }
      saveCompanies(c);

      const data = load();
      let marked = 0;
      let aborted = 0;
      for (const role of data.roles) {
        if (normKey(role.company) !== key || !['shown', 'interested'].includes(role.status)) continue;
        setStatus(role, 'not_interested', `company ignored${reason ? `: ${reason}` : ''}`);
        marked += 1;
        for (const row of data.queue) {
          if (row.role_id === role.id && OPEN_QUEUE_STATUSES.includes(row.status)) {
            row.status = 'aborted';
            row.message = `company ignored${reason ? `: ${reason}` : ''}`;
            row.updated_at = at;
            aborted += 1;
          }
        }
      }
      if (marked || aborted) save(data);
      console.log(`ignored: ${norm(name)}${reason ? ` (${reason})` : ''}`);
      if (learnedBefore !== c.learned.length) console.log('  removed from the learned sweep list');
      console.log(`  ${marked} tracked role(s) marked not_interested, ${aborted} open apply row(s) aborted`);
      return;
    }

    if (sub === 'unignore') {
      const name = pos.slice(1).join(' ');
      if (!name) fail('usage: company unignore <name>');
      const key = normKey(name);
      let removed = 0;

      const profile = loadProfile();
      profile.search ||= {};
      profile.search.company_rules ||= {};
      const list = Array.isArray(profile.search.company_rules.exclude_companies)
        ? profile.search.company_rules.exclude_companies
        : [];
      const next = list.filter((e) => normKey(typeof e === 'string' ? e : e?.name) !== key);
      removed += list.length - next.length;
      profile.search.company_rules.exclude_companies = next;
      saveProfile(profile);

      const c = loadCompanies();
      const before = c.blocked.length;
      c.blocked = c.blocked.filter((e) => normKey(e.name) !== key);
      removed += before - c.blocked.length;
      saveCompanies(c);

      console.log(removed ? `unignored: ${norm(name)}` : `not on the ignored list: ${norm(name)}`);
      return;
    }

    if (sub === 'candidates') {
      const min = Math.max(1, Number(flags.min || 2));
      const blocked = new Set(blockedEntries().map((e) => normKey(e.name)));
      const declines = new Map();
      for (const role of load().roles) {
        if (role.status !== 'not_interested') continue;
        const key = normKey(role.company);
        if (!key || blocked.has(key)) continue;
        const entry = declines.get(key) || { name: role.company, count: 0, last: null };
        entry.count += 1;
        if (!entry.last || String(role.last_seen_at) > String(entry.last_at || '')) {
          entry.last = role.title;
          entry.last_at = role.last_seen_at;
        }
        declines.set(key, entry);
      }
      const rows = [...declines.values()]
        .filter((e) => e.count >= min)
        .sort((a, b) => b.count - a.count);
      if (flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log(`(no companies with ${min}+ declined roles)`);
        return;
      }
      for (const e of rows) console.log(`${e.name} — ${e.count} declined (last: ${e.last})`);
      return;
    }

    if (sub === 'verify') {
      const filter = pos.slice(1).join(' ').trim();
      const timeoutMs = Math.max(1000, Number(flags.timeout || 8000));
      const concurrency = Math.min(16, Math.max(1, Number(flags.concurrency || 8)));
      const c = loadCompanies();
      const verified = (c.verified ||= {});

      const noPortal = [];
      const targets = [];
      for (const e of c.learned) {
        const url = portalUrl(e.portal || '');
        if (url) targets.push({ name: e.name, url, ats: e.ats || null, source: 'learned' });
        else noPortal.push(e.name);
      }
      if (!flags.learned) {
        const keys = new Set(targets.map((t) => normKey(t.name)));
        for (const t of loadStarterCompanies()) {
          if (!keys.has(normKey(t.name))) targets.push(t);
        }
      }
      let due = filter ? targets.filter((t) => normKey(t.name).includes(normKey(filter))) : targets;
      if (flags.stale && Number.isFinite(Number(flags.stale))) {
        const days = Number(flags.stale);
        due = due.filter((t) => {
          const rec = verified[normKey(t.name)];
          return !rec?.at || daysSince(rec.at) >= days;
        });
      }

      if (flags['dry-run']) {
        for (const t of due) console.log(`${t.source}  ${t.name} — ${t.url}`);
        if (noPortal.length) console.log(`skipped (no portal): ${noPortal.join(', ')}`);
        console.log(`${due.length} portal(s) would be checked`);
        return;
      }

      const at = nowIso();
      const results = await mapPool(due, concurrency, async (t) => ({
        ...t,
        ...(await checkPortal(t.url, timeoutMs)),
      }));
      for (const r of results) {
        const key = normKey(r.name);
        verified[key] = { at, status: r.status, http: r.http ?? null, url: r.url, final_url: r.finalUrl || null };
        if (r.source === 'learned') {
          const entry = c.learned.find((e) => normKey(e.name) === key);
          if (entry) entry.last_verified_at = at;
        }
      }
      c.verified = verified;
      saveCompanies(c);

      const sorted = [...results].sort((a, b) =>
        (VERIFY_ORDER[a.status] ?? 9) - (VERIFY_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name),
      );
      if (flags.json) {
        console.log(JSON.stringify(sorted, null, 2));
      } else {
        for (const r of sorted) {
          if (flags.quiet && r.status === 'ok') continue;
          const detail = r.status === 'moved' ? `${r.url} → ${r.finalUrl}`
            : r.status === 'blocked' ? `${r.url} (HTTP ${r.http}, bot-block — use a browser)`
              : r.status === 'unreachable' ? `${r.url} (${r.error})`
                : r.status === 'ok' ? r.url
                  : `${r.url} (HTTP ${r.http}${r.via ? ` via ${r.via}` : ''})`;
          console.log(`${r.status.padEnd(11)} ${r.name} — ${detail}`);
        }
        const counts = {};
        for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
        const parts = Object.entries(counts)
          .sort((a, b) => (VERIFY_ORDER[a[0]] ?? 9) - (VERIFY_ORDER[b[0]] ?? 9))
          .map(([k, v]) => `${v} ${k}`);
        console.log(`checked ${results.length} portal(s)${parts.length ? `: ${parts.join(' · ')}` : ''}`);
        if (noPortal.length) console.log(`skipped (no portal): ${noPortal.join(', ')}`);
        if (counts.dead) {
          console.log('dead boards: point at the new portal with "company add", or "company ignore" if gone for good');
        }
      }
      if (results.some((r) => r.status === 'dead')) process.exitCode = 1;
      return;
    }

    fail('usage: company list|add|ignore|unignore|candidates|verify');
  },

  export() {
    const data = load();
    writeExport(data);
    console.log(EXPORT_FILE);
  },

  qa(pos, flags) {
    const sub = pos[0];
    const data = load();
    if (sub === 'get') {
      const q = normKey(pos.slice(1).join(' '));
      if (!q) fail('usage: qa get "<question>"');
      const exact = data.answers.find((a) => normKey(a.question) === q);
      const loose = exact || data.answers.find(
        (a) => normKey(a.question).includes(q) || q.includes(normKey(a.question)),
      );
      if (!loose) process.exit(1);
      console.log(loose.answer);
      return;
    }
    if (sub === 'set') {
      const [question, ...rest] = pos.slice(1);
      const answer = rest.join(' ');
      if (!question || !answer) fail('usage: qa set "<question>" "<answer>" [--category C]');
      const at = nowIso();
      const hit = data.answers.find((a) => normKey(a.question) === normKey(question));
      if (hit) {
        hit.answer = answer;
        hit.category = flags.category || hit.category || null;
        hit.updated_at = at;
      } else {
        data.answers.push({ question, answer, category: flags.category || null, updated_at: at });
      }
      save(data);
      console.log(`qa saved: ${question}`);
      return;
    }
    if (sub === 'list') {
      if (!data.answers.length) {
        console.log('(no stored answers)');
        return;
      }
      for (const a of data.answers) {
        const preview = a.answer.length > 60 ? `${a.answer.slice(0, 57)}...` : a.answer;
        console.log(`[${a.category || 'general'}] ${a.question} -> ${preview}`);
      }
      return;
    }
    fail('usage: qa get|set|list');
  },

  queue(pos, flags) {
    const sub = pos[0];
    const data = load();
    const at = nowIso();
    if (sub === 'add') {
      const role = findRole(data, pos.slice(1).join(' '), flags);
      if (APPLIED_STATUSES.includes(role.status)) {
        console.error(`warn: role ${role.id} (${role.company} — ${role.title}) is already "${role.status}" — applying again would duplicate`);
      }
      const row = { id: nextId(data.queue), role_id: role.id, portal: flags.portal || null, status: 'queued', message: '', step: '', created_at: at, updated_at: at };
      data.queue.push(row);
      save(data);
      console.log(`queue id=${row.id} role=${role.id} (${role.company} — ${role.title})`);
      return;
    }
    if (sub === 'fill') {
      const status = flags.status || 'interested';
      requireStatus(status, STATUSES);
      const limit = Number(flags.limit || 0);
      const open = new Set(data.queue.filter((q) => OPEN_QUEUE_STATUSES.includes(q.status)).map((q) => q.role_id));
      let candidates = data.roles.filter((r) => r.status === status && !open.has(r.id));
      candidates.sort((a, b) => String(a.last_seen_at).localeCompare(String(b.last_seen_at)));
      if (limit > 0) candidates = candidates.slice(0, limit);
      for (const role of candidates) {
        data.queue.push({ id: nextId(data.queue), role_id: role.id, portal: null, status: 'queued', message: '', step: '', created_at: at, updated_at: at });
      }
      if (candidates.length) save(data);
      console.log(`queued ${candidates.length} role(s) with status "${status}"`);
      for (const role of candidates) {
        const row = data.queue.find((q) => q.role_id === role.id && q.status === 'queued');
        console.log(`queue id=${row.id} role=${role.id} (${role.company} — ${role.title})`);
      }
      return;
    }
    if (sub === 'list') {
      let rows = data.queue;
      if (flags.status) {
        requireStatus(flags.status, QUEUE_STATUSES);
        rows = rows.filter((q) => q.status === flags.status);
      }
      if (flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log('(queue empty)');
        return;
      }
      for (const q of rows) {
        const role = data.roles.find((r) => r.id === q.role_id) || {};
        console.log(`queue#${q.id} [${q.status}] role#${q.role_id} ${role.company || '?'} — ${role.title || '?'}${q.step ? ` · ${q.step}` : ''}${q.message ? ` · ${q.message}` : ''}`);
      }
      return;
    }
    if (sub === 'get') {
      const id = Number(pos[1]);
      const row = data.queue.find((q) => q.id === id);
      if (!row) fail(`no queue row ${id}`);
      const role = data.roles.find((r) => r.id === row.role_id) || null;
      console.log(JSON.stringify({ queue: row, role }, null, 2));
      return;
    }
    if (sub === 'set') {
      const id = Number(pos[1]);
      const status = pos[2];
      requireStatus(status, QUEUE_STATUSES);
      const row = data.queue.find((q) => q.id === id);
      if (!row) fail(`no queue row ${id}`);
      row.status = status;
      row.message = pos.slice(3).join(' ') || '';
      row.updated_at = at;
      save(data);
      console.log(`queue ${id} -> ${status}`);
      return;
    }
    if (sub === 'step') {
      const id = Number(pos[1]);
      const row = data.queue.find((q) => q.id === id);
      if (!row) fail(`no queue row ${id}`);
      row.step = pos.slice(2).join(' ');
      row.updated_at = at;
      save(data);
      console.log(`queue ${id} step: ${row.step}`);
      return;
    }
    if (sub === 'complete') {
      const roleId = Number(pos[1]);
      const queueId = Number(pos[2]);
      const role = data.roles.find((r) => r.id === roleId);
      if (!role) fail(`no role ${roleId}`);
      const row = data.queue.find((q) => q.id === queueId);
      if (!row) fail(`no queue row ${queueId}`);
      if (row.role_id !== roleId) fail(`queue ${queueId} belongs to role ${row.role_id}, not role ${roleId} — refusing to mark the wrong role applied`);
      setStatus(role, 'applied', pos.slice(3).join(' ') || 'submitted via apply-to-jobs');
      row.status = 'applied';
      row.message = pos.slice(3).join(' ') || 'submitted';
      row.updated_at = at;
      save(data);
      console.log(`role ${roleId} marked applied (queue ${queueId})`);
      return;
    }
    fail('usage: queue add|fill|list|get|set|step|complete');
  },

  profile(pos, flags) {
    const sub = pos[0];
    if (sub === 'path') {
      if (!fs.existsSync(PROFILE_FILE)) {
        console.error(`profile missing: ${PROFILE_FILE} (run onboarding)`);
        process.exit(1);
      }
      console.log(PROFILE_FILE);
      return;
    }
    if (sub === 'show') {
      console.log(JSON.stringify(loadProfile(), null, 2));
      return;
    }
    if (sub === 'get') {
      const key = pos[1];
      if (!key) fail('usage: profile get <dot.path>');
      let node = loadProfile();
      for (const part of key.split('.')) node = node?.[part];
      console.log(typeof node === 'string' ? node : JSON.stringify(node ?? null));
      return;
    }
    if (sub === 'set') {
      const key = pos[1];
      const rawValue = pos.slice(2).join(' ');
      if (!key || !rawValue) fail('usage: profile set <dot.path> "<value>"');
      const profile = fs.existsSync(PROFILE_FILE) ? loadProfile() : defaultProfile();
      let value;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
      const parts = key.split('.');
      let node = profile;
      for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
        node = node[part];
      }
      node[parts.at(-1)] = value;
      saveProfile(profile);
      console.log(`profile set: ${key} = ${JSON.stringify(value)}`);
      return;
    }
    if (sub === 'import') {
      const file = pos[1];
      if (!file) fail('usage: profile import <file.json>');
      const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
      const profile = deepMerge(defaultProfile(), incoming);
      saveProfile(profile);
      const data = load();
      const n = seedAnswers(data, profile.answers || []);
      save(data);
      console.log(`profile imported: ${PROFILE_FILE}`);
      console.log(`seeded ${n} answer(s) into the answer bank`);
      return;
    }
    fail('usage: profile import|show|get|set|path');
  },

  report(pos) {
    const [sub, file, ...labelParts] = pos;
    if (sub !== 'save' || !file) fail('usage: report save <file.md> [label]');
    const label = (labelParts.join('-') || 'search').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = nowIso().slice(0, 10);
    // Never overwrite an existing report: add -2, -3… suffix.
    let dest = path.join(REPORTS_DIR, `${stamp}-${label}.md`);
    for (let n = 2; fs.existsSync(dest); n += 1) {
      dest = path.join(REPORTS_DIR, `${stamp}-${label}-${n}.md`);
    }
    fs.copyFileSync(file, dest);
    console.log(dest);
  },

  'import-sqlite'(pos, flags) {
    const file = pos[0];
    if (!file) fail('usage: import-sqlite <path-to-jobs.db> [--queue]');
    if (!fs.existsSync(file)) fail(`no such file: ${file}`);
    const query = (sql) => JSON.parse(execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }) || '[]');
    let roles = [];
    let qa = [];
    let queue = [];
    try {
      roles = query('SELECT id, url, company, title, source, mode, location, salary_est, posted_at, status, first_shown_at, last_shown_at, notes FROM roles ORDER BY id');
    } catch (err) {
      fail(`could not read roles from ${file}: ${err.message}`);
    }
    try {
      qa = query('SELECT question, answer, category, updated_at FROM apply_qa');
    } catch { /* older db without apply_qa */ }
    try {
      queue = query("SELECT role_id, portal, status, message, step, created_at, updated_at FROM apply_queue WHERE status IN ('queued','filling','awaiting_user')");
    } catch { /* older db without apply_queue */ }

    const data = load();
    const idMap = new Map();
    let added = 0;
    let skipped = 0;
    for (const row of roles) {
      const { role, isNew } = insertRole(data, { ...row, salary: row.salary_est });
      idMap.set(row.id, role.id);
      if (!isNew) skipped += 1;
      else added += 1;
      if (!isNew) continue;
      if (row.status && row.status !== 'shown') {
        role.status = row.status;
        role.history = [
          { at: row.first_shown_at ? `${row.first_shown_at.replace(' ', 'T')}Z` : nowIso(), status: 'shown' },
          { at: row.last_shown_at ? `${row.last_shown_at.replace(' ', 'T')}Z` : nowIso(), status: row.status },
        ];
      }
      if (row.first_shown_at) role.first_seen_at = `${row.first_shown_at.replace(' ', 'T')}Z`;
      if (row.last_shown_at) role.last_seen_at = `${row.last_shown_at.replace(' ', 'T')}Z`;
      if (row.status === 'applied') role.applied_at = role.last_seen_at;
      if (row.notes) role.notes = [{ at: role.last_seen_at, text: row.notes }];
    }
    const seeded = seedAnswers(data, qa);
    let queued = 0;
    for (const row of flags.queue ? queue : []) {
      const roleId = idMap.get(row.role_id);
      if (!roleId) continue;
      data.queue.push({
        id: nextId(data.queue),
        role_id: roleId,
        portal: row.portal || null,
        status: row.status,
        message: row.message || '',
        step: row.step || '',
        created_at: row.created_at ? `${row.created_at.replace(' ', 'T')}Z` : nowIso(),
        updated_at: row.updated_at ? `${row.updated_at.replace(' ', 'T')}Z` : nowIso(),
      });
      queued += 1;
    }
    save(data);
    console.log(`imported from ${file}`);
    console.log(`  roles:   ${added} added, ${skipped} already present (${roles.length} read)`);
    console.log(`  answers: ${seeded} seeded (${qa.length} read)`);
    console.log(
      flags.queue
        ? `  queue:   ${queued} open row(s) restored`
        : `  queue:   skipped ${queue.length} open row(s) from the old app (pass --queue to restore)`,
    );
    console.log(`home: ${HOME}`);
  },

  selftest() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-selftest-'));
    const self = fileURLToPath(import.meta.url);
    const env = { ...process.env, JOB_SEARCH_HOME: tmp };
    const run = (args) => execFileSync(process.execPath, [self, ...args], { encoding: 'utf8', env });
    const runFail = (args, code) => {
      try {
        execFileSync(process.execPath, [self, ...args], { encoding: 'utf8', env });
      } catch (err) {
        if (err.status === code) return err.stdout || '';
        throw new Error(`expected exit ${code}, got ${err.status}`);
      }
      throw new Error(`expected exit ${code}, command succeeded: ${args.join(' ')}`);
    };
    const checks = [];
    const check = (name, fn) => {
      try {
        fn();
        checks.push(`ok   ${name}`);
      } catch (err) {
        checks.push(`FAIL ${name}: ${err.message}`);
        process.exitCode = 1;
      }
    };

    run(['init']);
    check('seen NEW', () => {
      if (!run(['seen', 'https://example.com/jobs/1', 'Acme', 'Staff Engineer', '--mode', 'remote']).startsWith('NEW')) throw new Error('expected NEW');
    });
    check('seen dedupes by url', () => {
      const out = runFail(['seen', 'https://example.com/jobs/1', 'Acme', 'Staff Engineer'], 1);
      if (!out.startsWith('ALREADY SEEN')) throw new Error(`expected ALREADY SEEN, got ${out}`);
    });
    check('add-batch', () => {
      const file = path.join(tmp, 'batch.json');
      fs.writeFileSync(file, JSON.stringify([
        { company: 'Globex', title: 'Principal Engineer', url: 'https://example.com/jobs/2', mode: 'hybrid', location: 'Berlin' },
        { company: 'Initech', title: 'Frontend Lead', url: 'https://example.com/jobs/3' },
      ]));
      const out = run(['add-batch', file]);
      if (!out.includes('added 2 new')) throw new Error(out);
    });
    check('mark + list', () => {
      run(['mark', 'interested', 'Globex']);
      const out = run(['list', '--status', 'interested']);
      if (!out.includes('Globex')) throw new Error(out);
    });
    check('qa set/get', () => {
      run(['qa', 'set', 'What is your notice period?', '30 days', '--category', 'logistics']);
      if (run(['qa', 'get', 'notice period']).trim() !== '30 days') throw new Error('qa lookup failed');
    });
    check('queue lifecycle', () => {
      run(['queue', 'fill', '--status', 'interested']);
      const list = run(['queue', 'list']);
      const match = list.match(/queue#(\d+)/);
      if (!match) throw new Error(list);
      run(['queue', 'set', match[1], 'awaiting_user', 'CAPTCHA']);
      const detail = JSON.parse(run(['queue', 'get', match[1]]));
      if (detail.queue.status !== 'awaiting_user') throw new Error('queue status not saved');
      run(['queue', 'complete', String(detail.role.id), match[1], 'submitted']);
      const stats = run(['stats']);
      if (!/1\s+applied/.test(stats)) throw new Error(stats);
    });
    check('queue add warns on already-applied role', () => {
      const out = spawnSync(process.execPath, [self, 'queue', 'add', 'Globex'], { encoding: 'utf8', env });
      if (!String(out.stderr).includes('already')) throw new Error(`no warning: ${out.stderr}`);
    });
    check('profile gate + import seeds answers', () => {
      runFail(['profile', 'path'], 1);
      const profilePath = path.join(tmp, 'profile.json');
      fs.writeFileSync(profilePath, JSON.stringify({
        identity: { name: 'Test User', email: 'test@example.com' },
        answers: [{ question: 'Do you require visa sponsorship?', answer: 'No' }],
      }));
      run(['profile', 'import', profilePath]);
      if (run(['profile', 'get', 'identity.name']).trim() !== 'Test User') throw new Error('profile not stored');
      if (run(['qa', 'get', 'visa sponsorship']).trim() !== 'No') throw new Error('answers not seeded');
    });
    check('company learned list', () => {
      const out = run(['company', 'add', 'Globex', 'jobs.ashbyhq.com/globex', '--ats', 'ashby']);
      if (!out.includes('learned')) throw new Error(out);
      if (!run(['company', 'list']).includes('jobs.ashbyhq.com/globex')) throw new Error('not listed');
    });
    check('company candidates + ignore', () => {
      run(['seen', 'https://example.com/jobs/4', 'Hooli', 'Staff SRE']);
      run(['seen', 'https://example.com/jobs/5', 'Hooli', 'Platform Engineer']);
      run(['mark', 'not_interested', 'Hooli:Staff SRE']);
      run(['mark', 'not_interested', 'Hooli:Platform Engineer']);
      const cands = run(['company', 'candidates', '--min', '2']);
      if (!cands.includes('Hooli')) throw new Error(cands);
      const out = run(['company', 'ignore', 'Hooli', '--reason', 'declined twice']);
      if (!out.includes('ignored: Hooli')) throw new Error(out);
      if (!run(['profile', 'get', 'search.company_rules.exclude_companies']).includes('Hooli')) throw new Error('missing from profile exclude list');
      const list = run(['company', 'list']);
      if (!list.includes('ignored companies') || !list.includes('Hooli')) throw new Error(list);
      if (run(['company', 'candidates', '--min', '2']).includes('Hooli')) throw new Error('ignored company still suggested');
      run(['company', 'unignore', 'Hooli']);
      if (run(['company', 'list']).includes('Hooli')) throw new Error('Hooli still ignored after unignore');
    });
    check('company verify dry-run', () => {
      const all = run(['company', 'verify', '--dry-run']);
      if (!all.includes('OpenAI')) throw new Error('starter list not parsed');
      if (!all.includes('Globex')) throw new Error('learned company missing');
      const one = run(['company', 'verify', 'Globex', '--learned', '--dry-run']);
      if (!one.includes('Globex') || one.includes('OpenAI')) throw new Error(one);
    });
    check('export written', () => {
      run(['mark', 'rejected', 'Initech']);
      run(['export']);
      const md = fs.readFileSync(path.join(tmp, 'applications.md'), 'utf8');
      if (!md.includes('Globex') || !md.includes('## Rejected') || !md.includes('Initech')) throw new Error('export missing sections');
    });

    console.log(checks.join('\n'));
    console.log(process.exitCode ? 'SELFTEST FAILED' : 'SELFTEST PASSED');
  },
};

// ---------------------------------------------------------------- main

function usage() {
  console.log(`tracker.mjs — local job-search tracker (home: ${HOME})

usage: node tracker.mjs <command> [args]

  init                                  create the store / print paths
  stats                                 counts by status
  seen <url> <company> <title> [flags]  dedupe check + record (exit 1 = ALREADY SEEN)
  add-batch <file.json|->               bulk-add roles from JSON
  mark <status> <id|url|company|title>  set pipeline status [--note text]
  note <id|...> <text>                  append a note
  role <id|...>                         print one role as JSON
  list [--status S] [--limit N] [--all] [--json]
  company list|add|ignore|unignore|candidates   learned companies + ignore list
  company verify [name] [--learned --stale D --dry-run --quiet --json]
                                                health-check starter + learned portals
  export                                regenerate applications.md
  qa get|set|list                       reusable application answers
  queue add|fill|list|get|set|step|complete   apply-run state
  profile import|show|get|set|path      user profile
  report save <file.md> [label]         archive a search report
  import-sqlite <jobs.db>               one-time migration from the old SQLite tracker
  selftest                              run built-in tests in a temp home`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  usage();
  process.exit(cmd ? 0 : 2);
}
if (!commands[cmd]) {
  usage();
  fail(`unknown command: ${cmd}`);
}
const { pos, flags } = parseArgs(rest);
await commands[cmd](pos, flags);
