#!/usr/bin/env node
// evals/run.mjs — rejection-grounded eval for the Jev matcher.
// Pass bar: >=90% of `drop` cases verdict ineligible AND >=90% of `keep`
// cases NOT ineligible. Live Jev calls (~1 per case).
//
//   TYPESAFE_API_KEY=... node evals/run.mjs [--fixture evals/rejection-eval.json]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEV = path.join(ROOT, 'skills', 'job-finder', 'scripts', 'jev.mjs');
const fixturePath = process.argv[2] === '--fixture' ? process.argv[3]
  : (process.argv[2] || path.join(ROOT, 'evals', 'rejection-eval.json'));

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-eval-'));
fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify(fixture.profile));
fs.writeFileSync(path.join(tmp, 'roles.json'), JSON.stringify(
  fixture.cases.map((c, i) => ({ id: c.id || i, ...c.role }))));

const out = execFileSync('node', [JEV, 'rank', '--profile', path.join(tmp, 'profile.json'),
  '--roles', path.join(tmp, 'roles.json')], { encoding: 'utf8', timeout: 300000 });
const ranked = JSON.parse(out);
const byId = new Map(ranked.roles.map((r) => [String(r.id), r]));

let dropOk = 0, dropN = 0, keepOk = 0, keepN = 0;
const misses = [];
for (const c of fixture.cases) {
  const r = byId.get(String(c.id));
  if (!r) { misses.push(`${c.id}: MISSING from rank output`); continue; }
  if (c.expect === 'drop') {
    dropN += 1;
    if (r.verdict === 'ineligible') dropOk += 1;
    else misses.push(`${c.id}: expected drop, got ${r.verdict}/${r.label} (${r.reasons.join('; ')})`);
  } else {
    keepN += 1;
    if (r.verdict !== 'ineligible') keepOk += 1;
    else misses.push(`${c.id}: expected keep, got ineligible (${r.reasons.join('; ')})`);
  }
}
const dropRate = dropN ? dropOk / dropN : 1;
const keepRate = keepN ? keepOk / keepN : 1;
console.log(JSON.stringify({
  drop: `${dropOk}/${dropN}`, keep: `${keepOk}/${keepN}`,
  dropRate: Math.round(dropRate * 1000) / 1000, keepRate: Math.round(keepRate * 1000) / 1000,
  pass: dropRate >= 0.9 && keepRate >= 0.9, misses,
}, null, 2));
if (!(dropRate >= 0.9 && keepRate >= 0.9)) process.exit(1);
