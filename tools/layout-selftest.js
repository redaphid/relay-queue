'use strict';
/*
 * layout-selftest — does the page still WORK at phone size?
 *
 *   node tools/layout-selftest.js
 *
 * This exists because of an outage. A banner and a correction bar were added to
 * the page, both correct in isolation and both passing every stub-DOM test —
 * and on the user's phone they pushed the composer and the hamburger off the
 * bottom of the screen. The page is the only way they can talk to us, so that
 * was a hard outage, and no test caught it: the old tests assert elements
 * EXIST, and the elements did exist. They were just not on screen.
 *
 * So this one measures. It renders the real page in headless Chrome at real
 * phone viewports, reads back getBoundingClientRect() for the things that must
 * never disappear, and fails if any of them leave the viewport.
 *
 * THE RULE IT ENFORCES: new bars are additive, never displacing. The composer
 * and the menu survive every state. If something cannot fit, the something
 * yields — never the input.
 *
 * Zero dependencies: Chrome is driven with --dump-dom and the measurements are
 * passed back inside the DOM itself.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

const VIEWPORTS = [
  { name: 'iPhone SE', w: 375, h: 667 },
  { name: 'small Android', w: 360, h: 640 },
  { name: 'iPhone 14', w: 390, h: 844 },
];

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

/*
 * Scenarios are strings of JS run against the finished page, so they exercise
 * exactly the DOM the real code produces — the banner is shown the same way
 * renderWatch() shows it.
 */
const SCENARIOS = {
  'nothing showing': '',

  'a long alarm banner': `
    var w = document.getElementById('watch');
    w.hidden = false;
    w.textContent = '3 messages claimed but never answered — the coordinator took one 4 hours ago and never came back. Nothing will pick it up again on its own.';
    var s = document.createElement('span');
    s.className = 'wsub';
    s.textContent = 'Nothing is watching this but you. It clears itself as soon as an agent acts.';
    w.appendChild(s);
  `,

  'banner + correction bar + error, all at once': `
    var w = document.getElementById('watch');
    w.hidden = false;
    w.textContent = '2 messages waiting for 12 min, and no agent has ever checked in.';
    var s = document.createElement('span'); s.className='wsub';
    s.textContent = 'Nothing is watching this but you. It clears itself as soon as an agent acts.';
    w.appendChild(s);
    var f = document.getElementById('fix');
    if (f) { f.hidden = false;
      document.getElementById('fixtext').textContent = 'Corrected “cloud” → Claude, “mind about” → mindmeld'; }
    var e = document.getElementById('err');
    e.className = 'show sticky';
    e.textContent = 'Recorded fine, but transcription failed — the speech engine may be down.';
  `,

  'everything, plus a full thread and a typed draft': `
    var w = document.getElementById('watch');
    w.hidden = false;
    w.textContent = '5 messages waiting for 41 min, and nothing has happened for 41 min.';
    var s = document.createElement('span'); s.className='wsub';
    s.textContent = 'Nothing is watching this but you. It clears itself as soon as an agent acts.';
    w.appendChild(s);
    var f = document.getElementById('fix');
    if (f) { f.hidden = false;
      document.getElementById('fixtext').textContent = 'Corrected “a Lexus” → Alexa'; }
    var list = document.getElementById('list');
    for (var i = 0; i < 25; i++) {
      var d = document.createElement('div');
      d.className = 'msg ' + (i % 2 ? 'agent' : 'user');
      var b = document.createElement('div'); b.className = 'body';
      b.textContent = 'Message ' + i + ' — ' + 'a fairly long line of text that wraps on a narrow screen. '.repeat(2);
      d.appendChild(b); list.appendChild(d);
    }
    document.getElementById('empty').style.display = 'none';
    var inp = document.getElementById('input');
    inp.value = 'a draft that is being typed right now and runs onto more than one line';
  `,
};

const MEASURE = `
  (function () {
    function box(id) {
      var el = document.getElementById(id);
      if (!el) return { missing: true };
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        left: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height),
        display: cs.display, visibility: cs.visibility,
      };
    }
    var out = {
      vw: window.innerWidth, vh: window.innerHeight,
      scrollW: document.documentElement.scrollWidth,
      composer: box('composer'), input: box('input'), send: box('send'),
      menu: box('menu'), mic: box('mic'), thread: box('thread'),
      watch: box('watch'), fix: box('fix'), header: box('header'),
    };
    var pre = document.createElement('pre');
    pre.id = 'LAYOUT_RESULT';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  })();
`;

function render(scenario, vp) {
  const html = fs.readFileSync(PAGE, 'utf8');
  // Network is unreachable from file://, and the page is built to survive that.
  // Stubbed anyway so a failing poll cannot race the measurement.
  const stub = `<script>
    window.fetch = function () { return new Promise(function () {}); };
    window.EventSource = function () { this.close = function () {}; };
  </script>`;
  const injected = html.replace('<script>', stub + '<script>')
    + `\n<script>${scenario}\n${MEASURE}</script>\n`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-layout-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, injected, 'utf8');
  try {
    const dom = execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--window-size=${vp.w},${vp.h}`,
      '--virtual-time-budget=1200',
      '--dump-dom', 'file:///' + file.replace(/\\/g, '/'),
    ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = dom.match(/<pre id="LAYOUT_RESULT">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error('the page did not report its layout (it may not have loaded)');
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }
}

function main() {
  if (!CHROME) {
    console.log('\nSKIPPED — no Chrome or Edge found to render with.\n');
    return;
  }
  console.log(`\nrendering with ${path.basename(CHROME)}`);

  for (const vp of VIEWPORTS) {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      console.log(`\n${vp.name} ${vp.w}x${vp.h} — ${name}`);
      let r;
      try { r = render(scenario, vp); } catch (err) {
        failures++; console.log(`  FAIL could not render — ${err.message}`); continue;
      }

      // THE TWO THINGS THAT MUST SURVIVE EVERY STATE.
      check('the composer is on screen',
        !r.composer.missing && r.composer.bottom <= r.vh + 1 && r.composer.top < r.vh,
        `composer top=${r.composer.top} bottom=${r.composer.bottom} viewport=${r.vh}`);
      check('the text input is on screen and usable',
        !r.input.missing && r.input.bottom <= r.vh + 1 && r.input.h >= 40,
        `input top=${r.input.top} bottom=${r.input.bottom} h=${r.input.h} viewport=${r.vh}`);
      check('the hamburger menu is on screen',
        !r.menu.missing && r.menu.bottom <= r.vh && r.menu.top >= 0 && r.menu.h > 0,
        `menu top=${r.menu.top} bottom=${r.menu.bottom}`);
      check('Send is reachable',
        !r.send.missing && r.send.bottom <= r.vh + 1 && r.send.right <= r.vw + 1,
        `send bottom=${r.send.bottom} right=${r.send.right} viewport=${r.vw}x${r.vh}`);
      check('the mic is reachable',
        !r.mic.missing && r.mic.bottom <= r.vh + 1,
        `mic bottom=${r.mic.bottom}`);

      // The thread yields instead — that is the whole point of "additive".
      check('the thread still has room to show something',
        !r.thread.missing && r.thread.h >= 60, `thread h=${r.thread.h}`);
      check('no horizontal scroll', r.scrollW <= r.vw + 1, `scrollWidth=${r.scrollW} viewport=${r.vw}`);
      check('nothing is wider than the screen',
        r.composer.right <= r.vw + 1 && (r.watch.missing || r.watch.right <= r.vw + 1),
        `composer right=${r.composer.right} watch right=${r.watch.right}`);
    }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main();
