'use strict';
/*
 * ui-selftest — run the page's inline JS against a stub DOM and assert the things
 * that cannot be checked by eye, without a browser or a microphone.
 *
 *   node tools/ui-selftest.js
 *
 * This exists because of a real bug: on a phone the mic button did nothing and
 * said nothing, because browsers withhold getUserMedia from non-https pages. The
 * failure is now explicit, and these tests are what keep it that way.
 *
 * Zero dependencies, like everything else here. Node built-ins only.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');

function inlineScript() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/);
  if (!m) throw new Error('no inline <script> found in public/index.html');
  return m[1];
}

// ---------------------------------------------------------------- stub DOM
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', textContent: '', title: '', value: '', placeholder: '',
    disabled: false, isContentEditable: false, focused: false,
    style: {}, attrs: {}, children: [], handlers: {},
    scrollHeight: 200, scrollTop: 0, clientHeight: 200,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    dispatch(ev, arg) { (this.handlers[ev] || []).forEach((f) => f.call(this, arg || {})); },
  };
  return el;
}

function makeEnv(opts) {
  const ids = ['thread', 'list', 'empty', 'input', 'send', 'err', 'conn', 'mic', 'voice', 'vtext'];
  const els = {};
  ids.forEach((id) => { els[id] = makeEl(id === 'input' ? 'textarea' : 'div'); });
  const meter = makeEl('i');
  const posted = [];

  const doc = {
    activeElement: null,
    hidden: false,
    handlers: {},
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '#meter i' ? meter : null),
    createElement: makeEl,
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    dispatch(ev) { (this.handlers[ev] || []).forEach((f) => f.call(this, {})); },
  };
  els.input.focus = function () { doc.activeElement = this; this.focused = true; };

  const sandbox = {
    console,
    // Real delays: the page's own 3 s poll timer must NOT fire during a test, or
    // it re-enters the poll loop forever and nothing ever settles.
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval,
    Promise, JSON, Math, Date, String, Number, Array, Object, Error, isNaN, parseInt,
    Float32Array, DataView, ArrayBuffer, Uint8Array,
    document: doc,
    navigator: {
      userAgent: opts.ua || 'stub/1.0',
      mediaDevices: opts.mediaDevices, // undefined models an insecure/unsupported origin
    },
    location: {
      protocol: opts.protocol || 'http:',
      host: opts.host || '10.0.136.62:3901',
      origin: (opts.protocol || 'http:') + '//' + (opts.host || '10.0.136.62:3901'),
      href: (opts.protocol || 'http:') + '//' + (opts.host || '10.0.136.62:3901') + '/',
    },
    fetch: (url, init) => {
      posted.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ entries: [], count: 0 }) });
    },
    isSecureContext: !!opts.secure,
    innerHeight: 800,
    matchMedia: (q) => ({ matches: /pointer: fine/.test(q) ? !!opts.finePointer : false }),
    getSelection: () => ({ toString: () => opts.selection || '' }),
    addEventListener(ev, fn) { (this._h = this._h || {})[ev] = ((this._h || {})[ev] || []).concat(fn); },
    dispatchWindow(ev) { (((this._h || {})[ev]) || []).forEach((f) => f.call(this, {})); },
  };
  if (opts.AudioContext) sandbox.AudioContext = opts.AudioContext;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(inlineScript(), sandbox, { filename: 'index.html<script>' });
  return { sandbox, els, meter, posted, doc };
}

// ---------------------------------------------------------------- assertions
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const settle = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  console.log('\ninsecure origin (a phone on http:// — the reported bug)');
  {
    const { els, posted } = makeEnv({ secure: false, mediaDevices: undefined, finePointer: false });
    check('mic button is struck through, not hidden', els.mic.className === 'off', `className=${JSON.stringify(els.mic.className)}`);
    check('mic button is NOT disabled (the tap is what explains)', els.mic.disabled === false);
    check('mic has an explanatory tooltip', /https/i.test(els.mic.title || ''), els.mic.title);
    check('mic has an explanatory aria-label', /https/i.test(els.mic.getAttribute('aria-label') || ''));
    check('blocked state is reported to the server on load',
      posted.some((p) => p.url === '/client-log' && p.body && p.body.event === 'mic-blocked-on-load'));

    els.mic.dispatch('click');
    await settle();
    check('tapping shows an error', /show/.test(els.err.className), els.err.className);
    check('the error is sticky, not a 9s flash', /sticky/.test(els.err.className), els.err.className);
    check('it names https as the cause', /https/i.test(els.err.textContent), els.err.textContent);
    check('it gives a URL that works today', /localhost:3901/.test(els.err.textContent));
    check('it says the mic itself is fine', /nothing is wrong/i.test(els.err.textContent));
    check('the tap is reported to the server',
      posted.some((p) => p.url === '/client-log' && p.body && p.body.event === 'mic-blocked'));
    check('error bar can be dismissed by tapping', (function () {
      els.err.dispatch('click');
      return els.err.className === '';
    })());
  }

  console.log('\nsecure origin, but the browser has no audio APIs');
  {
    const { els } = makeEnv({ secure: true, protocol: 'https:', host: 'relay.example.com', mediaDevices: undefined });
    els.mic.dispatch('click');
    await settle();
    check('reports "unsupported", not the https story', /unsupported/i.test(els.err.textContent), els.err.textContent);
    check('does not wrongly blame http', !/https:\/\/ pages/.test(els.err.textContent));
  }

  console.log('\nsecure origin with a working mic');
  {
    const { els } = makeEnv({
      secure: true, protocol: 'https:', host: 'relay.example.com', finePointer: true,
      mediaDevices: { getUserMedia: () => new Promise(() => {}) }, // hangs: we only check it got that far
      AudioContext: function () { this.sampleRate = 16000; },
    });
    check('mic is not marked blocked', els.mic.className !== 'off', els.mic.className);
    els.mic.dispatch('click');
    await settle();
    check('no error is shown', els.err.className === '', els.err.textContent);
    check('it actually tried to start', els.mic.disabled === true);
  }

  console.log('\nauto-focus gating');
  {
    const fine = makeEnv({ secure: true, finePointer: true, mediaDevices: undefined });
    check('desktop (fine pointer) focuses the composer on load', fine.els.input.focused === true);
    fine.els.input.focused = false;
    fine.sandbox.dispatchWindow('focus');
    check('desktop refocuses when the window regains focus', fine.els.input.focused === true);

    const touch = makeEnv({ secure: true, finePointer: false, mediaDevices: undefined });
    check('phone (coarse pointer) does NOT focus — no keyboard ambush', touch.els.input.focused === false);
    touch.sandbox.dispatchWindow('focus');
    check('phone still does not focus on window focus', touch.els.input.focused === false);

    const sel = makeEnv({ secure: true, finePointer: true, mediaDevices: undefined, selection: 'copied text' });
    check('does not steal focus while text is selected', sel.els.input.focused === false);
  }

  console.log('\nthe messaging app survives a broken audio stack');
  {
    // getElementById('mic') returns null: the voice code must not take the page down.
    const html = inlineScript();
    check('voice init is wrapped so it cannot break boot', /try\s*\{\s*initVoice\(\);/.test(html));
    check('boot runs before voice is wired', html.indexOf('poll(true)') < html.indexOf('initVoice();'));
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  // Each stub page left its poll timer armed; exit rather than wait them out.
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
