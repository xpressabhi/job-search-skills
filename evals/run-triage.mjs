#!/usr/bin/env node
// evals/run-triage.mjs — listing triage eval (skip mismatches, fetch fits).
// Pass bar: >=85% of cases land on an expected verdict.
// Live Jev calls (~1 per non-deterministic case).
//
//   TYPESAFE_API_KEY=... node evals/run-triage.mjs [--fixture evals/triage-eval.json]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEV = path.join(ROOT, 'skills', 'job-finder', 'scripts', 'jev.mjs');
const fixturePath = process.argv[2] === '--fixture' ? process.argv[3]
  : (process.argv[2] || path.join(ROOT, 'evals', 'triage-eval.json'));

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-triage-eval-'));
const profilePath = path.join(tmp, 'profile.json');
fs.writeFileSync(profilePath, JSON.stringify(fixture.profile));
const listingsPath = path.join(tmp, 'listings.json');
fs.writeFileSync(listingsPath, JSON.stringify(fixture.cases.map((c, i) => ({ id: c.id || i, ...c.listing }))));

const out = execFileSync('node', [JEV, 'triage', '--profile', profilePath, '--listings', listingsPath],
  { encoding: 'utf8', timeout: 300000 });
const byId = new Map(JSON.parse(out).listings.map((l) => [String(l.id), l]));

let ok = 0;
const misses = [];
for (const c of fixture.cases) {
  const l = byId.get(String(c.id));
  const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
  if (!l) { misses.push(`${c.id}: MISSING from triage output`); continue; }
  if (expected.includes(l.verdict)) ok += 1;
  else misses.push(`${c.id}: expected ${expected.join('|')}, got ${l.verdict} (${(l.reasons || []).join('; ')})`);
}
const rate = fixture.cases.length ? ok / fixture.cases.length : 1;
console.log(JSON.stringify({
  passed: `${ok}/${fixture.cases.length}`,
  rate: Math.round(rate * 1000) / 1000,
  pass: rate >= 0.85,
  misses,
}, null, 2));
if (rate < 0.85) process.exit(1);
