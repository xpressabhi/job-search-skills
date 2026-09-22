#!/usr/bin/env node
// evals/run-company-screen.mjs — pre-sweep triage eval.
// Pass bar: >=85% of cases land on the expected verdict (skip/sweep/maybe).
// Live Jev calls (~1 per case).
//
//   TYPESAFE_API_KEY=... node evals/run-company-screen.mjs [--fixture evals/company-screen-eval.json]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEV = path.join(ROOT, 'skills', 'job-finder', 'scripts', 'jev.mjs');
const fixturePath = process.argv[2] === '--fixture' ? process.argv[3]
  : (process.argv[2] || path.join(ROOT, 'evals', 'company-screen-eval.json'));

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-screen-eval-'));
const profilePath = path.join(tmp, 'profile.json');
fs.writeFileSync(profilePath, JSON.stringify(fixture.profile));

let ok = 0;
const misses = [];
for (const c of fixture.cases) {
  const args = [JEV, 'company-screen', '--profile', profilePath, '--company', c.company];
  if (c.context) args.push('--context', c.context);
  let verdict = 'error';
  try {
    const out = execFileSync('node', args, { encoding: 'utf8', timeout: 120000 });
    verdict = JSON.parse(out).verdict;
  } catch (e) {
    misses.push(`${c.id}: error ${String(e.message || e).slice(0, 120)}`);
    continue;
  }
  if (verdict === c.expect) ok += 1;
  else misses.push(`${c.id}: expected ${c.expect}, got ${verdict}`);
}
const rate = fixture.cases.length ? ok / fixture.cases.length : 1;
console.log(JSON.stringify({
  passed: `${ok}/${fixture.cases.length}`,
  rate: Math.round(rate * 1000) / 1000,
  pass: rate >= 0.85,
  misses,
}, null, 2));
if (rate < 0.85) process.exit(1);
