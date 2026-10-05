#!/usr/bin/env node
// warm-path.mjs — referral-first warm-path check for job-finder.
//
// For a company name, finds 1st- and 2nd-degree LinkedIn connections whose
// profiles mention that company (current or past), so the report can rank
// roles by who can actually help — the referral-first rule from the user's
// profile. Runs against the dedicated signed-in Chrome profile via the
// apply-to-jobs chrome.mjs driver.
//
// Usage:
//   node warm-path.mjs "<company>" [--max N] [--json]
//   node warm-path.mjs --batch companies.txt [--max N] [--out FILE] [--sleep ms]
//
// Output (json):
//   { company, first: { count, people: [{name, href, snippet}] },
//     second: { count, people: [...] }, generatedAt }
//
// The keyword search matches any profile mentioning the company; the snippet
// shows the relationship (e.g. "Past: … at X") — review before outreach.
// Discovery only: this tool never messages anyone, never sends invites.

import fs from 'node:fs';
import {
  ensureChrome, openAndWait, evalJson, sleep, parseArgs, writeJson, today, HOME, log,
} from './sweep-lib.mjs';
import path from 'node:path';

const PEOPLE_READY_JS = `(() => {
  const text = document.body ? document.body.innerText : '';
  const authwall = /authwall|sign in to linkedin|join linkedin/i.test(text.slice(0, 400)) && !text.includes('notifications');
  const none = /No results found|No matching people|We couldn't find/i.test(text);
  const anyPerson = [...document.querySelectorAll('a[href*="/in/"]')].some((a) => {
    const t = (a.innerText || '').replace(/\\s+/g, ' ').trim();
    return t.length > 1 && t.length < 80;
  });
  return JSON.stringify({ ready: none || anyPerson, none, authwall, url: location.href });
})()`;

const PEOPLE_JS = `(() => {
  const anchors = [...document.querySelectorAll('a[href*="/in/"]')];
  const people = new Map();
  for (const a of anchors) {
    let card = a, depth = 0, hit = null;
    while (card && depth < 8) {
      const t = card.innerText || '';
      if (/ • (1st|2nd|3rd\\+?)/.test(t) && t.length < 2500) { hit = card; break; }
      card = card.parentElement; depth++;
    }
    if (!hit) continue;
    const first = hit.querySelector('a[href*="/in/"]');
    const href = ((first && first.href) || '').split('?')[0];
    if (!href || people.has(href)) continue;
    const t = (hit.innerText || '').replace(/\\s+/g, ' ').trim();
    const m = t.match(/^(.*?) • (1st|2nd|3rd\\+?)/);
    const name = (m ? m[1] : t.slice(0, 50)).replace(/^[•\\s]+/, '').trim();
    const after = m ? t.slice(m[0].length).trim() : '';
    people.set(href, {
      name: name.slice(0, 80),
      href,
      degree: m ? m[2] : '',
      snippet: after.slice(0, 180),
    });
  }
  const text = document.body ? document.body.innerText : '';
  const none = /No results found|No matching people|We couldn't find/i.test(text);
  return JSON.stringify({ none, people: [...people.values()] });
})()`;

function peopleSearchUrl(company, degree) {
  const p = new URLSearchParams();
  p.set('keywords', company);
  if (degree === 1) p.set('network', '["F"]');
  else if (degree === 2) p.set('network', '["S"]');
  const qs = p.toString().replace(/\+/g, '%20');
  return `https://www.linkedin.com/search/results/people/?${qs}`;
}

function checkCompany(company, { max = 10, sleepMs = 1500 }) {
  const result = {
    company,
    first: { count: 0, people: [] },
    second: { count: 0, people: [] },
    generatedAt: new Date().toISOString(),
  };
  for (const degree of [1, 2]) {
    const key = degree === 1 ? 'first' : 'second';
    const state = openAndWait(peopleSearchUrl(company, degree), PEOPLE_READY_JS, { timeoutMs: 18000 });
    if (state.authwall) {
      console.error('LOGIN WALL: sign in to LinkedIn in the visible Chrome window, then re-run.');
      process.exit(3);
    }
    if (state.none) continue;
    // People results hydrate after load — give them a moment, then collect twice.
    sleep(1200);
    let people = (evalJson(PEOPLE_JS).people || []);
    if (people.length) {
      sleep(800);
      const second = evalJson(PEOPLE_JS).people || [];
      if (second.length > people.length) people = second;
    }
    result[key].count = people.length;
    result[key].people = people.slice(0, max);
    sleep(sleepMs);
  }
  return result;
}

function printHuman(r) {
  const line = (deg, d) => {
    console.log(`  ${deg}: ${d.count === 0 ? 'none found' : d.count + ' found' + (d.count > d.people.length ? ` (showing ${d.people.length})` : '')}`);
    for (const p of d.people.slice(0, 10)) console.log(`    - ${p.name} — ${p.snippet.slice(0, 100)}`);
  };
  console.log(`${r.company}`);
  line('1st-degree', r.first);
  line('2nd-degree', r.second);
}

const { flags } = parseArgs(process.argv.slice(2));
const companyArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (flags.batch) {
  ensureChrome();
  const list = fs.readFileSync(flags.batch, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const max = Number(flags.max || 10);
  const sleepMs = Number(flags.sleep || 2500);
  const out = flags.out || path.join(HOME, 'sweeps', `${today()}-warm-path`, 'warm-path.json');
  const results = [];
  for (const company of list) {
    log(`checking ${company}…`);
    const r = checkCompany(company, { max, sleepMs });
    results.push(r);
    log(`  ${company}: ${r.first.count} × 1st, ${r.second.count} × 2nd`);
  }
  writeJson(out, { generatedAt: new Date().toISOString(), results });
  console.log(JSON.stringify({ out, companies: results.length }, null, 1));
} else if (companyArg) {
  ensureChrome();
  const max = Number(flags.max || 10);
  const r = checkCompany(companyArg, { max, sleepMs: Number(flags.sleep || 1500) });
  if (flags.json) console.log(JSON.stringify(r, null, 1));
  else printHuman(r);
} else {
  console.log(`warm-path.mjs — LinkedIn 1st/2nd-degree warm-path check

usage:
  node warm-path.mjs "<company>" [--max N] [--json]
  node warm-path.mjs --batch companies.txt [--max N] [--out FILE]

Finds connections whose profiles mention the company (current or past) via
LinkedIn people search. Discovery only — never messages or connects.`);
}
