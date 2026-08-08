'use strict';
/*
 * mobile-selftest — load the real page in a real browser at a real phone
 * viewport and assert that the things you have to touch are actually touchable.
 *
 *   npx playwright install firefox      # once, ad hoc — see the note below
 *   node tools/mobile-selftest.js
 *
 * WHY THIS EXISTS, AND WHY ui-selftest.js IS NOT ENOUGH.
 *
 * Twice now the page has shipped with the composer and the hamburger pushed off
 * the bottom of a phone screen, leaving the user unable to type on the only
 * device they read this on. Both times the stub-DOM suite passed — 173 checks,
 * all green — because it asserts that elements *exist*, and they did exist.
 * They were simply somewhere you could not reach. Existence is not visibility.
 *
 * So this suite asserts geometry, in a browser that does layout: on screen, not
 * clipped, not covered by something else, at 390x844. It is deliberately small
 * and deliberately about reachability rather than appearance — screenshots
 * would need a human, and a human is exactly what was not in the loop.
 *
 * DEPENDENCIES. This project has none and keeps it that way; playwright is not
 * in package.json and must not be. Install it ad hoc when you want to run this
 * (`npm i --no-save playwright`), which is why the suite is opt-in rather than
 * part of `node tools/ui-selftest.js`.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const PORT = Number(process.env.PORT || 3995);
// A phone, not a small desktop window. iPhone/Pixel-class portrait.
const VIEWPORT = { width: 390, height: 844 };
const UA = 'Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0';

let firefox;
try {
  ({ firefox } = require('playwright'));
} catch (e) {
  console.error('mobile-selftest needs playwright, which this project does not depend on.');
  console.error('Install it just for this run:\n  npm i --no-save playwright && npx playwright install firefox');
  process.exit(2);
}

/* ---- a stand-in server, so the suite never touches the live queue ---- */
const N = 600;                    // more history than the client is allowed to hold
const now = Date.now();
const ENTRIES = [];
for (let i = 0; i < N; i++) {
  const ts = new Date(now - (N - i) * 60000).toISOString();
  ENTRIES.push({
    id: 't' + i, role: i % 2 ? 'agent' : 'user', status: 'done', ts, rev: ts,
    text: 'message ' + i + ' — a bit of body text so the bubble has a realistic size',
    conversationId: 'main',
  });
}
const conv = (id, title, agent, state) => ({
  id, title, agent, createdAt: new Date(now - 8.64e7).toISOString(),
  lastTs: ENTRIES[N - 1].ts, lastText: 'something was said', lastRole: 'user',
  counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
  spark: [1, 2, 0, 3, 5, 2, 0, 0, 1, 4, 2, 1], sparkBucketMs: 900000,
  agentState: { state, agoSec: 4, actedAgoSec: 4 },
});
const CONVS = {
  defaultId: 'main',
  conversations: [conv('main', 'Main', 'Zora', 'watching'), conv('iceland', 'Iceland', 'Iceland', 'idle')],
};

let sse = [];
const clientLogs = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(PAGE));
  }
  if (u.pathname === '/thread') {
    const since = Number(u.searchParams.get('since') || 0);
    const lim = Number(u.searchParams.get('limit') || 0);
    let e = ENTRIES;
    if (since) e = e.filter((x) => Date.parse(x.rev) > since);
    else if (lim) e = e.slice(-lim);
    return json({ entries: e });
  }
  if (u.pathname === '/conversations') return json(CONVS);
  if (u.pathname === '/status') return json({ headline: { text: 'ok' }, counts: {} });
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sse.push(res);
    req.on('close', () => { sse = sse.filter((r) => r !== res); });
    return;
  }
  if (u.pathname === '/client-log') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { try { clientLogs.push(JSON.parse(b)); } catch (e) { /* ignore */ } json({ ok: true }); });
    return;
  }
  res.writeHead(404); res.end();
});

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? `  — ${detail}` : ''}`);
}

/*
 * On screen AND reachable. `elementFromPoint` is the part that matters: an
 * element can be perfectly positioned and still be untappable because a bar,
 * a scrim or an overlay is sitting on top of it.
 */
function REACHABLE(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, why: 'missing' };
  const b = el.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { ok: false, why: 'zero size' };
  const vw = window.innerWidth, vh = window.innerHeight;
  if (b.top < -0.5 || b.bottom > vh + 0.5 || b.left < -0.5 || b.right > vw + 0.5) {
    return {
      ok: false,
      why: 'off screen ' + JSON.stringify([Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]) +
        ' in viewport ' + vw + 'x' + vh,
    };
  }
  const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  if (!(top === el || el.contains(top) || (top && top.contains(el)))) {
    return { ok: false, why: 'covered by ' + (top ? (top.id || top.tagName) : 'nothing') };
  }
  return { ok: true };
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}/`;
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, userAgent: UA });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#list .msg').length > 0, { timeout: 30000 });
  await page.waitForTimeout(1000);

  console.log(`\nthe page at ${VIEWPORT.width}x${VIEWPORT.height}`);
  check('it loads without a JS error', errors.length === 0, errors.join(' | '));

  console.log('\nyou can still reach the controls — this is the check that was missing');
  for (const [name, sel] of [
    ['the hamburger menu', '#menu'],
    ['the message box', '#input'],
    ['Send', '#send'],
    ['the mic', '#mic'],
    ['the conversation button', '#convo'],
  ]) {
    const r = await page.evaluate(REACHABLE, sel);
    check(`${name} is on screen and not covered`, r.ok, r.why);
  }

  console.log('\nyou can actually type');
  await page.click('#input');
  await page.type('#input', 'a typed message');
  const typed = await page.evaluate(() => ({
    val: document.querySelector('#input').value,
    bottom: Math.round(document.querySelector('#composer').getBoundingClientRect().bottom),
    vh: innerHeight,
  }));
  check('the box accepts text', typed.val === 'a typed message', JSON.stringify(typed.val));
  check('the composer stays on screen while typing', typed.bottom <= typed.vh + 1, JSON.stringify(typed));

  // A long message must not let the composer eat the whole screen.
  await page.fill('#input', Array(60).fill('a fairly long line of dictated text').join(' '));
  await page.waitForTimeout(200);
  const grown = await page.evaluate(() => ({
    h: Math.round(document.querySelector('#input').getBoundingClientRect().height),
    vh: innerHeight,
    threadH: Math.round(document.querySelector('#thread').getBoundingClientRect().height),
  }));
  check('a long draft does not swallow the screen', grown.h <= grown.vh * 0.45 && grown.threadH > 100, JSON.stringify(grown));
  const stillThere = await page.evaluate(REACHABLE, '#send');
  check('Send survives a long draft', stillThere.ok, stillThere.why);
  await page.fill('#input', '');

  console.log('\nthe drawer opens and closes');
  await page.click('#menu');
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => document.querySelectorAll('#convlist .conv').length);
  check('the hamburger opens the conversation list', rows === 2, `${rows} rows`);
  const newConv = await page.evaluate(REACHABLE, '#newtitle');
  check('the new-conversation field is reachable inside it', newConv.ok, newConv.why);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.querySelector('#drawer').hidden);
  check('Escape closes it again', closed === true, String(closed));

  console.log('\nthe live path still works');
  const ts = new Date().toISOString();
  const pushed = { id: 'live-1', role: 'agent', status: 'done', text: 'pushed over SSE', ts, rev: ts, conversationId: 'main' };
  ENTRIES.push(pushed);
  sse.forEach((r) => r.write('data: ' + JSON.stringify({ entries: [pushed] }) + '\n\n'));
  await page.waitForTimeout(1500);
  const last = await page.evaluate(() => {
    const n = document.querySelectorAll('#list .msg');
    return n.length ? n[n.length - 1].textContent : '';
  });
  check('an SSE push still lands in the thread', last.indexOf('pushed over SSE') >= 0, last.slice(0, 60));

  const resident = await page.evaluate(() => document.querySelectorAll('#list .msg').length);
  check(`the thread stays bounded with ${N} messages available`, resident <= 300, `${resident} resident`);

  console.log('\na tab that dies is reported by the next one');
  clientLogs.length = 0;
  await page.evaluate(() => { setTimeout(() => { throw new Error('deliberate selftest error'); }, 0); });
  await page.waitForTimeout(800);
  check('an uncaught error reaches the server log',
    clientLogs.some((l) => l.event === 'js-error' && /deliberate selftest error/.test(JSON.stringify(l.detail))),
    JSON.stringify(clientLogs.map((l) => l.event)));

  // A killed tab runs no `pagehide`, so its marker is left standing. Closing
  // this page (which does run it) and seeding a fresh tab is the faithful stage.
  await page.close();
  clientLogs.length = 0;
  const next = await ctx.newPage();
  await next.addInitScript((m) => { try { localStorage.setItem('relay.session', m); } catch (e) { /* ignore */ } },
    JSON.stringify({ open: true, startedAt: now - 425000, aliveMs: 425000, entries: 291, conv: true, speak: true, hidden: false, heapMB: null }));
  await next.goto(base, { waitUntil: 'load' });
  await next.waitForTimeout(1200);
  const gone = clientLogs.find((l) => l.event === 'page-vanished');
  check('a vanished tab is reported on the next load', !!gone, JSON.stringify(clientLogs.map((l) => l.event)));
  check('...with how long it lived and what it was doing',
    !!(gone && gone.detail.aliveSec === 425 && gone.detail.entries === 291 && gone.detail.conv === true),
    JSON.stringify(gone && gone.detail));

  // And a deliberate reload must NOT be reported as a crash, or the signal is
  // noise — and this page gets reloaded constantly. A fresh tab, with no seeded
  // marker, so what is measured is the page's own behaviour and not the stage.
  await next.close();
  const plain = await ctx.newPage();
  await plain.goto(base, { waitUntil: 'load' });
  await plain.waitForTimeout(1000);
  clientLogs.length = 0;
  await plain.reload({ waitUntil: 'load' });
  await plain.waitForTimeout(1200);
  check('a deliberate reload is not mistaken for a crash',
    !clientLogs.some((l) => l.event === 'page-vanished'),
    JSON.stringify(clientLogs.map((l) => l.event)));

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('mobile-selftest harness error:', e); process.exit(1); });
