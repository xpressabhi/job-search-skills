#!/usr/bin/env node
// crosscheck.mjs — the Jev cross-check gate for job-finder.
//
// USER RULE (2026-10-05, MUST): always present only high-quality matching roles,
// after cross-checking with Jev. This script is that cross-check: for every
// candidate role it composes the full Jev evidence (eligibility/rank + CV fit +
// must-have requirement gaps + red flags) and returns a hard PRESENT/DROP
// verdict. Presenting a role that this gate drops is a bug.
//
// Usage:
//   node crosscheck.mjs --profile <profile.json> --roles <roles.json> [options]
//
// Options:
//   --cv <path>        CV file for the fit + requirements calls (default: profile.cv.text_path
//                      -> stored_path -> path)
//   --max-gaps N       max must-have gaps allowed for a PRESENT verdict (default 1)
//   --strict           require BOTH rank and fit to reach good/strong (default: either)
//   --out FILE         write the full verdict JSON
//   --json             print the full verdict JSON instead of the human summary
//
// Gate (all must hold for PRESENT):
//   1. rank verdict is not `ineligible`
//   2. rank label ∈ {good,strong} OR fit label ∈ {good,strong}  (both under --strict)
//   3. must-have gaps ≤ --max-gaps (requirements; gaps are named on the role)
//   4. no red flags ≥ 0.7 (fee/KYC scam, surveillance terms, body-shop repost)
// Fail-closed: any Jev call that errors marks the role DROP (never presented unverified).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './sweep-lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const JEV = path.join(SCRIPT_DIR, 'jev.mjs');
const HOME = process.env.JOB_SEARCH_HOME || path.join(os.homedir(), '.job-search');

function jev(args) {
  const out = execFileSync('node', [JEV, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function readCvPath(profileFile, override) {
  if (override) return override;
  try {
    const p = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const cv = p.cv || {};
    for (const c of [cv.text_path, cv.stored_path, cv.path]) {
      if (c && fs.existsSync(c)) return c;
    }
  } catch { /* fall through */ }
  return null;
}

const { flags } = parseArgs(process.argv.slice(2));
const profileFile = flags.profile;
const rolesFile = flags.roles;
if (!profileFile || !rolesFile) {
  console.error('usage: crosscheck.mjs --profile <profile.json> --roles <roles.json> [--cv C] [--max-gaps N] [--strict] [--out F] [--json]');
  process.exit(2);
}
const maxGaps = flags['max-gaps'] !== undefined ? Number(flags['max-gaps']) : 1;
const strict = !!flags.strict;
const cvPath = readCvPath(profileFile, flags.cv);
if (!cvPath) {
  console.error('error: no CV path (pass --cv, or set profile.cv.text_path)');
  process.exit(2);
}

const roles = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-'));

let rankById = new Map();
let rankError = '';
try {
  const ranked = jev(['rank', '--profile', profileFile, '--roles', rolesFile]);
  for (const r of ranked.roles || []) rankById.set(String(r.id), r);
} catch (err) {
  rankError = String(err.stderr || err.message || err).slice(0, 300);
}

const results = [];
for (const role of roles) {
  const id = String(role.id || '');
  const postingFile = path.join(tmpDir, `role-${id.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  fs.writeFileSync(postingFile, JSON.stringify(role));
  const row = {
    id,
    company: role.company || '',
    title: role.title || '',
    url: role.url || '',
    rank: null,
    fit: null,
    gaps: [],
    redflags: [],
    verdict: 'DROP',
    reason: '',
  };
  try {
    const rank = rankById.get(id) || null;
    if (!rank) throw new Error(rankError ? `rank unavailable: ${rankError}` : 'no rank verdict for this role id');
    const fit = jev(['fit', '--cv', cvPath, '--posting', postingFile]);
    const req = jev(['requirements', '--cv', cvPath, '--posting', postingFile, '--max-gaps', String(maxGaps)]);
    row.rank = { verdict: rank.verdict, label: rank.label, composite: rank.composite, coverage: rank.coverage, level: rank.level };
    row.fit = { label: fit.label, composite: fit.composite, gates: fit.gates, scores: fit.scores };
    row.gaps = req.gaps || [];

    const rankLabel = rank.label;
    const fitLabel = fit.label;
    const top = (l) => l === 'good' || l === 'strong';
    const gateRank = top(rankLabel);
    const gateFit = top(fitLabel);
    const clears = strict ? gateRank && gateFit : gateRank || gateFit;
    const eligible = rank.verdict !== 'ineligible';
    const gapOk = row.gaps.length <= maxGaps;

    if (!eligible) {
      row.reason = `ineligible (rank verdict)${rank?.reasons?.length ? ' — ' + rank.reasons.join('; ') : ''}`;
    } else if (!clears) {
      row.reason = `below bar — rank ${rankLabel ?? 'n/a'}${rank ? ' (' + (rank.coverage ?? '-') + ')' : ''}, fit ${fitLabel} (${fit.composite})`;
    } else if (!gapOk) {
      row.reason = `${row.gaps.length} must-have gaps > ${maxGaps} — first: ${String(row.gaps[0]).slice(0, 120)}`;
    } else {
      const rf = jev(['redflags', '--posting', postingFile]);
      row.redflags = rf.flags || [];
      if (row.redflags.length) {
        row.reason = `red flags — ${row.redflags.slice(0, 2).map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('; ').slice(0, 160)}`;
      } else {
        row.verdict = 'PRESENT';
        row.reason = `${gateRank && gateFit ? 'both' : gateRank ? 'rank' : 'fit'} clear${row.gaps.length ? `; ${row.gaps.length} gap disclosed` : ''}`;
        row.disagreement = gateRank !== gateFit;
      }
    }
  } catch (err) {
    row.reason = `jev error — ${String(err.stderr || err.message || err).slice(0, 160)}`;
  }
  results.push(row);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* keep */ }

const present = results.filter((r) => r.verdict === 'PRESENT');
const dropped = results.filter((r) => r.verdict !== 'PRESENT');
const out = {
  generatedAt: new Date().toISOString(),
  strict,
  maxGaps,
  cv: cvPath,
  rankError: rankError || undefined,
  counts: { total: results.length, present: present.length, dropped: dropped.length },
  present,
  dropped,
};

if (flags.out) {
  fs.mkdirSync(path.dirname(flags.out), { recursive: true });
  fs.writeFileSync(flags.out, JSON.stringify(out, null, 1));
}
if (flags.json) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log(`Jev cross-check — ${present.length} present / ${results.length} total${strict ? ' (strict)' : ''}`);
  for (const r of present) {
    const rank = r.rank ? `rank ${r.rank.label} (${r.rank.coverage ?? '-'})` : 'rank n/a';
    console.log(`  PRESENT  ${r.company} — ${r.title.slice(0, 60)}`);
    console.log(`           ${rank}; fit ${r.fit.label} (${r.fit.composite}); gaps ${r.gaps.length}${r.disagreement ? '; tools disagree — disclosed' : ''}`);
    if (r.gaps.length) console.log(`           gap: ${String(r.gaps[0]).slice(0, 140)}`);
  }
  for (const r of dropped) {
    console.log(`  drop     ${r.company} — ${r.title.slice(0, 55)} — ${r.reason}`);
  }
}
if (present.length === 0) {
  console.log('');
  console.log('No role passed the cross-check — presenting none is the correct outcome (never pad with partials).');
}
process.exit(present.length ? 0 : 1);
