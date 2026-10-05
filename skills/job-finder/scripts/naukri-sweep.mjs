#!/usr/bin/env node
// naukri-sweep.mjs — Naukri.com discovery for job-finder (India's largest board).
//
// Naukri renders client-side (plain fetch returns a shell), so this drives the
// same signed-in Chrome profile as the other sweep tools via chrome.mjs.
// Results are sorted by date (`sort=f`); pagination uses Naukri's canonical
// `-N` page URLs, discovered from the pagination controls.
//
// Commands:
//   run [options]
//
// Options:
//   --titles "a,b,c"   target titles (default: profile-derived FE+AI mix)
//   --loc "hyderabad"  location slug (default hyderabad)
//   --pages N          result pages per query (default 2, 20 cards/page)
//   --limit N          stop after N unique cards (default 200)
//   --out FILE         output (default ~/.job-search/sweeps/<date>-naukri/naukri-cards.json)
//
// Cards are discovery records: resolve the employer's own posting (or apply
// via Naukri when the employer posts only there) before treating a role as vetted.

import fs from 'node:fs';
import { ensureChrome, openAndWait, evalJson, sleep, readProfile, defaultOut, writeJson, parseArgs, log } from './sweep-lib.mjs';

const READY_JS = `(() => {
  const cards = document.querySelectorAll('[data-job-id]').length;
  const text = document.body ? document.body.innerText : '';
  const none = /0 jobs found|no jobs found|didn't find any matching job/i.test(text);
  return JSON.stringify({ ready: cards > 0 || none, cards, none });
})()`;

const CARDS_JS = `(() => {
  const cards = [...document.querySelectorAll('[data-job-id]')].map((c) => {
    const a = c.querySelector('a.title') || c.querySelector('a[href*="/job-listings"]') || c.querySelector('a');
    const title = (c.querySelector('.title')?.innerText || a?.innerText || '').replace(/\\s+/g, ' ').trim();
    const company = (c.querySelector('.comp-name')?.innerText || '').replace(/\\s+/g, ' ').trim();
    const experience = (c.querySelector('.expwdth')?.innerText || '').replace(/\\s+/g, ' ').trim();
    const location = (c.querySelector('.locWdth')?.innerText || '').replace(/\\s+/g, ' ').trim();
    const salary = (c.querySelector('.sal')?.innerText || '').replace(/\\s+/g, ' ').trim();
    const posted = (c.querySelector('[class*="job-post-day"]')?.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      id: c.getAttribute('data-job-id') || '',
      title,
      company,
      experience,
      location,
      salary,
      posted,
      jobUrl: (a?.href || '').split('?')[0],
    };
  }).filter((x) => x.id && x.title && x.jobUrl);
  return JSON.stringify({ ready: true, cards });
})()`;

const PAGE_LINKS_JS = `(() => {
  const nums = [...document.querySelectorAll('a')]
    .map((a) => ({ t: (a.innerText || '').trim(), h: a.href }))
    .filter((x) => /^[0-9]+$/.test(x.t) && /-jobs-in-/.test(x.h));
  return JSON.stringify({ pages: nums.map((x) => Number(x.t)), two: (nums.find((x) => x.t === '2') || {}).h || '' });
})()`;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function cleanTitle(t) {
  return String(t).replace(/\(.*?\)/g, ' ').replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
}

function defaultTitles(profile) {
  const all = [...new Set((profile?.targets?.titles || []).map(cleanTitle).filter(Boolean))];
  const fe = all.filter((t) => /frontend|front-end|design system|web/i.test(t)).slice(0, 2);
  const ai = all.filter((t) => /\bai\b|agent|llm|applied|founding/i.test(t)).slice(0, 2);
  const picked = [...fe, ...ai];
  return picked.length ? picked : ['Staff Frontend Engineer', 'Staff AI Engineer'];
}

function searchUrl(title, loc, page = 1) {
  const base = `https://www.naukri.com/${slug(title)}-jobs-in-${slug(loc)}`;
  const suffix = page > 1 ? `-${page}` : '';
  return `${base}${suffix}?k=${encodeURIComponent(title)}&l=${slug(loc)}&sort=f`;
}

function fetchPage(url, { sleepMs = 1400 } = {}) {
  const state = openAndWait(url, READY_JS, { timeoutMs: 20000 });
  if (!state.ready || state.none) return { cards: [], none: true };
  sleep(800); // let the list fully render
  const payload = evalJson(CARDS_JS);
  sleep(sleepMs);
  return { cards: payload.cards || [], none: false };
}

function sweepQuery(title, loc, { pages, sleepMs }) {
  const cards = [];
  const first = fetchPage(searchUrl(title, loc, 1), { sleepMs });
  if (first.none || !first.cards.length) return cards;
  cards.push(...first.cards);
  if (pages <= 1) return cards;
  // Find the canonical page-2 URL from the pagination controls, then walk -N.
  const links = evalJson(PAGE_LINKS_JS);
  if (!links.two) return cards;
  for (let p = 2; p <= pages; p++) {
    const url = links.two.replace(/-2(\?|$)/, `-${p}$1`);
    const { cards: batch, none } = fetchPage(url, { sleepMs });
    if (none || !batch.length) break;
    if (batch[0].id === cards[0].id) break; // pagination ignored — do not loop
    cards.push(...batch);
    if (batch.length < 18) break; // short page = last page
  }
  return cards;
}

async function cmdRun(flags) {
  ensureChrome();
  const profile = readProfile();
  const titles = flags.titles
    ? String(flags.titles).split(',').map((s) => s.trim()).filter(Boolean)
    : defaultTitles(profile);
  const loc = String(flags.loc || 'hyderabad');
  const pages = Number(flags.pages || 2);
  const limit = Number(flags.limit || 200);
  const sleepMs = Number(flags.sleep || 1400);
  const out = flags.out || defaultOut('naukri');

  const seen = new Map();
  const perQuery = [];
  for (const title of titles) {
    const cards = sweepQuery(title, loc, { pages, sleepMs });
    let added = 0;
    for (const c of cards) {
      if (seen.has(c.id)) continue;
      seen.set(c.id, { ...c, query: `${title} @ ${loc}` });
      added++;
      if (seen.size >= limit) break;
    }
    perQuery.push({ title, loc, fetched: cards.length, added });
    log(`  ${title} @ ${loc}: ${cards.length} cards (${added} new, total ${seen.size})`);
    if (seen.size >= limit) break;
  }

  const result = {
    source: 'naukri',
    generatedAt: new Date().toISOString(),
    queries: perQuery,
    totalUnique: seen.size,
    cards: [...seen.values()],
  };
  writeJson(out, result);
  console.log(JSON.stringify({ out, queries: perQuery.length, uniqueCards: seen.size, file: out }, null, 1));
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0] || 'help';
if (cmd === 'run') await cmdRun(flags);
else {
  console.log(`naukri-sweep.mjs — Naukri.com discovery (via apply-to-jobs chrome.mjs)

usage:
  node naukri-sweep.mjs run [options]

options:
  --titles "a,b,c"   target titles (default: profile-derived FE+AI mix)
  --loc "hyderabad"  location (default hyderabad)
  --pages N          pages per query (default 2 x 20 cards)
  --limit N          max unique cards (default 200)
  --out FILE         output path

Cards: { id, title, company, experience, location, salary, posted, jobUrl, query }`);
}
