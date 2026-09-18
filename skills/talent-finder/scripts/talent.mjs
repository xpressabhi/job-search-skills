#!/usr/bin/env node
// talent.mjs — solo-headhunter shortlister (roles, candidates, match).
// Zero dependencies; Node 18+. Data lives in TALENT_HOME (default ~/.talent-search).
// Shortlist only: no auto-outreach, no bulk messaging, no scrapers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.TALENT_HOME
  ? path.resolve(process.env.TALENT_HOME)
  : path.join(os.homedir(), '.talent-search');
const STORE_FILE = path.join(HOME, 'store.json');
const REPORTS_DIR = path.join(HOME, 'reports');
const EXPORT_FILE = path.join(HOME, 'talent.md');

const CANDIDATE_STATUSES = [
  'new', 'shortlisted', 'contacted', 'screening', 'submitted', 'placed',
  'rejected', 'withdrew', 'not_interested', 'duplicate',
];
const MATCHABLE = ['new', 'shortlisted'];
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- store

function emptyStore() {
  return { version: 1, roles: [], candidates: [] };
}

function load() {
  if (!fs.existsSync(STORE_FILE)) return emptyStore();
  const raw = fs.readFileSync(STORE_FILE, 'utf8').trim();
  if (!raw) return emptyStore();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Fail closed: never delete or overwrite a corrupt store.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${STORE_FILE}.corrupt-${stamp}.bak`;
      fs.copyFileSync(STORE_FILE, backup);
      console.error(`error: ${STORE_FILE} is not valid JSON (${err.message}). Left untouched; backup at ${backup}`);
    } catch {
      console.error(`error: ${STORE_FILE} is not valid JSON (${err.message}). Left untouched.`);
    }
    process.exit(2);
  }
  data.roles ||= [];
  data.candidates ||= [];
  return data;
}

function save(data) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, STORE_FILE);
}

function nextId(rows) {
  return rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const normKey = (s) => norm(s).toLowerCase();
const splitList = (s) => String(s ?? '').split(/[;\n]+/).map(norm).filter(Boolean);

function normLinkedin(u) {
  const s = norm(u);
  if (!s) return '';
  try {
    const p = new URL(s);
    p.hash = '';
    p.search = '';
    let pathname = p.pathname.replace(/\/+$/, '');
    return `${p.protocol}//${p.host.toLowerCase()}${pathname}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

function findCandidateByDedupe(data, { email, linkedin, name }) {
  const em = normKey(email);
  if (em) {
    const hit = data.candidates.find((c) => normKey(c.email) === em);
    if (hit) return hit;
  }
  const li = normLinkedin(linkedin);
  if (li) {
    const hit = data.candidates.find((c) => c.linkedin && normLinkedin(c.linkedin) === li);
    if (hit) return hit;
  }
  const nm = normKey(name);
  if (nm) return data.candidates.find((c) => normKey(c.name) === nm) || null;
  return null;
}

function insertCandidate(data, input) {
  const existing = findCandidateByDedupe(data, input);
  if (existing) {
    existing.last_seen_at = nowIso();
    return { row: existing, isNew: false };
  }
  const at = nowIso();
  const row = {
    id: nextId(data.candidates),
    name: norm(input.name),
    email: norm(input.email) || null,
    linkedin: norm(input.linkedin) || null,
    location: norm(input.location) || null,
    years: input.years === undefined || input.years === null || input.years === '' ? null : Number(input.years),
    stack: norm(input.stack) || null,
    text: norm(input.text) || null,
    source: norm(input.source) || 'manual',
    status: 'new',
    notes: [],
    first_seen_at: at,
    last_seen_at: at,
  };
  data.candidates.push(row);
  return { row, isNew: true };
}

function findCandidate(data, query) {
  const q = norm(query);
  if (!q) fail('missing candidate query (id | email | name)');
  if (/^\d+$/.test(q)) {
    const row = data.candidates.find((c) => c.id === Number(q));
    if (!row) fail(`no candidate with id ${q}`);
    return row;
  }
  if (q.includes('@')) {
    const row = data.candidates.find((c) => normKey(c.email) === normKey(q));
    if (!row) fail(`no candidate with email ${q}`);
    return row;
  }
  const exact = data.candidates.filter((c) => normKey(c.name) === normKey(q));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail(`"${q}" matches ${exact.length} candidates — use the id`);
  const loose = data.candidates.filter((c) => normKey(c.name).includes(normKey(q)));
  if (loose.length === 1) return loose[0];
  if (!loose.length) fail(`no candidate matching "${q}"`);
  fail(`"${q}" matches ${loose.length} candidates — use the id`);
}

// ---------------------------------------------------------------- scoring

const LEAD_RE = /led |tech lead|team lead|managed |mentored|team of \d+/i;

function scoreCandidate(role, c) {
  const hay = normKey(`${c.stack || ''} ${c.text || ''}`);
  const must = role.must || [];
  const nice = role.nice || [];
  let pts = 0;
  const gaps = [];
  let hits = 0;
  for (const m of must) {
    if (m && hay.includes(normKey(m))) {
      pts += 2;
      hits += 1;
    } else if (m) {
      gaps.push(`no ${m}`);
    }
  }
  for (const n of nice) {
    if (n && hay.includes(normKey(n))) pts += 1;
  }
  let knockout = null;
  if (role.min_years && c.years !== null && Number.isFinite(c.years)) {
    if (c.years >= role.min_years) pts += 2;
    else knockout = `below ${role.min_years}-yr floor (${c.years})`;
  } else {
    gaps.push('years unverified');
  }
  if (role.lead_required) {
    if (LEAD_RE.test(`${c.stack || ''} ${c.text || ''} ${c.notes.map((n) => n.text).join(' ')}`)) pts += 2;
    else gaps.push('no lead evidence');
  }
  if (role.location && c.location) {
    const rl = normKey(role.location);
    const cl = normKey(c.location);
    if (cl.includes(rl) || rl.includes(cl)) pts += 1;
    else gaps.push(`location (${c.location})`);
  } else {
    gaps.push('location unverified');
  }
  let verdict = 'fit';
  if (knockout) verdict = `knockout risk (${knockout})`;
  else if (!must.length || hits === must.length) verdict = gaps.length ? `fit (${gaps[0]})` : 'fit';
  else if (hits / must.length >= 0.7) verdict = `partial fit (${gaps[0]})`;
  else verdict = `stretch (${gaps[0]})`;
  return { pts, gaps, knockout, verdict };
}

// ---------------------------------------------------------------- args

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

// ---------------------------------------------------------------- commands

const commands = {
  init() {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    if (!fs.existsSync(STORE_FILE)) save(load());
    console.log(`talent store ready: ${STORE_FILE}`);
  },

  role(pos, flags) {
    const sub = pos[0];
    const data = load();
    if (sub === 'add') {
      const title = norm(flags.title);
      if (!title) fail('usage: role add --title "…" --client "…" [--location … --min-years N --must "a;b" …]');
      const role = {
        id: nextId(data.roles),
        title,
        client: norm(flags.client) || null,
        location: norm(flags.location) || null,
        mode: norm(flags.mode) || null,
        min_years: flags['min-years'] ? Number(flags['min-years']) : null,
        floor: flags.floor || null,
        currency: norm(flags.currency) || null,
        must: splitList(flags.must),
        nice: splitList(flags.nice),
        lead_required: flags.lead !== undefined ? flags.lead !== 'false' : true,
        no_unsolicited: Boolean(flags['no-unsolicited']),
        notes: norm(flags.notes) || null,
        created_at: nowIso(),
      };
      data.roles.push(role);
      save(data);
      console.log(`role id=${role.id} (${role.title})`);
      return;
    }
    if (sub === 'list') {
      if (flags.json) {
        console.log(JSON.stringify(data.roles, null, 2));
        return;
      }
      if (!data.roles.length) {
        console.log('(no roles)');
        return;
      }
      for (const r of data.roles) console.log(`#${r.id} ${r.title}${r.client ? ` — ${r.client}` : ''}${r.location ? ` (${r.location})` : ''}`);
      return;
    }
    if (sub === 'show') {
      const r = data.roles.find((x) => x.id === Number(pos[1]));
      if (!r) fail(`no role ${pos[1]}`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    fail('usage: role add|list|show');
  },

  ingest(pos) {
    const dir = pos[0];
    if (!dir) fail('usage: ingest <cv-folder>');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no such folder: ${dir}`);
    const data = load();
    let added = 0;
    let seen = 0;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.(md|txt)$/i.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = text.match(/^#\s+(.+)$/m);
      const name = m ? norm(m[1]) : norm(path.basename(f).replace(/\.(md|txt)$/i, '').replace(/[-_]+/g, ' '));
      if (!name) continue;
      const { isNew } = insertCandidate(data, { name, text, source: 'private-pool' });
      if (isNew) added += 1;
      else seen += 1;
    }
    save(data);
    console.log(`ingested ${added} new / ${seen} already seen from ${dir}`);
  },

  candidate(pos, flags) {
    const sub = pos[0];
    const data = load();
    if (sub === 'add') {
      if (!flags.name) fail('usage: candidate add --name "…" [--email … --linkedin … --location … --years N --stack "a;b" --notes "…"]');
      const { row, isNew } = insertCandidate(data, {
        name: flags.name, email: flags.email, linkedin: flags.linkedin,
        location: flags.location, years: flags.years, stack: flags.stack,
        text: flags.notes, source: 'manual',
      });
      save(data);
      if (!isNew) {
        console.log('ALREADY SEEN');
        console.log(`id=${row.id}`);
        process.exit(1);
      }
      console.log(`candidate id=${row.id} (${row.name})`);
      return;
    }
    if (sub === 'list') {
      let rows = [...data.candidates];
      if (flags.status) rows = rows.filter((c) => c.status === flags.status);
      if (flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log('(no candidates)');
        return;
      }
      for (const c of rows.slice(0, Number(flags.limit || 50))) {
        console.log(`#${c.id} [${c.status}] ${c.name}${c.location ? ` (${c.location})` : ''}${c.years !== null ? ` ${c.years}yrs` : ''}${c.linkedin ? ` ${c.linkedin}` : ''}`);
      }
      return;
    }
    fail('usage: candidate add|list');
  },

  match(pos, flags) {
    const roleId = Number(pos[0]);
    const role = load().roles.find((r) => r.id === roleId);
    if (!role) fail(`no role ${pos[0]}`);
    const data = load();
    const limit = Math.max(1, Number(flags.limit || 10));
    let skippedPlaced = 0;
    let skippedFloor = 0;
    const scored = [];
    for (const c of data.candidates) {
      if (!MATCHABLE.includes(c.status)) {
        skippedPlaced += 1;
        continue;
      }
      const s = scoreCandidate(role, c);
      if (s.knockout) {
        skippedFloor += 1;
        continue;
      }
      scored.push({ c, ...s });
    }
    scored.sort((a, b) => b.pts - a.pts);
    const top = scored.slice(0, limit);
    for (const { c, pts, verdict } of top) {
      const link = c.linkedin ? ` ${c.linkedin}` : '';
      console.log(`#${c.id} [${pts}pts] ${verdict} — ${c.name}${c.years !== null ? ` ${c.years}yrs` : ''}${c.location ? ` (${c.location})` : ''}${link}`);
    }
    if (!top.length) console.log('(no eligible candidates)');
    console.log(`already placed/closed — skipped: ${skippedPlaced}`);
    console.log(`below years floor — skipped: ${skippedFloor}`);
    if (role.no_unsolicited) console.log('requested-channel only — do not blast-submit (client rejects unsolicited agency resumes)');
    // Save report with suffix — never overwrite.
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = nowIso().slice(0, 10);
    const base = `role-${role.id}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    let dest = path.join(REPORTS_DIR, `${stamp}-${base}.md`);
    for (let n = 2; fs.existsSync(dest); n += 1) dest = path.join(REPORTS_DIR, `${stamp}-${base}-${n}.md`);
    const lines = [
      `# Shortlist — ${role.title}${role.client ? ` (${role.client})` : ''}`,
      '',
      `_Generated ${nowIso()}. Verdicts are textual-match only — verify on live profiles before outreach._`,
      '',
      ...top.map(({ c, verdict }) => `- #${c.id} **${c.name}** — ${verdict}${c.linkedin ? ` (${c.linkedin})` : ''}`),
      '',
      `already placed/closed — skipped: ${skippedPlaced}`,
      `below years floor — skipped: ${skippedFloor}`,
    ];
    fs.writeFileSync(dest, `${lines.join('\n')}\n`);
    console.log(dest);
  },

  status(pos, flags) {
    const data = load();
    const row = findCandidate(data, pos[0]);
    const st = pos[1];
    if (!CANDIDATE_STATUSES.includes(st)) fail(`bad status "${st}" (use one of: ${CANDIDATE_STATUSES.join(', ')})`);
    row.status = st;
    row.last_seen_at = nowIso();
    if (flags.note) row.notes.push({ at: nowIso(), text: norm(flags.note) });
    save(data);
    console.log(`candidate ${row.id} (${row.name}) -> ${st}`);
  },

  note(pos) {
    const data = load();
    const row = findCandidate(data, pos[0]);
    const text = pos.slice(1).join(' ');
    if (!text) fail('usage: note <id|email|name> <text>');
    row.notes.push({ at: nowIso(), text });
    row.last_seen_at = nowIso();
    save(data);
    console.log(`note saved on candidate ${row.id}`);
  },

  export() {
    const data = load();
    const out = [
      '# Talent pool',
      '',
      `_Exported ${nowIso()}. Source of truth: store.json._`,
      '',
      ...data.candidates.map((c) => `- #${c.id} [${c.status}] ${c.name}${c.location ? ` (${c.location})` : ''}`),
      '',
    ];
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(EXPORT_FILE, out.join('\n'));
    console.log(EXPORT_FILE);
  },

  selftest() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-selftest-'));
    const self = fileURLToPath(import.meta.url);
    const { execFileSync } = { execFileSync: null };
    void self;
    void execFileSync;
    fail('selftest must run via: node talent.mjs selftest (outer runner)');
  },
};

// ---------------------------------------------------------------- main

function usage() {
  console.log(`talent.mjs — solo-headhunter shortlister (home: ${HOME})

usage: node talent.mjs <command> [args]

  init                                  create the store / print paths
  role add --title "…" …                add a role spec
  role list|show                        roles
  ingest <cv-folder>                    one candidate per .md/.txt file
  candidate add|list                    manual profiles
  match <roleId> [--limit N]            ranked shortlist + report
  status <id> <status> [--note …]       advance a candidate
  note <id> <text>                      append a note
  export                                regenerate talent.md on demand
  selftest                              run built-in tests in a temp home`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  usage();
  process.exit(cmd ? 0 : 2);
}

// selftest needs child processes — handled without static import cycle
if (cmd === 'selftest') {
  const { execFileSync: ex } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-selftest-'));
  const env = { ...process.env, TALENT_HOME: tmp };
  const run = (args) => ex(process.execPath, [self, ...args], { encoding: 'utf8', env });
  const runFail = (args, code) => {
    try {
      ex(process.execPath, [self, ...args], { encoding: 'utf8', env });
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
  check('role add', () => {
    const out = run(['role', 'add', '--title', 'Principal Full-stack Lead', '--client', 'SS&C', '--location', 'Hyderabad', '--min-years', '10', '--must', 'Java;Spring Boot;Angular 16+', '--nice', 'fintech;Kubernetes', '--no-unsolicited']);
    if (!out.includes('role id=1')) throw new Error(out);
  });
  check('candidate add + dedupe', () => {
    const out = run(['candidate', 'add', '--name', 'A Rao', '--linkedin', 'https://www.linkedin.com/in/arao?utm_source=x', '--location', 'Hyderabad', '--years', '11', '--stack', 'Java;Spring Boot;Angular 17']);
    if (!out.includes('candidate id=1')) throw new Error(out);
    const dup = runFail(['candidate', 'add', '--name', 'A Rao', '--linkedin', 'https://www.linkedin.com/in/arao/'], 1);
    if (!dup.includes('ALREADY SEEN')) throw new Error(dup);
  });
  check('ingest folder', () => {
    const dir = path.join(tmp, 'cvs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's-iyer.md'), '# S Iyer\n\nLead engineer, Java Spring Angular, led 5-eng pod, Hyderabad.\n');
    const out = run(['ingest', dir]);
    if (!out.includes('ingested 1 new')) throw new Error(out);
  });
  check('match ranks + report suffix', () => {
    const out = run(['match', '1']);
    if (!out.includes('already placed/closed') || !out.includes('requested-channel only')) throw new Error(out);
    const out2 = run(['match', '1']);
    if (!out2.includes('-2.md')) throw new Error(`no suffix: ${out2}`);
  });
  check('status + note', () => {
    run(['status', '1', 'shortlisted', '--note', 'strong lead evidence']);
    const list = run(['candidate', 'list', '--status', 'shortlisted']);
    if (!list.includes('A Rao')) throw new Error(list);
  });
  check('corrupt store fails closed', () => {
    fs.writeFileSync(path.join(tmp, 'store.json'), '{bad json');
    try {
      ex(process.execPath, [self, 'role', 'list'], { encoding: 'utf8', env });
    } catch (err) {
      if (err.status !== 2) throw new Error(`expected exit 2, got ${err.status}`);
      if (!fs.existsSync(path.join(tmp, 'store.json'))) throw new Error('store deleted!');
      return;
    }
    throw new Error('corrupt store did not fail');
  });
  console.log(checks.join('\n'));
  console.log(process.exitCode ? 'SELFTEST FAILED' : 'SELFTEST PASSED');
  process.exit(process.exitCode || 0);
}

if (!commands[cmd]) {
  usage();
  fail(`unknown command: ${cmd}`);
}
const { pos, flags } = parseArgs(rest);
await commands[cmd](pos, flags);
