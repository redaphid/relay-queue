'use strict';
/*
 * gallery-ui-selftest — load the real page in a real browser and prove that a
 * picture actually appears on the screen he is holding.
 *
 *   npm i --no-save playwright && npx playwright install firefox   # once, ad hoc
 *   node tools/gallery-ui-selftest.js
 *
 * WHY A BROWSER, WHEN gallery-selftest.js ALREADY PROVES THE BYTES ARE SERVED.
 *
 * Because "the server returns the image" and "he can see the image" are
 * different claims, and this project has been caught by that gap before — the
 * stub-DOM suite passed 173 checks while the composer sat off the bottom of the
 * screen. An <img> element that exists but never loaded looks exactly like one
 * that did, to everything except a browser. So the assertions here insist on
 * `naturalWidth > 0`: the bytes were fetched, decoded, and painted.
 *
 * The regression this exists to hold down: the page's inline parser consumed a
 * run of plain text up to the next character that could begin a span, and `!`
 * was not one of them. A picture at the START of a message rendered; the same
 * picture mid-sentence silently became a LINK. Both cases are below, because
 * only one of them was ever broken and it was the common one.
 *
 * Zero runtime dependencies, like everything else; playwright is opt-in and
 * must never enter package.json.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ICONS = require('../icons.js');
const { listenEphemeral } = require('./harness-lib');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const PORT = Number(process.env.PORT || 0);
const VIEWPORT = { width: 390, height: 844 };
const UA = 'Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0';

let firefox;
try {
  ({ firefox } = require('playwright'));
} catch (e) {
  console.error('gallery-ui-selftest needs playwright, which this project does not depend on.');
  console.error('Install it just for this run:\n  npm i --no-save playwright && npx playwright install firefox');
  process.exit(2);
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failed++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

/* ---- real pictures, drawn by the app's own encoder ---- */
function png(w, h, seed) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 11 + seed) & 0xff;
    rgba[i * 4 + 1] = (i * 5 + seed) & 0xff;
    rgba[i * 4 + 2] = (i * 23 + seed) & 0xff;
    rgba[i * 4 + 3] = 0xff;
  }
  return ICONS.encodePng(w, h, rgba);
}
const BYTES = {};
function put(buf) {
  const id = crypto.createHash('sha256').update(buf).digest('hex');
  BYTES[id] = buf;
  return id;
}
// A sprite, a second sprite, and a wide contact sheet — the three shapes the
// layout has to survive.
const SPRITE_A = put(png(16, 16, 1));
const SPRITE_B = put(png(16, 16, 7));
const SHEET = put(png(96, 24, 3));

const ref = (id, w, h, alt) => ({ id, url: '/images/' + id, type: 'image/png', width: w, height: h, alt });

const now = Date.now();
const at = (n) => new Date(now - n * 60000).toISOString();
const ENTRIES = [
  {
    id: 'plain', role: 'user', status: 'done', ts: at(9), rev: at(9), conversationId: 'main',
    text: 'make me some crates',
  },
  {
    id: 'attached', role: 'agent', status: 'done', ts: at(8), rev: at(8), conversationId: 'main',
    text: 'Two candidates.',
    images: [ref(SPRITE_A, 16, 16, 'crate one'), ref(SPRITE_B, 16, 16, 'crate two')],
  },
  {
    id: 'single', role: 'agent', status: 'done', ts: at(7), rev: at(7), conversationId: 'main',
    text: 'And the contact sheet.',
    images: [ref(SHEET, 96, 24, 'contact sheet')],
  },
  {
    /*
     * THE REGRESSION CASE. The picture is mid-sentence, with prose in front of
     * it, which is the arrangement that used to lose it to the link rule.
     */
    id: 'inline', role: 'agent', status: 'done', ts: at(6), rev: at(6), conversationId: 'main',
    text: 'Here is the one I would ship ![the good crate](/images/' + SPRITE_A + ') and it tiles cleanly.',
  },
  {
    id: 'atstart', role: 'agent', status: 'done', ts: at(5), rev: at(5), conversationId: 'main',
    text: '![leading picture](/images/' + SPRITE_B + ')',
  },
  {
    /*
     * Not ours, so not an <img>. The page's CSP is img-src 'self', so rendering
     * this would produce a broken box indistinguishable from a bug in the page.
     */
    id: 'external', role: 'agent', status: 'done', ts: at(4), rev: at(4), conversationId: 'main',
    text: 'From the web: ![nope](https://example.com/x.png) and ![also nope](/images/not-a-hash).',
  },
];

const conv = (id, title, agent) => ({
  id, title, agent, createdAt: at(600), lastTs: at(4),
  lastText: 'something was said', lastRole: 'agent',
  counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
  spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sparkBucketMs: 900000,
  agentState: { state: 'watching', agoSec: 4, actedAgoSec: 4 },
});

const GALLERY = {
  count: 3, total: 3, conversationId: 'main',
  images: [
    { ...ref(SHEET, 96, 24, 'contact sheet'), conversationId: 'main', ts: at(7), bytes: BYTES[SHEET].length },
    { ...ref(SPRITE_B, 16, 16, 'crate two'), conversationId: 'main', ts: at(8), bytes: BYTES[SPRITE_B].length },
    { ...ref(SPRITE_A, 16, 16, 'crate one'), conversationId: 'main', ts: at(8), bytes: BYTES[SPRITE_A].length },
  ],
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(o));
  };
  if (u.pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'x-relay-app': '1', 'cache-control': 'no-store',
    });
    return res.end(fs.readFileSync(PAGE, 'utf8'));
  }
  const mImg = /^\/images\/([a-f0-9]{64})$/.exec(u.pathname);
  if (mImg && BYTES[mImg[1]]) {
    const buf = BYTES[mImg[1]];
    res.writeHead(200, {
      'content-type': 'image/png', 'content-length': buf.length,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    });
    return res.end(buf);
  }
  if (u.pathname === '/images') return json(GALLERY);
  if (u.pathname === '/thread') return json({ entries: ENTRIES });
  if (u.pathname === '/conversations') {
    return json({ defaultId: 'main', conversations: [conv('main', 'Main', 'Zora')] });
  }
  if (u.pathname === '/status') return json({ headline: { text: 'ok' }, counts: {} });
  if (u.pathname === '/push/config') return json({ enabled: false, devices: [], categories: {} });
  if (u.pathname === '/client-log') { res.writeHead(200); return res.end('{}'); }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return res.write('retry: 3000\n\n');
  }
  // /sw.js deliberately 404s: the offline worker is not what is under test, and
  // a cache that survives between runs would make these results meaningless.
  res.writeHead(404); res.end();
});

(async () => {
  const boundPort = await listenEphemeral(server, '127.0.0.1', PORT);
  const base = `http://127.0.0.1:${boundPort}`;
  console.log(`gallery-ui-selftest — real Firefox at ${VIEWPORT.width}x${VIEWPORT.height}, page from ${base}\n`);

  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, userAgent: UA });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  try {
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForSelector('#list .msg', { timeout: 15000 });
    // Give the lazy loader a moment; the assertions below need bytes, not tags.
    await page.waitForFunction(
      () => document.querySelectorAll('#list img.relimg').length >= 5, null, { timeout: 15000 },
    );

    console.log('the picture is on the screen, not merely in the DOM');
    const shots = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#list img.relimg')).map((i) => ({
        src: new URL(i.currentSrc || i.src, location.href).pathname,
        natural: i.naturalWidth,
        alt: i.alt,
        wide: i.getBoundingClientRect().width,
        msgId: (function (n) { while (n && !n.classList.contains('msg')) n = n.parentNode; return n ? 1 : 0; })(i),
      }));
    });
    check('every picture in the thread actually loaded its bytes',
      shots.length >= 5 && shots.every((s) => s.natural > 0),
      JSON.stringify(shots.map((s) => s.natural)));
    check('...and each carries its alt text, for when they do not',
      shots.every((s) => s.alt && s.alt !== 'image'), JSON.stringify(shots.map((s) => s.alt)));
    check('...and none is wider than the phone', shots.every((s) => s.wide <= VIEWPORT.width),
      JSON.stringify(shots.map((s) => Math.round(s.wide))));

    console.log('\nmarkdown — the regression that made a picture into a link');
    const inlineImgs = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('#list .msg'))
        .find((m) => /I would ship/.test(m.textContent || ''));
      if (!wrap) return null;
      return {
        imgs: wrap.querySelectorAll('img.relimg').length,
        links: wrap.querySelectorAll('a').length,
        text: (wrap.querySelector('.body') || {}).textContent || '',
      };
    });
    check('a picture MID-SENTENCE renders as an image', inlineImgs && inlineImgs.imgs === 1,
      JSON.stringify(inlineImgs));
    check('*** ...and not as a link, which is what used to happen ***',
      inlineImgs && inlineImgs.links === 0, JSON.stringify(inlineImgs));
    check('...with the prose in front of it intact and no stray "!"',
      inlineImgs && /Here is the one I would ship/.test(inlineImgs.text) && !/!\[/.test(inlineImgs.text),
      inlineImgs && inlineImgs.text);
    check('...and the words after it kept too',
      inlineImgs && /and it tiles cleanly/.test(inlineImgs.text));

    const leading = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('#list .msg'))
        .find((m) => (m.querySelector('img[alt="leading picture"]')));
      return wrap ? wrap.querySelectorAll('img.relimg').length : 0;
    });
    check('a picture at the very start of a message still renders', leading === 1, String(leading));

    const ext = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('#list .msg'))
        .find((m) => /From the web/.test(m.textContent || ''));
      if (!wrap) return null;
      return { imgs: wrap.querySelectorAll('img').length, html: wrap.textContent };
    });
    check('*** an off-site image is NOT turned into an <img> ***', ext && ext.imgs === 0,
      JSON.stringify(ext));
    check('...nor is a malformed /images/ path', ext && ext.imgs === 0);

    console.log('\nattachments hang under their message');
    const strip = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('#list .msg'))
        .find((m) => /Two candidates/.test(m.textContent || ''));
      if (!wrap) return null;
      const box = wrap.querySelector('.shots');
      return box ? { cls: box.className, n: box.querySelectorAll('img').length } : null;
    });
    check('two attached pictures make a two-up grid', strip && strip.n === 2 && /many/.test(strip.cls),
      JSON.stringify(strip));
    const one = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('#list .msg'))
        .find((m) => /contact sheet/.test(m.textContent || ''));
      const box = wrap && wrap.querySelector('.shots');
      return box ? { cls: box.className, n: box.querySelectorAll('img').length } : null;
    });
    check('one attached picture gets the full width', one && one.n === 1 && /one/.test(one.cls),
      JSON.stringify(one));

    console.log('\nfull size — the judgement he is actually trying to make');
    await page.click('#list img.relimg');
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 5000 });
    const lb = await page.evaluate(() => {
      const img = document.getElementById('lbimg');
      const box = img.getBoundingClientRect();
      return {
        visible: !document.getElementById('lightbox').hidden,
        natural: img.naturalWidth,
        onScreen: box.width > 0 && box.height > 0 && box.top >= 0,
        raw: (document.getElementById('lbraw') || {}).getAttribute
          ? document.getElementById('lbraw').getAttribute('href') : null,
      };
    });
    check('tapping a picture opens it full size', lb.visible && lb.onScreen, JSON.stringify(lb));
    check('...and the full-size copy loaded', lb.natural > 0, String(lb.natural));
    check('...with a link straight to the raw bytes as an escape hatch',
      /^\/images\/[a-f0-9]{64}$/.test(lb.raw || ''), lb.raw);

    await page.click('#lbzoom');
    const actual = await page.evaluate(() => {
      const wrap = document.getElementById('lbwrap');
      const img = document.getElementById('lbimg');
      return {
        on: wrap.classList.contains('actual'),
        rendering: getComputedStyle(img).imageRendering,
        label: document.getElementById('lbzoom').textContent,
      };
    });
    check('*** actual-size mode turns smoothing OFF, so a sprite can be judged ***',
      actual.on && /pixelated|crisp-edges/.test(actual.rendering), JSON.stringify(actual));
    check('...and the control now offers the way back', /fit/i.test(actual.label), actual.label);

    console.log('\nthe gallery, and the back button that has to survive two layers');
    await page.click('#lbclose');
    await page.waitForFunction(() => document.getElementById('lightbox').hidden, null, { timeout: 5000 });
    await page.click('#menu');
    await page.click('#galopen');
    await page.waitForSelector('#galview:not([hidden])', { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#galgrid img').length >= 3, null, { timeout: 10000 },
    );
    const grid = await page.evaluate(() => Array.from(document.querySelectorAll('#galgrid img'))
      .map((i) => ({ natural: i.naturalWidth, alt: i.alt })));
    check('the gallery lists every picture in the conversation', grid.length === 3, String(grid.length));
    check('...and every tile loaded', grid.every((g) => g.natural > 0), JSON.stringify(grid));

    await page.click('#galgrid img');
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 5000 });
    check('a gallery tile opens full size too', true);

    /*
     * THE INVARIANT. The lightbox is the first overlay that can sit on top of
     * another, and the page keeps ONE history entry for "something is open".
     * Back must therefore peel one layer at a time — if it spent the single
     * entry on the lightbox and left the gallery open, the next back would take
     * him out of the app entirely with a gallery still on screen.
     */
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('lightbox').hidden, null, { timeout: 5000 });
    const between = await page.evaluate(() => ({
      light: document.getElementById('lightbox').hidden,
      gal: document.getElementById('galview').hidden,
    }));
    check('*** back closes the full-size view and LEAVES the gallery open ***',
      between.light === true && between.gal === false, JSON.stringify(between));

    await page.goBack();
    await page.waitForFunction(() => document.getElementById('galview').hidden, null, { timeout: 5000 });
    const after = await page.evaluate(() => ({
      gal: document.getElementById('galview').hidden,
      thread: !!document.querySelector('#list .msg'),
    }));
    check('...and a second back closes the gallery, returning to the thread',
      after.gal === true && after.thread, JSON.stringify(after));

    console.log('\nthe phone constraints the whole app lives under');
    const geom = await page.evaluate(() => ({
      docWide: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      listWide: document.getElementById('list').scrollWidth,
      composer: (function () {
        const r = document.getElementById('input').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height };
      })(),
    }));
    check('*** the page never scrolls sideways, pictures and all ***',
      geom.docWide <= geom.inner + 1, `${geom.docWide} vs ${geom.inner}`);
    check('...and neither does the thread', geom.listWide <= geom.inner + 1,
      `${geom.listWide} vs ${geom.inner}`);
    check('the composer is still reachable',
      geom.composer.bottom <= VIEWPORT.height + 1 && geom.composer.h >= 20,
      JSON.stringify(geom.composer));

    check('nothing threw while all of that happened', pageErrors.length === 0,
      pageErrors.join(' | '));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('gallery-ui-selftest harness error:', e); process.exit(1); });
