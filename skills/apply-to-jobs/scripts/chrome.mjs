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
    const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
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
    const { cdp } = await connect();
    const raw = await evalJs(cdp, 'document.body ? document.body.innerText : ""');
    const max = Number(flags.max || 6000);
    console.log(String(raw || '').slice(0, max));
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
      const nodes = [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')];
      const nodesByRect = nodes
        .map((n) => ({ n, r: n.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 1 && r.height > 1)
        .map(({ n, r }) => ({ n, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
        .sort((a, b) => a.d - b.d);
      const node = nodesByRect[0] && nodesByRect[0].d < 6 ? nodesByRect[0].n : null;
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
      const selects = [...document.querySelectorAll('select')];
      const select = selects
        .map((s) => ({ s, r: s.getBoundingClientRect() }))
        .map(({ s, r }) => ({ s, d: Math.hypot(r.x + r.width / 2 - el.x, r.y + r.height / 2 - el.y) }))
        .sort((a, b) => a.d - b.d)[0];
      if (!select || select.d > 8) return 'no-select';
      const wanted = ${JSON.stringify(value)}.toLowerCase();
      for (const opt of select.s.options) {
        if (opt.value.toLowerCase() === wanted || opt.textContent.trim().toLowerCase() === wanted) {
          select.s.value = opt.value;
          select.s.dispatchEvent(new Event('change', { bubbles: true }));
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
