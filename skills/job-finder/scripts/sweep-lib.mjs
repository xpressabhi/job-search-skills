// sweep-lib.mjs — shared helpers for the browser-driven sweep tools
// (linkedin-sweep, warm-path).
//
// Drives the apply-to-jobs chrome.mjs CDP driver so every browser sweep uses
// the dedicated, signed-in Chrome profile in ~/.job-search/chrome-profile.
// No npm dependencies; Node 22+.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.JOB_SEARCH_HOME || path.join(os.homedir(), '.job-search');

export function chromePath() {
  if (process.env.CHROME_MJS) return process.env.CHROME_MJS;
  const candidates = [
    path.resolve(SCRIPT_DIR, '../../apply-to-jobs/scripts/chrome.mjs'),        // skills/job-finder/scripts -> skills/apply-to-jobs/scripts
    path.resolve(SCRIPT_DIR, '../../../apply-to-jobs/scripts/chrome.mjs'),     // alternate layouts
    path.join(os.homedir(), '.config/opencode/skills/apply-to-jobs/scripts/chrome.mjs'),
    path.join(os.homedir(), '.claude/skills/apply-to-jobs/scripts/chrome.mjs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  console.error('error: chrome.mjs not found — set CHROME_MJS to the apply-to-jobs chrome.mjs path');
  process.exit(2);
}

export function chrome(args, { allowFailure = false, timeout = 90000 } = {}) {
  try {
    return execFileSync('node', [chromePath(), ...args], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (allowFailure) return '';
    console.error(`error: chrome.mjs ${args[0]} failed: ${String(err.stderr || err.message).slice(0, 300)}`);
    process.exit(2);
  }
}

export function chromeStatus() {
  try {
    execFileSync('node', [chromePath(), 'status'], { encoding: 'utf8', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export function ensureChrome() {
  if (chromeStatus()) return;
  console.error('Chrome not running — launching with the job-search profile…');
  chrome(['launch']);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (chromeStatus()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  console.error('error: Chrome did not come up on port 9222');
  process.exit(2);
}

// Evaluate JS in the active page and parse a JSON return value.
export function evalJson(expr) {
  const out = chrome(['eval', expr]);
  try {
    return JSON.parse(out);
  } catch {
    console.error(`error: eval did not return JSON: ${out.slice(0, 300)}`);
    process.exit(2);
  }
}

export function evalText(expr) {
  return chrome(['eval', expr]);
}

export function open(url) {
  chrome(['open', url]);
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Open a URL and poll a readiness expression until it returns truthy JSON
// ({ ready: true, ... }) or the timeout elapses. Returns the last payload.
export function openAndWait(url, readyExpr, { timeoutMs = 20000, intervalMs = 1000, label = url } = {}) {
  open(url);
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    sleep(intervalMs);
    try {
      last = evalJson(readyExpr);
    } catch {
      last = null;
    }
    if (last && last.ready) return last;
  }
  return last || { ready: false };
}

export function readProfile() {
  const p = path.join(HOME, 'profile.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function defaultOut(name) {
  const dir = path.join(HOME, 'sweeps', `${today()}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.json`);
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return file;
}

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

// Newest-first LinkedIn jobs search URL for one query.
export function linkedinJobsUrl({ title, location, mode, days = 7, start = 0 }) {
  const p = new URLSearchParams();
  p.set('keywords', title);
  p.set('location', location);
  if (days === 1) p.set('f_TPR', 'r86400');
  else if (days === 3) p.set('f_TPR', 'r259200');
  else if (days === 30) p.set('f_TPR', 'r2592000');
  else p.set('f_TPR', 'r604800');
  if (mode === 'remote') p.set('f_WT', '2');
  else if (mode === 'hybrid') p.set('f_WT', '3');
  else if (mode === 'onsite') p.set('f_WT', '1');
  p.set('sortBy', 'DD');
  if (start > 0) p.set('start', String(start));
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

// Decode the external URL out of a LinkedIn /safety/go?url=... redirect.
export function decodeSafetyGo(href) {
  try {
    const u = new URL(href);
    let target = u.searchParams.get('url') || '';
    for (let i = 0; i < 2 && target; i++) {
      if (/^https?%3A|^%2F|^https?:\/\//.test(target)) {
        try { target = decodeURIComponent(target); } catch { break; }
      } else break;
    }
    return target;
  } catch {
    return '';
  }
}

export function log(msg) {
  console.error(msg);
}
