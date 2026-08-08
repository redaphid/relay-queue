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

const ICONS = require('../icons.js');

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

// The checklist the user actually asked for, at the end so it is on screen.
{
  const ts = new Date(now - 30000).toISOString();
  ENTRIES.push({
    id: 'packing', role: 'agent', status: 'done', ts, rev: ts, conversationId: 'main',
    text: '## Iceland packing\n\n- [ ] passport and boarding pass\n- [ ] travel adapters\n- [x] wool socks\n- [ ] waterproof shell\n\nSee [the forecast](https://example.com/wx). Injection attempt: <img src=x onerror=alert(1)> and [tap](javascript:alert(2)).',
  });
}

let sse = [];
const posted = [];
const clientLogs = [];
const pushPosts = [];
// What /push/config answers: a browser that is NOT yet armed, and quiet hours
// set in Iceland — so the page has to state a timezone that is not this
// machine's, which is the case that matters while he is away.
const PUSHCFG = {
  enabled: true,
  vapidPublicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  subscribedHere: false,
  devices: [],
  categories: { 'needs-you': true, done: true, broken: false },
  brokenOverridesQuiet: false,
  quiet: {
    timezone: 'Atlantic/Reykjavik', requestedTimezone: 'Atlantic/Reykjavik', zoneKnown: true,
    zoneNow: '21:14', configured: true, active: false, from: '23:00', to: '07:30', changesInMin: 106,
  },
  budgetLeft: 20,
  stats: { queued: 0, flushed: 0, suppressedQuiet: 0, suppressedBudget: 0, delivered: 0 },
};
/*
 * Which build the stand-in server is currently serving. The offline suite at
 * the bottom changes it mid-run and then insists the browser notices, which is
 * the only way to prove that a cached page cannot outlive a deploy.
 */
let BUILD = 'one';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // `no-store` because the real server sends it on every JSON route. Without it
  // Firefox's own HTTP cache can answer a read while offline, which would make
  // the offline suite pass on evidence that does not exist in production.
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(o));
  };
  if (u.pathname === '/') {
    const html = fs.readFileSync(PAGE, 'utf8')
      .replace('<title>relay</title>', '<title>relay</title>\n<meta name="build" content="' + BUILD + '">');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The real server sends this, and the worker refuses to cache a shell
      // without it. Omitting it here would make the offline suite test nothing.
      'x-relay-app': '1',
      'cache-control': 'no-store',
    });
    return res.end(html);
  }
  if (u.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify({
      name: 'relay', short_name: 'relay', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#0e1116', theme_color: '#0e1116',
      icons: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
    }));
  }
  {
    const png = ICONS.icon(u.pathname.slice(1));
    if (png) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
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
  if (u.pathname === '/sw.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'service-worker-allowed': '/' });
    return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js')));
  }
  if (u.pathname === '/push/config') {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => { try { pushPosts.push(JSON.parse(b)); } catch (e) { /* ignore */ } json(PUSHCFG); });
      return;
    }
    return json(PUSHCFG);
  }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sse.push(res);
    req.on('close', () => { sse = sse.filter((r) => r !== res); });
    return;
  }
  if (u.pathname === '/tasks' && req.method === 'POST') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      try { posted.push(JSON.parse(b)); } catch (e) { /* ignore */ }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chk-' + posted.length }));
    });
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

/*
 * Really unplugging it.
 *
 * context.setOffline(true) is not enough, and believing it was would have made
 * the whole offline suite worthless: in Firefox it stops the PAGE reaching the
 * network but leaves the SERVICE WORKER able to fetch normally. The worker
 * would quietly serve live data, every assertion about reading from cache would
 * pass for the wrong reason, and none of it would hold on a plane.
 *
 * So the server is actually stopped, connections and all. Nothing in the
 * browser can reach it, by any thread, which is what "offline" means here.
 * setOffline is still used alongside it, because navigator.onLine and the
 * `offline` event are part of what the page reacts to.
 */
async function netDown(ctx) {
  await ctx.setOffline(true);
  await new Promise((resolve) => {
    server.close(resolve);
    // Keep-alive sockets and the open SSE stream would otherwise hold the
    // server up long past the point the test needs it gone.
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

async function netUp(ctx) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  await ctx.setOffline(false);
}

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
  /*
   * Record rather than perform. Headless Firefox will not really vibrate and
   * cannot really reach a push service, but the two things worth asserting are
   * behavioural, not physical: that a distinct pattern is requested, and that
   * permission is NEVER requested without a tap. A permission prompt fired on
   * load gets dismissed reflexively, and a dismissed permission is a dead
   * feature that cannot be revived from inside the page.
   */
  await ctx.addInitScript(() => {
    window.__vibes = [];
    window.__permAsked = 0;
    try {
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: function (p) { window.__vibes.push(p); return true; },
      });
    } catch (e) { /* leave the real one in place */ }
    try {
      if (window.Notification) {
        window.Notification.requestPermission = function () {
          window.__permAsked++;
          return Promise.resolve('default');
        };
      }
    } catch (e) { /* ignore */ }
  });
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

  console.log('\nthe checklist is usable with a thumb');
  {
    const boxes = await page.$$('#list .mdtask input[type="checkbox"]');
    check('the task list renders checkboxes', boxes.length === 4, `${boxes.length}`);

    // A checkbox you cannot hit is a checkbox you do not have. 24px is about the
    // floor for a thumb; the row's label is what actually gets tapped.
    const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('#list .mdtask'))
      .map((li) => {
        const b = li.getBoundingClientRect();
        const box = li.querySelector('input');
        const cb = box.getBoundingClientRect();
        const hit = document.elementFromPoint(cb.left + cb.width / 2, cb.top + cb.height / 2);
        return { rowH: Math.round(b.height), boxW: Math.round(cb.width), reachable: !!(hit && (hit === box || box.contains(hit) || li.contains(hit))) };
      }));
    check('every row is big enough to hit', sizes.every((s) => s.rowH >= 30 && s.boxW >= 20), JSON.stringify(sizes));
    check('every checkbox is actually reachable', sizes.every((s) => s.reachable), JSON.stringify(sizes));
    check('the list does not overflow the bubble width',
      await page.evaluate(() => {
        const l = document.querySelector('#list .mdtasks').getBoundingClientRect();
        return l.left >= -0.5 && l.right <= window.innerWidth + 0.5;
      }), 'list overflows');

    // Injection, in a browser that would actually execute it.
    const injected = await page.evaluate(() => ({
      imgs: document.querySelectorAll('#list img').length,
      scripts: document.querySelectorAll('#list script').length,
      hrefs: Array.from(document.querySelectorAll('#list a')).map((a) => a.getAttribute('href')),
      shown: document.querySelector('#list .msg:last-child .body').textContent.indexOf('onerror') >= 0,
    }));
    check('*** no element is created from message markup ***',
      injected.imgs === 0 && injected.scripts === 0, JSON.stringify(injected));
    check('*** only allowlisted schemes become links ***',
      injected.hrefs.length === 1 && injected.hrefs[0] === 'https://example.com/wx', JSON.stringify(injected.hrefs));
    check('...and the rejected markup is still visible as text', injected.shown, JSON.stringify(injected));

    // Tick one, as a finger would.
    posted.length = 0;
    await page.click('#list .mdtask:first-child label');
    await page.waitForTimeout(1200);
    const ticked = await page.evaluate(() => {
      const li = document.querySelector('#list .mdtask:first-child');
      return {
        checked: li.querySelector('input').checked,
        cls: li.className,
        mark: li.querySelector('.tmark').textContent,
      };
    });
    check('tapping the row ticks the box straight away', ticked.checked === true, JSON.stringify(ticked));
    check('the agent is told, with the item and the Vikunja request',
      posted.length === 1 && /passport/.test(posted[0].text) && /vikunja/i.test(posted[0].text),
      JSON.stringify(posted));
    check('*** an unconfirmed tick says so rather than looking done ***',
      /saving/i.test(ticked.mark) && /unsettled/.test(ticked.cls), JSON.stringify(ticked));

    // And it must come back ticked after a reload, since that is the whole point.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1800);
    const afterReload = await page.evaluate(() => {
      const li = document.querySelector('#list .mdtask:first-child');
      return li ? { checked: li.querySelector('input').checked, mark: li.querySelector('.tmark').textContent } : null;
    });
    check('*** the tick survives a reload ***', afterReload && afterReload.checked === true, JSON.stringify(afterReload));
    check('...and is still honest about not being confirmed',
      afterReload && /saving|not confirmed/i.test(afterReload.mark), JSON.stringify(afterReload));

    for (const [name, sel] of [['the message box', '#input'], ['the hamburger menu', '#menu'], ['Send', '#send']]) {
      const r = await page.evaluate(REACHABLE, sel);
      check(`${name} is still reachable with a checklist on screen`, r.ok, r.why);
    }
  }

  console.log('\nthe conversation survives a reload, in a real browser');
  {
    // Switch by tapping, exactly as the user does.
    await page.click('#menu');
    await page.waitForTimeout(600);
    await page.click('#convlist .conv:nth-child(2)');
    await page.waitForTimeout(1500);
    const url = page.url();
    check('tapping a conversation puts it in the address bar', /#\/c\/iceland$/.test(url), url);
    const title = await page.evaluate(() => document.querySelector('#title').textContent);
    check('the header follows', title === 'Iceland', title);

    // THE ACTUAL BUG: a reload used to land back in `main`.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => document.querySelector('#title').textContent);
    check('*** a real reload stays in the same conversation ***', after === 'Iceland', after);
    check('...and the address bar still names it', /#\/c\/iceland$/.test(page.url()), page.url());

    // Back must move between conversations, not leave the app.
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    const back = await page.evaluate(() => document.querySelector('#title').textContent);
    check('*** Back moves to the previous conversation, not out of the app ***',
      back === 'Main', back + ' at ' + page.url());
    await page.goForward({ waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    const fwd = await page.evaluate(() => document.querySelector('#title').textContent);
    check('Forward returns', fwd === 'Iceland', fwd + ' at ' + page.url());

    /*
     * A dead link must land somewhere usable and say so. Two different paths
     * reach it and only one of them reloads: pasting a link into a page that is
     * already open changes the fragment without a navigation, so the page has
     * to notice for itself. That is the case that was broken.
     */
    await page.evaluate(() => { location.hash = '#/c/archived-last-week'; });
    await page.waitForTimeout(2000);
    const inPage = await page.evaluate(() => ({
      title: document.querySelector('#title').textContent,
      err: document.querySelector('#err').textContent,
    }));
    check('a dead link pasted into an open page is repaired too',
      inPage.title === 'Main' && /not here any more/i.test(inPage.err), JSON.stringify(inPage));

    await page.goto(base + '#/c/archived-last-week', { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    const dead = await page.evaluate(() => ({
      title: document.querySelector('#title').textContent,
      err: document.querySelector('#err').textContent,
      msgs: document.querySelectorAll('#list .msg').length,
    }));
    check('*** an unknown conversation is not a blank page ***',
      dead.title === 'Main' && dead.msgs > 0, JSON.stringify(dead));
    check('it says so rather than switching silently', /not here any more/i.test(dead.err), dead.err);
    check('and the address is repaired', /#\/c\/main$/.test(page.url()), page.url());

    // Everything you touch must still be reachable after all that navigation.
    for (const [name, sel] of [['the message box', '#input'], ['the hamburger menu', '#menu'], ['Send', '#send']]) {
      const r = await page.evaluate(REACHABLE, sel);
      check(`${name} is still reachable after navigating`, r.ok, r.why);
    }
  }

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

  /*
   * The degradation path: push is not armed here, so an agent reply arriving
   * while the page is open must fall back to a buzz. This is the only signal
   * that exists today besides the hamburger dot.
   */
  const buzzed = await page.evaluate(() => window.__vibes.slice());
  check('an agent reply buzzes the phone when push is not armed', buzzed.length >= 1, JSON.stringify(buzzed));
  check('...with the two-light-taps "finished" pattern',
    buzzed.length >= 1 && JSON.stringify(buzzed[buzzed.length - 1]) === JSON.stringify([0, 50, 90, 50]),
    JSON.stringify(buzzed[buzzed.length - 1]));

  console.log('\nalerts can be set up with a thumb');
  {
    check('no permission was requested on load',
      (await page.evaluate(() => window.__permAsked)) === 0,
      String(await page.evaluate(() => window.__permAsked)));

    await page.click('#menu');
    await page.waitForTimeout(400);
    await page.click('#statusopen');
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const n = document.getElementById('notifybody');
      if (n) n.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(400);

    check('the alerts panel exists inside Status',
      (await page.evaluate(() => !!document.querySelector('#notifybody .scard'))) === true);
    check('it is NOT inside the block Status repaints every 5s',
      (await page.evaluate(() => !document.querySelector('#statusbody #notifybody'))) === true);

    for (const [name, sel] of [
      ['the arm button', '#notifybody .nbtn.primary'],
      ['the quiet-hours start time', '#nquietfrom'],
      ['the quiet-hours end time', '#nquietto'],
      ['the "broken" category box', '#ncat-broken'],
    ]) {
      const r = await page.evaluate(REACHABLE, sel);
      check(`${name} is on screen and not covered`, r.ok, r.why);
    }

    const tall = await page.evaluate(() => {
      const b = document.querySelector('#notifybody .nbtn.primary');
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    });
    check('the arm button is a thumb-sized target', tall >= 44, `${tall}px`);

    const state = await page.evaluate(() => {
      const n = document.querySelector('#notifybody .nstate');
      return n ? n.textContent : '';
    });
    check('it says plainly that this browser is not set up', state.indexOf('Not set up in this browser') >= 0, state);

    /*
     * He changes timezone this week. The panel must name the zone the quiet
     * window is measured in, and the clock in it — a window that silently runs
     * on the wrong zone is the watchdog bug wearing a different hat.
     */
    const tz = await page.evaluate(() => {
      const n = document.querySelector('#notifybody .ntz');
      return n ? n.textContent : '';
    });
    check('the timezone in force is named', tz.indexOf('Atlantic/Reykjavik') >= 0, tz);
    check('...with the local time beside it', tz.indexOf('21:14') >= 0, tz);
    check('...and when the window next changes', tz.indexOf('Quiet starts in') >= 0, tz);

    const boxes = await page.evaluate(() => ({
      done: document.getElementById('ncat-done').checked,
      broken: document.getElementById('ncat-broken').checked,
      from: document.getElementById('nquietfrom').value,
      to: document.getElementById('nquietto').value,
    }));
    check('the categories reflect the server', boxes.done === true && boxes.broken === false, JSON.stringify(boxes));
    check('the saved quiet hours are filled in', boxes.from === '23:00' && boxes.to === '07:30', JSON.stringify(boxes));

    // Tapping a pattern's label plays it, so the three can be learnt on the ground.
    await page.evaluate(() => { window.__vibes.length = 0; });
    await page.click('label[for="ncat-broken"]');
    await page.waitForTimeout(300);
    const pat = await page.evaluate(() => window.__vibes.slice());
    check('tapping a category plays its pattern', pat.length === 1, JSON.stringify(pat));
    check('...and "broken" is three long pulses',
      pat.length === 1 && JSON.stringify(pat[0]) === JSON.stringify([0, 300, 100, 300, 100, 300]),
      JSON.stringify(pat[0]));

    pushPosts.length = 0;
    await page.click('#ncat-broken');
    await page.waitForTimeout(500);
    check('toggling a category saves it', pushPosts.length === 1 && pushPosts[0].categories, JSON.stringify(pushPosts));

    check('still no permission prompt from any of that',
      (await page.evaluate(() => window.__permAsked)) === 0);

    // ...and only now, on a deliberate tap, is permission asked for.
    await page.click('#notifybody .nbtn.primary');
    await page.waitForTimeout(600);
    check('tapping the arm button DOES ask for permission',
      (await page.evaluate(() => window.__permAsked)) === 1,
      String(await page.evaluate(() => window.__permAsked)));
    const note = await page.evaluate(() => {
      const n = document.querySelector('#notifybody .snote');
      return n ? n.textContent : '';
    });
    check('a dismissed prompt explains what to do next', note.indexOf('Tap again') >= 0, note);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape closes Status again',
      (await page.evaluate(() => document.getElementById('statusview').hidden)) === true);
  }

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

  /*
   * ================================================================ offline
   *
   * The part that cannot be taken on trust. A manifest and a registered worker
   * prove nothing about whether he can read his messages on a plane, so this
   * installs the app for real, pulls the network out, reloads, and looks at
   * what is on the screen.
   *
   * It runs in its own context so that the service worker, its caches and the
   * offline switch cannot leak into the suites above or be polluted by them.
   */
  console.log('\noffline — the thread is readable with the network gone');
  const octx = await browser.newContext({ viewport: VIEWPORT, userAgent: UA });
  {
    const op = await octx.newPage();
    await op.goto(base, { waitUntil: 'load' });

    // Installed and in charge of the page, which is when it starts saving.
    const controlled = await op.evaluate(() => navigator.serviceWorker.ready
      .then(() => new Promise((r) => {
        if (navigator.serviceWorker.controller) return r(true);
        navigator.serviceWorker.addEventListener('controllerchange', () => r(true));
        setTimeout(() => r(!!navigator.serviceWorker.controller), 4000);
      })).catch(() => false));
    check('the worker installs and takes control of the page', controlled === true, String(controlled));

    // Give the cache-warming read that initOffline() fires time to land.
    await op.waitForTimeout(1500);

    const cached = await op.evaluate(() => caches.keys().then((names) => Promise.all(
      names.map((n) => caches.open(n).then((c) => c.keys().then((k) => [n, k.map((r) => r.url)])))
    )).catch(() => []));
    const flat = JSON.stringify(cached);
    check('the shell is saved', /relay-shell/.test(flat) && /"[^"]*\/"/.test(flat), flat.slice(0, 300));
    check('...and so is the thread, which is the point of all this',
      /relay-data/.test(flat) && /__relay-offline\/thread/.test(flat), flat.slice(0, 400));
    check('...under one key per conversation, not one per request',
      (flat.match(/__relay-offline\/thread/g) || []).length === 1, flat.slice(0, 400));
    check('the live stream is never cached', flat.indexOf('/events') === -1, flat.slice(0, 400));

    const onlineCount = await op.evaluate(() => document.querySelectorAll('#list .msg').length);
    check('the thread rendered while online', onlineCount > 100, String(onlineCount));

    // ---- and now the network goes away, for real ----
    await netDown(octx);
    await op.reload({ waitUntil: 'load' });
    /*
     * Long enough to clear the worker's DATA_TIMEOUT_MS, and that is the point.
     *
     * Playwright's offline emulation in Firefox reaches the page but not the
     * service worker: the worker's own fetch to a stopped server does not fail,
     * it hangs. That is annoying for the harness and lucky for the product,
     * because it means what gets tested here is the HARDER case — a connection
     * that never answers, the hotel-wifi and train-tunnel case — rather than a
     * clean refusal. A real phone in airplane mode never reaches this path at
     * all: navigator.onLine is false in the worker and the saved copy comes
     * back instantly. If the slow path works, the instant one does too.
     */
    await op.waitForTimeout(8000);

    const off = await op.evaluate(() => ({
      msgs: document.querySelectorAll('#list .msg').length,
      bar: document.getElementById('offbar').className,
      barText: document.getElementById('offbar').textContent,
      conn: document.getElementById('conn').textContent,
      connShown: document.getElementById('conn').className,
      sendOff: document.getElementById('send').disabled,
      placeholder: document.getElementById('input').placeholder,
      title: document.title,
    }));

    /*
     * On failure, say what was in the store and which conversation was on
     * screen. A bare "0" sends the next person hunting blind, and the two
     * things that have actually gone wrong here — nothing saved, or saved under
     * a key nobody asks for — are told apart by exactly this.
     */
    const why = off.msgs > 100 ? '' : JSON.stringify(await op.evaluate(() => caches.open('relay-data-v1')
      .then((c) => c.keys()).then((k) => k.map((r) => r.url)).catch((e) => String(e))));
    check('*** the history is on screen with no network at all ***', off.msgs > 100,
      String(off.msgs) + ' saved=' + why + ' hash=' + (await op.evaluate(() => location.hash)));
    check('...and it is the real page, not an error page', off.title === 'relay', off.title);
    check('the page says it is offline', /show/.test(off.connShown), off.connShown);
    check('...and says the messages are saved ones, not current',
      /saved/.test(off.conn), JSON.stringify(off.conn));
    check('the offline bar is up', /show/.test(off.bar), off.bar);
    check('...saying plainly that nothing can be sent',
      /nothing can be sent/i.test(off.barText), JSON.stringify(off.barText));
    check('...and that what he types is not lost',
      /stays in the box/i.test(off.barText), JSON.stringify(off.barText));
    check('the Send button is disabled', off.sendOff === true);
    check('...and the composer says why', /Offline/.test(off.placeholder), off.placeholder);

    /*
     * The worst outcome this feature could produce: a message that looks sent
     * and never arrives. Enter bypasses the disabled button, so it is the path
     * that has to be proven.
     */
    const before = posted.length;
    await op.fill('#input', 'this must not vanish');
    await op.press('#input', 'Enter');
    await op.waitForTimeout(600);
    const after = await op.evaluate(() => ({
      text: document.getElementById('input').value,
      err: document.getElementById('err').textContent,
      shown: document.getElementById('err').className,
    }));
    check('pressing Enter offline does not pretend to send', posted.length === before, String(posted.length - before));
    check('...the words are still in the box', after.text === 'this must not vanish', after.text);
    check('...and it says so, and stays said', /show/.test(after.shown) && /sticky/.test(after.shown), after.shown);
    check('...in words about being offline', /Offline/i.test(after.err), JSON.stringify(after.err));

    // ---- and comes back ----
    await netUp(octx);
    await op.evaluate(() => { document.getElementById('input').value = ''; });
    await op.reload({ waitUntil: 'load' });
    await op.waitForTimeout(2000);
    const back = await op.evaluate(() => ({
      bar: document.getElementById('offbar').className,
      sendOff: document.getElementById('send').disabled,
      conn: document.getElementById('conn').className,
    }));
    check('coming back online clears the offline bar', !/show/.test(back.bar), back.bar);
    check('...re-enables Send', back.sendOff === false);
    check('...and stops claiming to be offline', !/show/.test(back.conn), back.conn);

    await op.close();
  }

  /*
   * The failure mode that would strand him: a saved page outliving the deploy
   * that replaced it. The checkout is the deployment here, so this is the check
   * that earns the right to cache anything at all.
   */
  console.log('\noffline — a saved page can never outlive a deploy');
  {
    const up = await octx.newPage();
    await up.goto(base, { waitUntil: 'load' });
    await up.evaluate(() => navigator.serviceWorker.ready).catch(() => {});
    await up.waitForTimeout(1200);
    const first = await up.evaluate(() => document.querySelector('meta[name=build]').content);
    check('the installed app is on the first build', first === 'one', first);

    // Offline, it is allowed — expected, even — to show what it saved.
    await netDown(octx);
    await up.reload({ waitUntil: 'load' });
    await up.waitForTimeout(800);
    check('...which is what it shows when offline',
      (await up.evaluate(() => document.querySelector('meta[name=build]').content)) === 'one');

    // Now ship. This is exactly `git merge` on the live box.
    BUILD = 'two';
    await netUp(octx);
    await up.reload({ waitUntil: 'load' });
    await up.waitForTimeout(800);
    const second = await up.evaluate(() => document.querySelector('meta[name=build]').content);
    check('*** the moment the network is back, the new build wins ***', second === 'two', second);

    // And the saved copy must have been replaced too, or the next flight shows
    // a build he has already been shown is out of date.
    await netDown(octx);
    await up.reload({ waitUntil: 'load' });
    await up.waitForTimeout(800);
    const third = await up.evaluate(() => document.querySelector('meta[name=build]').content);
    check('...and what is saved for next time is the new one', third === 'two', third);

    await netUp(octx);
    await up.close();
  }

  /*
   * A cold install: a phone that has never seen the app, offline from the
   * start. It must not be a browser error page — he should be told there is
   * nothing saved yet, which is a different problem with a different fix.
   */
  console.log('\noffline — a phone with nothing saved says so');
  {
    const cold = await browser.newContext({ viewport: VIEWPORT, userAgent: UA });
    const cp = await cold.newPage();
    await cp.goto(base, { waitUntil: 'load' });
    await cp.evaluate(() => navigator.serviceWorker.ready).catch(() => {});
    await cp.waitForTimeout(1000);
    // Throw away everything the worker saved, then pull the plug: the same
    // state as an install that never completed.
    await cp.evaluate(() => caches.keys().then((n) => Promise.all(n.map((x) => caches.delete(x)))));
    await netDown(cold);
    await cp.reload({ waitUntil: 'load' }).catch(() => {});
    await cp.waitForTimeout(600);
    const body = await cp.evaluate(() => document.body.textContent).catch(() => '');
    check('it explains itself rather than showing a browser error',
      /Offline/i.test(body) && /saved/i.test(body), JSON.stringify(String(body).slice(0, 200)));
    await netUp(cold);
    await cold.close();
  }

  await octx.close();
  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('mobile-selftest harness error:', e); process.exit(1); });
