#!/usr/bin/env node
// linkedin-sweep.mjs — signed-in LinkedIn Jobs discovery for job-finder.
//
// LinkedIn has no public API: logged-out search is a walled stub. This tool
// drives the apply-to-jobs chrome.mjs CDP driver against the dedicated,
// signed-in Chrome profile in ~/.job-search/chrome-profile, extracts job cards
// from LinkedIn's search results, resolves the original ATS posting for each
// card, and writes a JSON file the standard pipeline (tracker seen -> jev
// liveness/eligibility/rank) consumes like any ATS board export.
//
// Commands:
//   check                          verify Chrome + LinkedIn sign-in
//   run [options]                  sweep LinkedIn Jobs search results
//   resolve --in FILE [--limit N]  resolve external (ATS) URLs for card results
//
// Run options:
//   --titles "a,b,c"     override target titles (default: profile-derived mix)
//   --days N             1|3|7|30 (default 7 -> past week)
//   --pages N            result pages per query (default 2, 25 cards/page)
//   --limit N            stop after N unique cards (default 250)
//   --loc "…"            single location override (default matrix: profile)
//   --out FILE           output file (default ~/.job-search/sweeps/<date>-linkedin/linkedin-cards.json)
//   --no-india           Hyderabad queries only (skip India-remote)
//
// Discovery only — never applies, never clicks an apply control. Every
// reported role must resolve to (or be checked against) its original posting
// on the employer's own ATS; the LinkedIn URL is used only for Easy-Apply-only
// listings, flagged as such.

import fs from 'node:fs';
import path from 'node:path';
import {
  HOME, ensureChrome, openAndWait, evalJson, chrome, sleep, readProfile, today,
  defaultOut, writeJson, parseArgs, linkedinJobsUrl, decodeSafetyGo, log,
} from './sweep-lib.mjs';

// Full scroll-and-collect: LinkedIn virtualizes the result list (only ~7 rows
// hydrate; the rest are empty placeholders), so we scroll the inner list pane
// and accumulate rendered rows into a Map keyed by job id. Runs as one
// awaitPromise eval so the page state persists across scroll steps.
const COLLECT_JS = `(async () => {
  const SEL = 'li[data-occludable-job-id], li.jobs-search-results__list-item, .job-card-container';
  const done = new Map();
  const grab = () => {
    const lis = [...document.querySelectorAll(SEL)];
    for (const li of lis) {
      const id = li.getAttribute('data-occludable-job-id') ||
        ((li.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') || '').match(/\\/jobs\\/view\\/(\\d+)/) || [])[1] || '';
      if (!id || done.has(id)) continue;
      const a = li.querySelector('a[href*="/jobs/view/"]');
      const title = (li.querySelector('a.job-card-container__link')?.innerText || a?.innerText || '').replace(/\\s+/g, ' ').trim();
      const company = (li.querySelector('.artdeco-entity-lockup__subtitle')?.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!title || !company) continue;
      const location = (li.querySelector('.artdeco-entity-lockup__caption')?.innerText || '').replace(/\\s+/g, ' ').trim();
      const time = li.querySelector('time');
      done.set(id, {
        id, title, company, location,
        listed: (time?.innerText || '').split('\\n')[0].trim(),
        listedDate: time?.getAttribute('datetime') || '',
        linkedinUrl: 'https://www.linkedin.com/jobs/view/' + id + '/',
      });
    }
    return lis.length;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findScroller = () => {
    let el = document.querySelector(SEL);
    while (el && el !== document.body) {
      const st = getComputedStyle(el);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  for (let i = 0; i < 12 && done.size === 0; i++) { await sleep(400); grab(); }
  if (done.size >= 25) return JSON.stringify({ ready: true, cards: [...done.values()] });
  const scroller = findScroller();
  let lastTotal = -1;
  let stalls = 0;
  for (let i = 0; i < 14; i++) {
    if (done.size >= 25) break;
    scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, scroller.clientHeight * 0.8));
    await sleep(700);
    const total = grab();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (atBottom && total === lastTotal) stalls++;
    else if (!atBottom) stalls = 0;
    if (stalls >= 2) break;
    lastTotal = total;
  }
  return JSON.stringify({ ready: true, cards: [...done.values()] });
})()`;

const READY_JS = `(() => {
  const cards = document.querySelectorAll('li[data-occludable-job-id]').length;
  const text = document.body ? document.body.innerText : '';
  const authwall = /authwall|sign in to linkedin|join linkedin/i.test(text.slice(0, 400)) && !text.includes('notifications');
  const none = /No matching jobs found|no results found/i.test(text);
  return JSON.stringify({ ready: cards > 0 || none, cards, none, authwall, url: location.href });
})()`;

const RESOLVE_JS = `(() => {
  const text = document.body ? document.body.innerText : '';
  const buttons = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g, ' ').trim());
  const easyApply = buttons.some((t) => /easy apply/i.test(t));
  const applyAnchor = [...document.querySelectorAll('a[href]')].find((a) => /apply/i.test(a.innerText || '') && /safety\\/go\\/?\\?url=/.test(a.href))
    || [...document.querySelectorAll('a[href*="safety/go"]')].find((a) => /safety\\/go\\/?\\?url=/.test(a.href));
  const closed = /no longer accepting|applications are closed|job is no longer available|position (is )?filled/i.test(text);
  const appliedAlready = /\\bApplied\\b/.test(buttons.join(' | ')) || /you applied|application (was )?sent/i.test(text.slice(0, 2000));
  return JSON.stringify({
    ready: easyApply || !!applyAnchor || closed || buttons.some((t) => /^apply$/i.test(t)),
    easyApply,
    applyHref: applyAnchor ? applyAnchor.href : '',
    closed,
    appliedAlready,
  });
})()`;

function cleanTitle(t) {
  return String(t)
    .replace(/\(.*?\)/g, ' ')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultTitles(profile) {
  const all = [...new Set((profile?.targets?.titles || []).map(cleanTitle).filter(Boolean))];
  const fe = all.filter((t) => /frontend|front-end|design system|web/i.test(t)).slice(0, 3);
  const ai = all.filter((t) => /\bai\b|agent|llm|applied|founding/i.test(t)).slice(0, 3);
  const picked = [...fe, ...ai];
  return picked.length ? picked : ['Staff Frontend Engineer', 'Staff AI Engineer'];
}

function buildQueries(flags, profile) {
  const titles = flags.titles
    ? String(flags.titles).split(',').map((s) => s.trim()).filter(Boolean)
    : defaultTitles(profile);
  const days = Number(flags.days || 7);
  const queries = [];
  const hyderabad = flags.loc ? String(flags.loc) : 'Hyderabad, Telangana, India';
  for (const title of titles) {
    queries.push({ title, location: hyderabad, mode: '', days });
  }
  if (!flags['no-india'] && !flags.loc) {
    for (const title of titles.slice(0, 3)) {
      queries.push({ title, location: 'India', mode: 'remote', days });
    }
  }
  return queries;
}

async function cmdCheck() {
  ensureChrome();
  openAndWait('https://www.linkedin.com/jobs/', READY_JS, { timeoutMs: 15000 });
  const state = evalJson(`(() => {
    const text = document.body ? document.body.innerText : '';
    const signedIn = text.includes('notifications') && !/authwall/i.test(location.href);
    return JSON.stringify({ signedIn, url: location.href, title: document.title });
  })()`);
  console.log(JSON.stringify({ chrome: true, linkedin: state }, null, 1));
  if (!state.signedIn) {
    console.error('NOT SIGNED IN — open the visible Chrome window, sign in to LinkedIn once, then re-run.');
    process.exit(3);
  }
}

function sweepQuery(query, { pages, sleepMs }) {
  const cards = [];
  let prevFirst = '';
  for (let p = 0; p < pages; p++) {
    const url = linkedinJobsUrl({ ...query, start: p * 25 });
    const state = openAndWait(url, READY_JS, { timeoutMs: 20000 });
    if (state.authwall) {
      console.error('LOGIN WALL: sign in to LinkedIn in the visible Chrome window, then re-run.');
      process.exit(3);
    }
    if (!state.ready || state.none) break;
    const payload = evalJson(COLLECT_JS);
    const batch = payload.cards || [];
    if (!batch.length) break;
    if (batch[0].id === prevFirst) break; // LinkedIn ignored the start param — do not loop
    prevFirst = batch[0].id;
    cards.push(...batch);
    if (batch.length < 20) break;
    sleep(sleepMs);
  }
  return cards;
}

async function cmdRun(flags) {
  ensureChrome();
  const profile = readProfile();
  const queries = buildQueries(flags, profile);
  const pages = Number(flags.pages || 2);
  const limit = Number(flags.limit || 250);
  const sleepMs = Number(flags.sleep || 1500);
  const out = flags.out || defaultOut('linkedin');

  const seen = new Map();
  const perQuery = [];
  for (const q of queries) {
    const cards = sweepQuery(q, { pages, sleepMs });
    let added = 0;
    for (const c of cards) {
      if (seen.has(c.id)) continue;
      seen.set(c.id, { ...c, query: `${q.title} @ ${q.location}${q.mode ? ' [' + q.mode + ']' : ''}` });
      added++;
      if (seen.size >= limit) break;
    }
    perQuery.push({ ...q, fetched: cards.length, added });
    log(`  ${q.title} @ ${q.location}${q.mode ? ' [' + q.mode + ']' : ''}: ${cards.length} cards (${added} new, total ${seen.size})`);
    if (seen.size >= limit) break;
    sleep(sleepMs);
  }

  const result = {
    source: 'linkedin',
    generatedAt: new Date().toISOString(),
    profile: { titles: queries.map((q) => q.title).filter((v, i, a) => a.indexOf(v) === i) },
    queries: perQuery,
    totalUnique: seen.size,
    cards: [...seen.values()],
  };
  writeJson(out, result);
  console.log(JSON.stringify({ out, queries: perQuery.length, uniqueCards: seen.size, file: out }, null, 1));
}

async function cmdResolve(flags) {
  const file = flags.in;
  if (!file) {
    console.error('usage: resolve --in <cards.json> [--limit N] [--sleep ms] [--only <jobId>]');
    process.exit(2);
  }
  ensureChrome();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const limit = Number(flags.limit || 40);
  const sleepMs = Number(flags.sleep || 1500);
  let processed = 0;
  const counts = { external: 0, easy_apply: 0, closed: 0, unresolved: 0 };
  for (const card of data.cards || []) {
    if (processed >= limit) break;
    if (flags.only && card.id !== String(flags.only)) continue;
    if (card.resolved) continue;
    const url = `https://www.linkedin.com/jobs/view/${card.id}/`;
    const state = openAndWait(url, RESOLVE_JS, { timeoutMs: 15000 });
    if (state.authwall) {
      console.error('LOGIN WALL: sign in to LinkedIn in the visible Chrome window, then re-run.');
      process.exit(3);
    }
    card.closed = !!state.closed;
    card.appliedAlready = !!state.appliedAlready;
    if (state.easyApply) {
      card.applyMode = 'easy_apply';
      card.resolved = true;
      card.atsUrl = '';
      counts.easy_apply++;
    } else if (state.applyHref) {
      const decoded = decodeSafetyGo(state.applyHref);
      if (decoded && !/linkedin\.com/i.test(decoded)) {
        card.applyMode = 'external';
        card.atsUrl = decoded;
        card.resolved = true;
        counts.external++;
      } else {
        card.applyMode = 'unresolved';
        counts.unresolved++;
      }
    } else if (state.closed) {
      card.applyMode = 'closed';
      card.resolved = true;
      counts.closed++;
    } else {
      card.applyMode = 'unresolved';
      counts.unresolved++;
    }
    processed++;
    if (processed % 10 === 0) log(`  processed ${processed}/${limit} (${counts.unresolved} unresolved)`);
    sleep(sleepMs);
  }
  writeJson(file, data);
  console.log(JSON.stringify({ file, processed, ...counts }, null, 1));
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0] || 'help';
if (cmd === 'check') await cmdCheck();
else if (cmd === 'run') await cmdRun(flags);
else if (cmd === 'resolve') await cmdResolve(flags);
else {
  console.log(`linkedin-sweep.mjs — signed-in LinkedIn Jobs discovery (via apply-to-jobs chrome.mjs)

commands:
  check                          verify Chrome + LinkedIn sign-in
  run [options]                  sweep LinkedIn Jobs search results
  resolve --in FILE [--limit N]  resolve original ATS URLs for the cards

run options:
  --titles "a,b,c"   target titles (default: profile-derived FE+AI mix)
  --days N           1|3|7|30 (default 7)
  --pages N          pages per query (default 2 x 25 cards)
  --limit N          max unique cards (default 250)
  --loc "…"          single location override (default: Hyderabad + India-remote)
  --out FILE         output path (default ~/.job-search/sweeps/<date>-linkedin/linkedin-cards.json)
  --no-india         Hyderabad-only

Output cards: { id, title, company, location, listed, listedDate, linkedinUrl, query }
resolve adds: applyMode (external|easy_apply|unresolved|closed), atsUrl, appliedAlready`);
}
