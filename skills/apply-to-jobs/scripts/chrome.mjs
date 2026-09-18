#!/usr/bin/env node
// chrome.mjs — minimal Chrome DevTools Protocol driver for the apply-to-jobs skill.
//
// No npm dependencies. Talks raw CDP over the WebSocket to a Chrome started with
// --remote-debugging-port (default 9222). Requires Node 22+ (global WebSocket).
//
// Typical session:
//   node chrome.mjs launch           # start Chrome with a dedicated profile (once)
//   node chrome.mjs open <job-url>
//   node chrome.mjs snap             # numbered interactive elements + coordinates
//   node chrome.mjs click 12
//   node chrome.mjs fill 7 "Jane Doe"      (index from the most recent snap)
//   node chrome.mjs upload 'input[type=file]' /path/cv.pdf
//   node chrome.mjs text             # page text (truncated)
//   node chrome.mjs eval "document.title"
//
// Indexes are positions in the current snapshot — re-run `snap` after the page
// changes, then act immediately; do not reuse indexes across snapshots.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = process.env.JOB_SEARCH_HOME || path.join(os.homedir(), '.job-search');
const PROFILE_DIR = path.join(HOME, 'chrome-profile');

if (typeof WebSocket === 'undefined') {
  console.error('error: Node 22+ required (global WebSocket). Upgrade Node, or use the chrome-devtools MCP tools instead.');
  process.exit(2);
}

// ---------------------------------------------------------------- CDP client

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`cannot open CDP websocket at ${this.url}`));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

async function listPages() {
  const res = await fetch(`${BASE}/json/list`).catch(() => null);
  if (!res || !res.ok) return null;
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function connect(flags = {}) {
  const pages = await listPages();
  if (!pages) {
    console.error(`error: Chrome not reachable on port ${PORT}.`);
    console.error('Start it with:  node <this-script> launch');
    console.error('or launch Chrome manually with --remote-debugging-port=9222 (see SKILL.md).');
    process.exit(2);
  }
  let page;
  if (flags.page) page = pages.find((p) => p.id === flags.page);
  else page = pages[0];
  if (!page) {
    console.error('error: no page targets open. Run:  node <this-script> open about:blank');
    process.exit(2);
  }
  const cdp = await new CDP(page.webSocketDebuggerUrl).connect();
  return { cdp, page, pages };
}

// ---------------------------------------------------------------- jev decision loop

const JEV_ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const DECISION_LOG = path.join(HOME, 'agent-logs', 'browser-decisions.jsonl');

const CONTROLS = ['SCROLL_UP', 'SCROLL_DOWN', 'WAIT'];
const NEXT_ACTION_RULES =
  'Pick the operation that advances the goal. Prefer an unsatisfied required field over a satisfied one. Never repeat a step the history shows satisfied. WAIT only when a needed control is absent or loading. DONE only when the page visibly satisfies every requirement; BLOCKED when nothing can progress.';
const TARGET_RULES =
  'Pick the single observed target this operation should act on. Use only the candidates provided; never invent a target.';

// Snapshot elements -> the action space Jev decides over (kinds: click|fill|select|control).
function buildActions(items) {
  const actions = [];
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const role = el.tag === 'select' ? 'listbox'
      : el.tag === 'textarea' ? 'textbox'
      : el.type === 'checkbox' || el.type === 'radio' ? el.type
      : el.type === 'submit' || el.type === 'button' || el.tag === 'button' ? 'button'
      : el.tag === 'a' ? 'link' : el.tag === 'input' ? 'textbox' : el.tag;
    const label = (el.label || role).slice(0, 120);
    const base = { node: String(i), label, role, index: i };
    if (el.tag === 'select') {
      actions.push({ ...base, id: `select-${i}`, kind: 'select', current_value: el.value || '' });
    } else if (['input', 'textarea'].includes(el.tag) && !['checkbox', 'radio', 'submit', 'button', 'file', 'hidden'].includes(el.type)) {
      actions.push({ ...base, id: `fill-${i}`, kind: 'fill', value: el.value || '' });
    } else if (['checkbox', 'radio', 'submit', 'button'].includes(el.type) || el.tag === 'button' || el.tag === 'a') {
      actions.push({ ...base, id: `click-${i}`, kind: 'click' });
    } else {
      actions.push({ ...base, id: `click-${i}`, kind: 'click' });
    }
  }
  for (const c of CONTROLS) actions.push({ id: c, kind: 'control', node: '', label: c });
  return actions;
}

function loadHistory() {
  try {
    const lines = fs.readFileSync(DECISION_LOG, 'utf8').trim().split('\n').slice(-8);
    return lines.map((l) => JSON.parse(l)).filter(Boolean);
  } catch { return []; }
}

function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(DECISION_LOG), { recursive: true });
    fs.appendFileSync(DECISION_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* history is best-effort */ }
}

// Same request shape as jev-browser's jev_decide: one Choice over operations,
// one Choice per operation over its valid targets.
function buildJevRequest(goal, page, history) {
  const groups = { CLICK: {}, TYPE_TEXT: {}, SELECT: {} };
  const operations = {
    CLICK: 'Activate a clickable element',
    TYPE_TEXT: 'Enter or replace text in a fillable field',
    SELECT: 'Choose an option in a dropdown',
  };
  for (const a of page.actions) {
    if (a.kind === 'click') groups.CLICK[String(a.node)] = a;
    else if (a.kind === 'fill') groups.TYPE_TEXT[String(a.node)] = a;
    else if (a.kind === 'select') groups.SELECT[String(a.node)] = a;
  }
  const questions = {
    operation: {
      type: 'choice',
      instructions: { goal, rules: NEXT_ACTION_RULES },
      criteria: {
        ...operations,
        DONE: 'Every requirement is visibly satisfied.',
        BLOCKED: 'No supported operation can progress.',
        SCROLL_UP: 'Scroll the page up',
        SCROLL_DOWN: 'Scroll the page down',
        WAIT: 'Wait for the page to load or change',
      },
    },
  };
  const criteriaFor = (a) => ({
    what: a.label,
    ...(a.role ? { role: a.role } : {}),
    ...(a.value ? { current_value: String(a.value).slice(0, 60) } : {}),
  });
  if (Object.keys(groups.CLICK).length) {
    questions.click_target = {
      type: 'choice',
      instructions: { goal, operation: 'CLICK', rules: [NEXT_ACTION_RULES, TARGET_RULES] },
      criteria: Object.fromEntries(Object.entries(groups.CLICK).map(([k, a]) => [k, criteriaFor(a)])),
    };
  }
  if (Object.keys(groups.TYPE_TEXT).length) {
    questions.type_text_target = {
      type: 'choice',
      instructions: { goal, operation: 'TYPE_TEXT', rules: [NEXT_ACTION_RULES, TARGET_RULES] },
      criteria: Object.fromEntries(Object.entries(groups.TYPE_TEXT).map(([k, a]) => [k, criteriaFor(a)])),
    };
  }
  if (Object.keys(groups.SELECT).length) {
    questions.select_target = {
      type: 'choice',
      instructions: { goal, operation: 'SELECT', rules: [NEXT_ACTION_RULES, TARGET_RULES] },
      criteria: Object.fromEntries(Object.entries(groups.SELECT).map(([k, a]) => [k, criteriaFor(a)])),
    };
  }
  return {
    state: {
      goal,
      page: { url: page.url, title: page.title, text: page.text.slice(0, 6000) },
      history,
    },
    questions,
  };
}

async function callJev(body) {
  const key = (process.env.TYPESAFE_API_KEY || '').trim();
  if (!key) {
    console.error('error: TYPESAFE_API_KEY not set — run "decide --print" and use the jev_decide MCP tool instead.');
    process.exit(2);
  }
  const res = await fetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, ...body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`error: jev ${res.status}: ${text.slice(0, 300)}`);
    process.exit(2);
  }
  return res.json();
}

async function callTextField(context) {
  const key = (process.env.TEXT_MODEL_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const base = process.env.TEXT_MODEL_BASE_URL || 'https://api.deepseek.com/v1';
  const model = process.env.TEXT_MODEL || 'deepseek-chat';
  if (!key) {
    console.error('error: TEXT_MODEL_API_KEY not set — answer from profile/QA bank and pass the value to fill directly.');
    process.exit(2);
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You output exactly one string: the value to type into the described web form field. No quotes, no explanation. Use only the provided facts.' },
        { role: 'user', content: JSON.stringify(context) },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`error: text model ${res.status}: ${text.slice(0, 300)}`);
    process.exit(2);
  }
  const data = await res.json();
  console.log(String(data?.choices?.[0]?.message?.content || '').trim());
}

// ---------------------------------------------------------------- page JS

const COLLECT_JS = `(() => {
  const out = [];
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=option],[role=tab],[role=menuitem],[contenteditable=true],[aria-label]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const label = String(
      el.getAttribute('aria-label') || el.innerText || el.value ||
      el.getAttribute('placeholder') || el.name || el.title || ''
    ).replace(/\\s+/g, ' ').trim().slice(0, 90);
    const cls = typeof el.className === 'string' ? el.className : '';
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      label,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      id: el.id || '',
      name: el.name || '',
      required: !!(el.required || el.getAttribute('aria-required') === 'true' || /required/i.test(cls)),
      value: typeof el.value === 'string' ? el.value.slice(0, 60) : '',
    });
    if (out.length >= 300) break;
  }
  return JSON.stringify(out);
})()`;

async function collect(cdp) {
  const res = await cdp.send('Runtime.evaluate', { expression: COLLECT_JS, returnByValue: true });
  return JSON.parse(res.result.value || '[]');
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'page exception');
  return res.result.value;
}

async function clickAt(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

// ---------------------------------------------------------------- commands

const commands = {
  async launch() {
    const candidates = [
      process.env.CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
    ].filter(Boolean);
    let bin = null;
    for (const cand of candidates) {
      if (cand.includes('/') || cand.includes('\\')) {
        if (fs.existsSync(cand)) { bin = cand; break; }
      } else {
        try {
          const which = spawn('which', [cand], { stdio: ['ignore', 'pipe', 'ignore'] });
          const out = await new Promise((r) => which.on('close', (code) => r(code)));
          if (out === 0) { bin = cand; break; }
        } catch { /* keep looking */ }
      }
    }
    if (!bin) {
      console.error('error: Chrome not found. Set CHROME_PATH or start Chrome yourself with:');
      console.error(`  --remote-debugging-port=${PORT} --user-data-dir="${PROFILE_DIR}"`);
      process.exit(2);
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`launched: ${bin}`);
    console.log(`profile:  ${PROFILE_DIR}`);
    console.log(`port:     ${PORT} (first run: log in to sites once in this window; the profile persists)`);
  },

  async status() {
    const res = await fetch(`${BASE}/json/version`).catch(() => null);
    if (!res || !res.ok) {
      console.error(`Chrome not reachable on port ${PORT}`);
      process.exit(2);
    }
    const info = await res.json();
    console.log(`ok: ${info.Browser}`);
    console.log(`profile: ${PROFILE_DIR}`);
  },

  async pages() {
    const pages = await listPages();
    if (!pages) {
      console.error(`Chrome not reachable on port ${PORT}`);
      process.exit(2);
    }
    pages.forEach((p, i) => console.log(`[${i}] ${p.id.slice(0, 8)} ${p.title || '(untitled)'} — ${p.url}`));
  },

  async open(pos, flags) {
    const url = pos[0];
    if (!url) throw new Error('usage: open <url> [--new]');
    const pages = await listPages();
    if (!pages) {
      console.error(`Chrome not reachable on port ${PORT} — run: node chrome.mjs launch`);
      process.exit(2);
    }
    if (pages.length && !flags.new) {
      const { cdp, page } = await connect();
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 1500));
      console.log(`navigated [${page.id.slice(0, 8)}] ${url}`);
      cdp.close();
      return;
    }
    // Chrome DevTools HTTP API takes the raw URL as the query string
    // (e.g. PUT /json/new?https://example.com). encodeURI preserves :/?/&
    // while escaping spaces; encodeURIComponent would mangle the scheme.
    const res = await fetch(`${BASE}/json/new?${encodeURI(url)}`, { method: 'PUT' });
    const target = await res.json();
    console.log(`opened ${target.url}`);
  },

  async snap() {
    const { cdp } = await connect();
    const items = await collect(cdp);
    items.forEach((el, i) => {
      const kind = [el.tag, el.type && `type=${el.type}`, el.id && `#${el.id}`, el.name && `name=${el.name}`]
        .filter(Boolean).join(' ');
      const flags = el.required ? ' REQUIRED' : '';
      const val = el.value ? ` value="${el.value}"` : '';
      console.log(`[${i}] ${kind} "${el.label}" @ ${el.x},${el.y}${flags}${val}`);
    });
    if (!items.length) console.log('(no interactive elements found)');
    cdp.close();
  },

  async text(pos, flags) {
    if (flags.field) {
      let ctx;
      try { ctx = JSON.parse(flags.field); } catch { throw new Error('--field must be JSON: {goal, field, page?, facts?}'); }
      await callTextField(ctx);
      return;
    }
    const { cdp } = await connect();
    const raw = await evalJs(cdp, 'document.body ? document.body.innerText : ""');
    const max = Number(flags.max || 6000);
    console.log(String(raw || '').slice(0, max));
    cdp.close();
  },

  // One decision cycle: snapshot -> action space -> Jev picks operation + target.
  // Default: print the request for the jev_decide MCP tool. --local: call the API directly.
  async decide(pos, flags) {
    const goal = String(flags.goal || pos.join(' ') || '').trim();
    if (!goal) throw new Error('usage: decide --goal "<what to accomplish on this page>" [--local] [--print] [--url U --title T --body B]');
    let items = [];
    let pageUrl = flags.url || '';
    let pageTitle = flags.title || '';
    let pageText = flags.body || '';
    if (!flags.body) {
      const { cdp, page } = await connect();
      pageUrl = pageUrl || page.url || '';
      pageTitle = pageTitle || page.title || '';
      const rawText = await evalJs(cdp, 'document.body ? document.body.innerText : ""');
      pageText = String(rawText || '').slice(0, 6000);
      if (!flags.url || !flags.title) {
        const docTitle = await evalJs(cdp, 'document.title').catch(() => pageTitle);
        pageTitle = pageTitle || String(docTitle || '');
      }
      items = await collect(cdp);
      cdp.close();
    }
    const actions = buildActions(items);
    const history = loadHistory();
    const request = buildJevRequest(goal, { url: pageUrl, title: pageTitle, text: pageText, actions }, history);
    if (flags.print || !process.env.TYPESAFE_API_KEY) {
      console.log(JSON.stringify({ ...request, _hint: 'Pass state+goal structure to jev_decide: {goal, page:{url,title,text,actions}, history}, then run "do <target> <kind>".' }, null, 1));
      return;
    }
    const data = await callJev(request);
    const a = data.answers || {};
    const operation = a.operation?.choice || 'BLOCKED';
    const targetKey = `${operation.toLowerCase()}_target`;
    const targetAnswer = a[targetKey];
    const target = targetAnswer?.choice ?? null;
    const index = target !== null && /^\d+/.test(String(target)) ? Number(String(target).split(':')[0]) : null;
    const decision = {
      operation,
      target,
      index,
      confidence: a.operation?.confidence ?? null,
      operation_probabilities: a.operation?.probabilities || {},
      target_confidence: targetAnswer?.confidence ?? null,
      model: data.model || null,
    };
    appendHistory({ goal, operation, target, page_url: pageUrl });
    console.log(JSON.stringify(decision, null, 1));
  },

  // Execute one decided action against the CURRENT snapshot (re-collects, so a
  // stale index cannot hit the wrong element silently).
  async do(pos) {
    const i = Number(pos[0]);
    const kind = String(pos[1] || 'click').toLowerCase();
    const value = pos.slice(2).join(' ');
    if (!Number.isInteger(i)) throw new Error('usage: do <index> <click|fill|select> [value]');
    const { cdp } = await connect();
    const items = await collect(cdp);
    const el = items[i];
    if (!el) throw new Error(`no element [${i}] in snapshot (re-run decide/snap)`);
    if (kind === 'click') {
      await clickAt(cdp, el.x, el.y);
      console.log(`clicked [${i}] "${el.label}" @ ${el.x},${el.y}`);
    } else if (kind === 'fill') {
      if (!value) throw new Error('usage: do <index> fill <value>');
      const filled = await evalJs(cdp, `(() => {
        const items = JSON.parse(${COLLECT_JS});
        const el = items[${i}];
        if (!el) return 'no-element';
        const nodes = [...document.querySelectorAll('input,textarea,[contenteditable=true]')]
          .map((n) => ({ n, r: n.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 1 && r.height > 1)
          .map(({ n, r }) => ({ n, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
          .sort((a, b) => a.d - b.d);
        const node = nodes[0] && nodes[0].d < 8 ? nodes[0].n : null;
        if (!node) return 'no-input';
        node.focus();
        if (node.isContentEditable) node.textContent = ${JSON.stringify(value)};
        else {
          const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
        }
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return node.value !== undefined ? String(node.value).slice(0, 80) : 'ok';
      })()`);
      console.log(`filled [${i}] -> ${filled}`);
    } else if (kind === 'select') {
      if (!value) throw new Error('usage: do <index> select <value|label>');
      const out = await evalJs(cdp, `(() => {
        const items = JSON.parse(${COLLECT_JS});
        const el = items[${i}];
        if (!el) return 'no-element';
        const selects = [...document.querySelectorAll('select')]
          .map((s) => ({ s, r: s.getBoundingClientRect() }))
          .map(({ s, r }) => ({ s, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
          .sort((a, b) => a.d - b.d);
        const sel = selects[0] && selects[0].d < 10 ? selects[0].s : null;
        if (!sel) return 'no-select';
        const wanted = ${JSON.stringify(value)}.toLowerCase();
        for (const opt of sel.options) {
          if (opt.value.toLowerCase() === wanted || opt.textContent.trim().toLowerCase() === wanted) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return opt.textContent.trim();
          }
        }
        return 'option-not-found';
      })()`);
      console.log(`selected [${i}] -> ${out}`);
    } else if (kind === 'control') {
      const control = String(pos[1] || '').toUpperCase();
      if (control === 'SCROLL_DOWN') await evalJs(cdp, 'window.scrollBy(0, window.innerHeight * 0.8)');
      else if (control === 'SCROLL_UP') await evalJs(cdp, 'window.scrollBy(0, -window.innerHeight * 0.8)');
      else if (control === 'WAIT') await new Promise((r) => setTimeout(r, 1000));
      console.log(`control ${control}`);
    } else {
      throw new Error(`unknown kind "${kind}" (click|fill|select|control)`);
    }
    appendHistory({ operation: kind.toUpperCase(), target: String(i), page_url: el ? el.label : '' });
    await new Promise((r) => setTimeout(r, 400));
    cdp.close();
  },

  async click(pos) {
    const target = pos[0];
    if (!target) throw new Error('usage: click <index|--x N --y N>');
    const { cdp } = await connect();
    if (/^\d+,\d+$/.test(target)) {
      const [x, y] = target.split(',').map(Number);
      await clickAt(cdp, x, y);
      console.log(`clicked ${x},${y}`);
    } else {
      const i = Number(target);
      const items = await collect(cdp);
      const el = items[i];
      if (!el) throw new Error(`no element [${i}] in snapshot (re-run snap)`);
      await clickAt(cdp, el.x, el.y);
      console.log(`clicked [${i}] "${el.label}" @ ${el.x},${el.y}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    cdp.close();
  },

  async fill(pos) {
    const i = Number(pos[0]);
    const value = pos.slice(1).join(' ');
    if (!Number.isInteger(i) || !value) throw new Error('usage: fill <index> <value>');
    const { cdp } = await connect();
    const filled = await evalJs(cdp, `(() => {
      const items = JSON.parse(${COLLECT_JS});
      const el = items[${i}];
      if (!el) return 'no-element';
      // Prefer stable id/name resolution over coordinate distance so a DOM
      // shift between snap and fill cannot silently fill the wrong field.
      let node = null;
      if (el.id) {
        const byId = document.getElementById(el.id);
        if (byId && ((/^(INPUT|TEXTAREA|SELECT)$/.test(byId.tagName)) || byId.isContentEditable)) node = byId;
      }
      if (!node && el.name) {
        try {
          const byName = document.querySelector('[name="' + CSS.escape(el.name) + '"]');
          if (byName) node = byName;
        } catch { /* bad name — fall through to distance */ }
      }
      if (!node) {
        const nodes = [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')];
        const nodesByRect = nodes
          .map((n) => ({ n, r: n.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 1 && r.height > 1)
          .map(({ n, r }) => ({ n, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
          .sort((a, b) => a.d - b.d);
        node = nodesByRect[0] && nodesByRect[0].d < 6 ? nodesByRect[0].n : null;
      }
      if (!node) return 'no-input';
      node.focus();
      if (node.isContentEditable) {
        node.textContent = ${JSON.stringify(value)};
      } else {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(node, ${JSON.stringify(value)});
      }
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return node.value !== undefined ? String(node.value).slice(0, 80) : 'ok';
    })()`);
    console.log(`fill [${i}] -> ${filled}`);
    cdp.close();
  },

  async type(pos) {
    const value = pos.join(' ');
    if (!value) throw new Error('usage: type <text>  (into the focused field)');
    const { cdp } = await connect();
    await cdp.send('Input.insertText', { text: value });
    console.log(`typed ${value.length} chars`);
    cdp.close();
  },

  async keys(pos) {
    const value = pos.join(' ');
    if (!value) throw new Error('usage: keys <text>  (per-character key events, for react-select)');
    const { cdp } = await connect();
    for (const ch of value) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await new Promise((r) => setTimeout(r, 60));
    }
    console.log(`typed ${value.length} chars (key events)`);
    cdp.close();
  },

  async select(pos) {
    const i = Number(pos[0]);
    const value = pos.slice(1).join(' ');
    if (!Number.isInteger(i) || !value) throw new Error('usage: select <index> <value|label>');
    const { cdp } = await connect();
    const out = await evalJs(cdp, `(() => {
      const items = JSON.parse(${COLLECT_JS});
      const el = items[${i}];
      if (!el) return 'no-element';
      let sel = null;
      if (el.id) {
        const byId = document.getElementById(el.id);
        if (byId && byId.tagName === 'SELECT') sel = byId;
      }
      if (!sel) {
        const selects = [...document.querySelectorAll('select')];
        const best = selects
          .map((s) => ({ s, r: s.getBoundingClientRect() }))
          .map(({ s, r }) => ({ s, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
          .sort((a, b) => a.d - b.d)[0];
        if (!best || best.d > 8) return 'no-select';
        sel = best.s;
      }
      const wanted = ${JSON.stringify(value)}.toLowerCase();
      for (const opt of sel.options) {
        if (opt.value.toLowerCase() === wanted || opt.textContent.trim().toLowerCase() === wanted) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return opt.textContent.trim();
        }
      }
      return 'option-not-found';
    })()`);
    console.log(`select [${i}] -> ${out}`);
    cdp.close();
  },

  async check(pos) {
    const i = Number(pos[0]);
    const { cdp } = await connect();
    const items = await collect(cdp);
    const el = items[i];
    if (!el) throw new Error(`no element [${i}] in snapshot (re-run snap)`);
    const result = await evalJs(cdp, `(() => {
      const items = JSON.parse(${COLLECT_JS});
      const el = items[${i}];
      const boxes = [...document.querySelectorAll('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]')];
      const box = boxes
        .map((b) => ({ b, r: b.getBoundingClientRect() }))
        .map(({ b, r }) => ({ b, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
        .sort((a, b) => a.d - b.d)[0];
      if (box && box.d < 10) {
        if (box.b.checked) return 'already-checked';
        box.b.click();
        return 'clicked';
      }
      return 'no-native';
    })()`);
    if (result === 'no-native') await clickAt(cdp, el.x, el.y);
    console.log(`check [${i}] "${el.label}" -> ${result}`);
    cdp.close();
  },

  async key(pos) {
    const keyName = pos[0];
    if (!keyName) throw new Error('usage: key <Enter|Tab|Escape|ArrowDown|...>');
    const codes = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38,
      ArrowLeft: 37, ArrowRight: 39, Space: 32,
    };
    const code = codes[keyName];
    if (!code) throw new Error(`unsupported key "${keyName}" (use Enter, Tab, Escape, Arrow*, Space)`);
    const { cdp } = await connect();
    const isChar = keyName === 'Enter' || keyName === 'Space';
    await cdp.send('Input.dispatchKeyEvent', {
      type: isChar ? 'keyDown' : 'rawKeyDown',
      text: keyName === 'Enter' ? '\r' : keyName === 'Space' ? ' ' : undefined,
      key: keyName === 'Space' ? ' ' : keyName,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyName === 'Space' ? ' ' : keyName,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    console.log(`key ${keyName}`);
    cdp.close();
  },

  async upload(pos) {
    const [selector, file] = pos;
    if (!selector || !file) throw new Error('usage: upload <css-selector> <file>');
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const { cdp } = await connect();
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: 1, pierce: true });
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!found.nodeId) throw new Error(`selector not found: ${selector}`);
    await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path.resolve(file)] });
    console.log(`uploaded ${file} -> ${selector}`);
    cdp.close();
  },

  async eval(pos) {
    const expression = pos.join(' ');
    if (!expression) throw new Error('usage: eval <js>');
    const { cdp } = await connect();
    const value = await evalJs(cdp, expression);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    cdp.close();
  },

  async wait(pos, flags) {
    const needle = pos.join(' ');
    if (!needle) throw new Error('usage: wait <text> [--timeout ms]');
    const timeout = Number(flags.timeout || 20000);
    const { cdp } = await connect();
    const start = Date.now();
    for (;;) {
      const body = String(await evalJs(cdp, 'document.body ? document.body.innerText : ""') || '');
      if (body.includes(needle)) {
        console.log(`found "${needle}" after ${Date.now() - start}ms`);
        cdp.close();
        return;
      }
      if (Date.now() - start > timeout) {
        console.error(`timeout: "${needle}" not found in ${timeout}ms`);
        cdp.close();
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  },

  async shot(pos) {
    const file = path.resolve(pos[0] || 'screenshot.png');
    const { cdp } = await connect();
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    console.log(file);
    cdp.close();
  },

  async close() {
    const pages = await listPages();
    if (!pages || !pages.length) return;
    const page = pages[0];
    await fetch(`${BASE}/json/close/${page.id}`).catch(() => null);
    console.log(`closed ${page.id.slice(0, 8)}`);
  },
};

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`chrome.mjs — CDP driver (port ${PORT}, profile ${PROFILE_DIR})

commands:
  launch                                start Chrome with the job-search profile
  status | pages | close                inspect tabs
  open <url> [--new]                    navigate or open a new tab
  snap                                  numbered interactive elements (gold for clicking)
  text [--max N]                        page innerText
  click <index|x,y>                     real mouse click
  fill <index> <value>                  set input/textarea value (React-safe)
  type <text>                           insert text into focused field
  keys <text>                           per-character key events (react-select)
  select <index> <value>                pick a <select> option
  check <index>                         tick a checkbox/radio (native + coordinate click)
  key <Enter|Tab|Escape|ArrowDown>      press a key
  upload <css-selector> <file>          set a file input
  eval <js>                             evaluate JS in the page
  wait <text> [--timeout ms]            wait for text to appear
  shot [file.png]                       screenshot`);
  process.exit(cmd ? 0 : 2);
}
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  } else args.push(rest[i]);
}
if (!commands[cmd]) {
  console.error(`unknown command: ${cmd} (run with --help)`);
  process.exit(2);
}
commands[cmd](args, flags).catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
