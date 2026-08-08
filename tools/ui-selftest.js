'use strict';
/*
 * ui-selftest — run the page's inline JS against a stub DOM and assert the things
 * that cannot be checked by eye, without a browser, a microphone or a speaker.
 *
 *   node tools/ui-selftest.js
 *
 * This exists because of a real bug: on a phone the mic button did nothing and
 * said nothing, because browsers withhold getUserMedia from non-https pages. The
 * failure is now explicit, and these tests are what keep it that way.
 *
 * It has since grown a second job, which is now the more important one: proving
 * that **conversation mode cannot hear itself**. With the mic live and a reply
 * playing, a page that transcribes its own voice will post it, get another
 * reply, speak that, and loop forever into a real queue that agents act on.
 * A microphone and a speaker cannot be driven headlessly — but the state machine
 * between them can, so the gate is tested here frame by frame.
 *
 * Zero dependencies, like everything else here. Node built-ins only.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const FRAME = 512;    // must match V.FRAME in the page
const FRAME_MS = 32;  // 512 samples at 16 kHz

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
    className: '', title: '', value: '', placeholder: '',
    disabled: false, isContentEditable: false, focused: false,
    style: {}, attrs: {}, children: [], handlers: {},
    scrollHeight: 200, scrollTop: 0, clientHeight: 200,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    // A real DOM *moves* a fragment's children in rather than nesting it, and
    // the page relies on that: `list.children` must be the rendered rows.
    appendChild(c) {
      if (c && c.tagName === 'FRAGMENT') {
        for (const kid of c.children) this.children.push(kid);
        c.children = [];
        return c;
      }
      this.children.push(c);
      return c;
    },
    querySelectorAll() { return []; },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    dispatch(ev, arg) { (this.handlers[ev] || []).forEach((f) => f.call(this, arg || {})); },
  };
  // In a real DOM, assigning textContent REPLACES every child. `list.textContent
  // = ''` is exactly how both renderers here clear themselves, so a plain
  // property would let rows silently accumulate and hide re-render bugs.
  let text = '';
  Object.defineProperty(el, 'textContent', {
    enumerable: true,
    configurable: true,
    get() { return text; },
    set(v) { text = v === null || v === undefined ? '' : String(v); el.children = []; },
  });
  return el;
}

// ---------------------------------------------------------------- stub audio
/*
 * Enough of the Web Audio, MediaStream and EventSource APIs for the page's own
 * code to run unmodified. The point is that the page is NOT special-cased for
 * the test: it opens a capture graph, receives frames on a worklet port, gates a
 * MediaStreamTrack and plays an AudioBufferSourceNode exactly as it would in a
 * browser — the test just supplies the frames and decides when playback ends.
 */
function makeAudio(store) {
  function Ctx(opts) {
    this.sampleRate = (opts && opts.sampleRate) || 16000;
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: () => Promise.resolve() };
    store.ctxs.push(this);
  }
  Ctx.prototype.createGain = function () { return { gain: {}, connect() {}, disconnect() {} }; };
  Ctx.prototype.createMediaStreamSource = function () { return { connect() {}, disconnect() {} }; };
  Ctx.prototype.createBuffer = function () { return { duration: 0 }; };
  Ctx.prototype.createBufferSource = function () {
    const src = {
      buffer: null, onended: null,
      connect() {}, disconnect() {},
      start() { store.started.push(src); },
      stop() { if (src.onended) src.onended(); },
    };
    return src;
  };
  Ctx.prototype.decodeAudioData = function () { return Promise.resolve({ duration: 1.5 }); };
  Ctx.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
  Ctx.prototype.suspend = function () { this.state = 'suspended'; return Promise.resolve(); };
  Ctx.prototype.close = function () { this.state = 'closed'; };

  function Node() { this.port = { onmessage: null }; store.nodes.push(this); }
  Node.prototype.connect = function () {};
  Node.prototype.disconnect = function () {};

  return { Ctx, Node };
}

function workingMic(store) {
  return {
    getUserMedia() {
      if (store.micError) return Promise.reject(store.micError);
      const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
      store.tracks.push(track);
      return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
    },
  };
}

function makeEnv(opts) {
  const ids = ['thread', 'list', 'empty', 'input', 'send', 'err', 'conn', 'mic', 'voice', 'vtext',
    'convo', 'spk', 'vstop', 'menu', 'menudot', 'title', 'drawer', 'scrim', 'drawerclose',
    'newtitle', 'newconv', 'converr', 'convlist'];
  const els = {};
  ids.forEach((id) => { els[id] = makeEl(id === 'input' || id === 'newtitle' ? 'textarea' : 'div'); });
  els.drawer.hidden = true;
  const meter = makeEl('i');
  const posted = [];
  const conv = (id, title, extra) => Object.assign({
    id, title, agent: null, createdAt: '2026-01-01T00:00:00.000Z', archived: false, archivedAt: null,
    counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
    messages: 0, lastTs: '2026-01-01T00:00:00.000Z', lastRole: 'user', lastText: '',
  }, extra || {});
  const store = {
    ctxs: [], nodes: [], tracks: [], started: [], es: null,
    sttText: 'check the widget report', ttsFail: false, micError: null,
    convs: [conv('main', 'Main', { lastText: 'the first thread' }),
      conv('c2', 'Widget audit', { lastText: 'how many widgets', counts: { pending: 2, claimed: 0, done: 0, unrelayed: 0 } })],
  };
  const audio = makeAudio(store);

  const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  const doc = {
    activeElement: null,
    hidden: false,
    handlers: {},
    documentElement: { style: rootStyle },
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '#meter i' ? meter : null),
    createElement: makeEl,
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    dispatch(ev) { (this.handlers[ev] || []).forEach((f) => f.call(this, {})); },
  };
  els.input.focus = function () { doc.activeElement = this; this.focused = true; };

  const jsonRes = (obj, status) => Promise.resolve({
    ok: (status || 200) < 400, status: status || 200,
    json: () => Promise.resolve(obj),
    headers: { get: () => null },
  });

  // `stored` models a device that has been used before: the remembered
  // conversation, the speaker setting, and so on.
  const mem = Object.assign({}, opts.stored || {});
  const sandbox = {
    console,
    // Real delays: the page's own 3 s poll timer must NOT fire during a test, or
    // it re-enters the poll loop forever and nothing ever settles.
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval,
    Promise, JSON, Math, Date, String, Number, Array, Object, Error, isNaN, parseInt,
    RegExp, Boolean,
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
      // The conversation lives here. Starts wherever the test says it does, so
      // "opened from a shared link" is expressible.
      hash: opts.hash || '',
    },
    /*
     * Enough History API to tell a deliberate switch (pushState, so Back
     * returns to it) from a repair (replaceState, so Back does not walk into a
     * conversation that does not exist). `entries` is what the tests assert on.
     */
    history: {
      entries: [],
      pushState(_s, _t, url) { this.entries.push({ how: 'push', url }); sandbox.location.hash = url; },
      replaceState(_s, _t, url) { this.entries.push({ how: 'replace', url }); sandbox.location.hash = url; },
    },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
    },
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    fetch: (url, init) => {
      const raw = init && init.body;
      let body = null;
      if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch (e) { body = raw; } }
      posted.push({ url, body, bytes: raw && raw.byteLength });
      if (url === '/stt') return jsonRes({ text: store.sttText, audioMs: 900, tookMs: 120 });
      if (url === '/tts') {
        if (store.ttsFail) return jsonRes({ error: 'the text-to-speech engine is down' }, 502);
        return Promise.resolve({
          ok: true, status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(2048)),
          headers: { get: () => null },
        });
      }
      if (url === '/tasks') return jsonRes({ id: 'new-task' }, 201);
      if (url === '/conversations') {
        if (init && init.method === 'POST') {
          const made = conv('c-new', (body && body.title) || 'untitled', { lastText: '' });
          store.convs.push(made);
          return jsonRes(made, 201);
        }
        return jsonRes({ count: store.convs.length, defaultId: 'main', conversations: store.convs });
      }
      return jsonRes({ entries: [], count: 0 });
    },
    isSecureContext: !!opts.secure,
    innerHeight: 800,
    matchMedia: (q) => ({ matches: /pointer: fine/.test(q) ? !!opts.finePointer : false }),
    getSelection: () => ({ toString: () => opts.selection || '' }),
    addEventListener(ev, fn) { (this._h = this._h || {})[ev] = ((this._h || {})[ev] || []).concat(fn); },
    dispatchWindow(ev) { (((this._h || {})[ev]) || []).forEach((f) => f.call(this, {})); },
  };
  if (opts.audio !== false) {
    sandbox.AudioContext = audio.Ctx;
    sandbox.AudioWorkletNode = audio.Node;
  }
  if (opts.AudioContext) sandbox.AudioContext = opts.AudioContext;
  if (opts.stream !== false) {
    sandbox.EventSource = function EventSource(url) { this.url = url; store.es = this; };
    sandbox.EventSource.prototype.close = function () {};
  }
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(inlineScript(), sandbox, { filename: 'index.html<script>' });

  // ---- driving helpers -------------------------------------------------
  /** Push `ms` of audio into the live worklet port. `loud` fakes speech. */
  function feed(ms, loud) {
    const node = store.nodes[store.nodes.length - 1];
    if (!node || !node.port.onmessage) throw new Error('no capture node is listening');
    const n = Math.ceil(ms / FRAME_MS);
    for (let i = 0; i < n; i++) {
      const b = new Float32Array(FRAME);
      if (loud) for (let j = 0; j < FRAME; j++) b[j] = j % 2 ? 0.3 : -0.3;
      node.port.onmessage({ data: b });
    }
  }
  /*
   * Calibrate, then say something, then go quiet long enough to end the
   * utterance. The trailing silence must clear V.CONV_SILENCE_MS (3 s) — the
   * window is deliberately long, because 1.2 s cut real speakers off mid-thought.
   */
  function sayOneThing() {
    feed(450, false);  // room level
    feed(600, true);   // speech
    feed(3200, false); // trailing silence past CONV_SILENCE_MS
  }
  /** One more utterance on an already-calibrated session. */
  function sayAgain() {
    feed(600, true);
    feed(3200, false);
  }
  /** Fire the agent-reply push the page would get over SSE. */
  function agentReply(text, id) {
    const ts = new Date().toISOString();
    if (!store.es || !store.es.onmessage) throw new Error('no SSE stream is open');
    store.es.onmessage({
      data: JSON.stringify({
        entries: [{ id: id || 'reply-1', role: 'agent', text, ts, rev: ts, status: 'done', replyTo: 'x' }],
      }),
    });
  }
  /** End the reply that is currently playing. */
  function endPlayback() {
    for (let i = store.started.length - 1; i >= 0; i--) {
      if (store.started[i].onended) { store.started[i].onended(); return true; }
    }
    return false;
  }
  const track = () => store.tracks[store.tracks.length - 1];
  const sent = () => posted.filter((p) => p.url === '/tasks');
  const stt = () => posted.filter((p) => p.url === '/stt');
  const tts = () => posted.filter((p) => p.url === '/tts');
  const reads = () => posted.filter((p) => String(p.url).indexOf('/thread') === 0);
  /** Push an entry belonging to a specific conversation, as the server would. */
  function convReply(conversationId, text, id) {
    const ts = new Date().toISOString();
    store.es.onmessage({
      data: JSON.stringify({
        conversationId,
        entries: [{ id: id || 'e-' + Math.random(), role: 'agent', text, ts, rev: ts, status: 'done', conversationId }],
      }),
    });
  }

  const cssVar = (k) => rootStyle.props[k];

  return {
    sandbox, els, meter, posted, doc, store, cssVar,
    feed, sayOneThing, sayAgain, agentReply, endPlayback, convReply,
    track, sent, stt, tts, reads,
  };
}

// ---------------------------------------------------------------- assertions
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const settle = () => new Promise((r) => setTimeout(r, 25));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A conversation summary as GET /conversations returns one. */
const conv2 = (id, title, extra) => Object.assign({
  id, title, agent: null, createdAt: '2026-01-01T00:00:00.000Z', archived: false, archivedAt: null,
  counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
  messages: 0, lastTs: '2026-01-01T00:00:00.000Z', lastRole: 'user', lastText: '',
  spark: new Array(12).fill(0), sparkBucketMs: 900000,
  agentState: { state: 'unassigned', seenAgoSec: null, actedAgoSec: null, waitingSec: null },
}, extra || {});

/** All the text a stub element and its descendants would render. */
function textOf(el) {
  if (!el) return '';
  let out = el.textContent || '';
  for (const kid of el.children || []) out += ' ' + textOf(kid);
  return out;
}

/*
 * A secure page with a working mic, speaker and live stream. The indirection
 * through `holder` is because the fake microphone needs the env's store, which
 * does not exist until the page has been built.
 */
function liveEnv(extra) {
  const holder = {};
  const opts = Object.assign({
    secure: true, protocol: 'https:', host: 'relay.example.com', finePointer: false,
    mediaDevices: { getUserMedia: (...a) => holder.impl.getUserMedia(...a) },
  }, extra || {});
  const env = makeEnv(opts);
  holder.impl = workingMic(env.store);
  return env;
}

/** Turn conversation mode on and wait for the capture graph to come up. */
async function startConv(env) {
  env.els.convo.dispatch('click');
  await settle();
}

async function main() {
  console.log('\ninsecure origin (a phone on http:// — the reported bug)');
  {
    const { els, posted } = makeEnv({ secure: false, mediaDevices: undefined, finePointer: false });
    check('mic button is struck through, not hidden', els.mic.className === 'off', `className=${JSON.stringify(els.mic.className)}`);
    check('mic button is NOT disabled (the tap is what explains)', els.mic.disabled === false);
    check('mic has an explanatory tooltip', /https/i.test(els.mic.title || ''), els.mic.title);
    check('mic has an explanatory aria-label', /https/i.test(els.mic.getAttribute('aria-label') || ''));
    check('the conversation button is blocked too', els.convo.className === 'off', els.convo.className);
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

  // ================================================================ conversation
  console.log('\nconversation mode — one turn end to end');
  {
    const env = liveEnv();
    await startConv(env);
    check('the mic is open', !!env.track(), 'no track was acquired');
    check('the conversation button reads as on', env.els.convo.className === 'on', env.els.convo.className);
    check('it is announced to assistive tech', env.els.convo.getAttribute('aria-pressed') === 'true');
    check('one-shot dictation is locked out while it runs', env.els.mic.disabled === true);
    check('the status bar is showing', /show/.test(env.els.voice.className), env.els.voice.className);

    env.sayOneThing();
    await settle();
    check('the utterance was sent for transcription', env.stt().length === 1, `${env.stt().length} /stt calls`);
    await wait(2400); // the message-level debounce; see the fragmentation tests
    check('the transcript was posted as a message', env.sent().length === 1, `${env.sent().length} /tasks calls`);
    check('it is tagged as conversational voice',
      env.sent()[0] && env.sent()[0].body.from === 'voice-conversation', JSON.stringify(env.sent()[0] && env.sent()[0].body));
    check('the mic is still open — it did not stop after one utterance', env.track().stopped === false);
    check('and it is still listening', /show/.test(env.els.voice.className) && env.track().enabled === true);

    env.sayOneThing();
    await wait(2400);
    check('a second utterance posts a second message', env.sent().length === 2, `${env.sent().length} sent`);
  }

  console.log('\nconversation mode — nothing worthless reaches the queue');
  {
    const env = liveEnv();
    await startConv(env);

    env.store.sttText = '';
    env.sayOneThing();
    await settle();
    check('an empty transcript is not posted', env.sent().length === 0, `${env.sent().length} sent`);

    env.store.sttText = '.';
    env.sayOneThing();
    await settle();
    check('a punctuation-only transcript is not posted', env.sent().length === 0);

    env.store.sttText = 'Thank you.';
    env.sayOneThing();
    await settle();
    check('a known whisper hallucination is not posted', env.sent().length === 0);

    env.store.sttText = 'okay';
    env.sayOneThing();
    await wait(2400);
    check('but a real short answer IS posted', env.sent().length === 1, `${env.sent().length} sent`);

    env.feed(450, false);
    env.feed(120, true);  // a cough: under MIN_SPEECH_MS
    env.feed(3200, false);
    await settle();
    check('a cough never even reaches the engine', env.stt().length === 4, `${env.stt().length} /stt calls`);
  }

  console.log('\nconversation mode — a slow transcription does not drop the next utterance');
  {
    const env = liveEnv();
    let release;
    const gate = new Promise((r) => { release = r; });
    const realFetch = env.sandbox.fetch;
    const starts = [];
    env.sandbox.fetch = (url, init) => {
      if (url !== '/stt') return realFetch(url, init);
      starts.push(url);                       // counted when the page *begins* the call
      return gate.then(() => realFetch(url, init));
    };
    await startConv(env);

    env.sayOneThing();       // first utterance: transcription now hangs
    await settle();
    env.sayOneThing();       // second one arrives while the first is in flight
    env.sayOneThing();       // and a third
    await settle();
    check('only one transcription is in flight at a time', starts.length === 1, `${starts.length} concurrent`);
    check('the later utterances are queued, not dropped', starts.length === 1 && env.stt().length === 0);
    release();
    await settle();
    await settle();
    check('all three are transcribed once the queue drains', env.stt().length === 3, `${env.stt().length} /stt calls`);
    await wait(2400);
    // Three utterances said back to back are ONE message by design now — the
    // point of this test is that none of them were dropped.
    check('nothing said while transcribing was lost',
      env.sent().length === 1 && /one two three|check the widget report/.test(env.sent()[0].body.text),
      JSON.stringify(env.sent().map((p) => p.body.text)));
  }

  // ================================================================ THE ECHO LOOP
  console.log('\nTHE FEEDBACK LOOP — a spoken reply must not become a new message');
  {
    const env = liveEnv();
    await startConv(env);
    check('conversation turns spoken replies on by default', env.els.spk.className === 'on', env.els.spk.className);

    env.agentReply('Forty two widgets are on hand and three are backordered.');
    await settle();
    check('the reply is sent to the speech engine', env.tts().length === 1, `${env.tts().length} /tts calls`);

    // DEFENCE 1: the track itself is muted, not merely ignored.
    check('DEFENCE 1 — the mic track is disabled while speaking', env.track().enabled === false);
    check('the button shows the mic is muted', /gated/.test(env.els.convo.className), env.els.convo.className);
    check('the status line says so in as many words', /mic off/i.test(env.els.vtext.textContent), env.els.vtext.textContent);

    // DEFENCE 2 + 3: pour the agent's own voice into the mic at full volume.
    const sttBefore = env.stt().length;
    const sentBefore = env.sent().length;
    env.store.sttText = 'Forty two widgets are on hand and three are backordered.';
    env.feed(3000, true);   // loud audio, exactly as if the speaker were feeding back
    env.feed(2000, false);
    await settle();
    check('DEFENCE 2 — nothing is captured while the reply plays', env.stt().length === sttBefore,
      `${env.stt().length - sttBefore} extra /stt calls`);
    check('*** no new message was posted from our own voice ***', env.sent().length === sentBefore,
      `${env.sent().length - sentBefore} phantom messages`);

    // Playback finishes; the mic must stay shut for the settle window.
    env.endPlayback();
    await settle();
    check('DEFENCE 4 — the mic stays shut during the settle delay', env.track().enabled === false);
    env.feed(1200, true);
    await settle();
    check('and audio during the settle delay is still ignored', env.stt().length === sttBefore);

    await wait(700); // > C.SETTLE_MS
    check('the mic comes back on its own once it is safe', env.track().enabled === true);
    check('the button drops the muted look', env.els.convo.className === 'on', env.els.convo.className);

    // DEFENCE 5: even with the gate wide open, our own words are recognised.
    env.sayOneThing();
    await settle();
    check('DEFENCE 5 — an echoing transcript is dropped even off-gate',
      env.sent().length === sentBefore, `${env.sent().length - sentBefore} phantom messages`);
    check('and it says why, rather than silently eating it',
      /own voice/i.test(env.els.vtext.textContent), env.els.vtext.textContent);
    check('the drop is reported to the server',
      env.posted.some((p) => p.url === '/client-log' && p.body && p.body.event === 'conv-dropped'
        && p.body.detail && p.body.detail.why === 'echo'));

    // ...but a genuine reply still gets through.
    env.store.sttText = 'now check the inventory again please';
    env.sayOneThing();
    await wait(2400);
    check('a genuine utterance after a reply still posts', env.sent().length === sentBefore + 1,
      `${env.sent().length - sentBefore} posted`);
  }

  console.log('\nspoken replies — muting, backlog and honest failure');
  {
    const env = liveEnv();
    await settle();
    check('the speaker is off until asked for', env.els.spk.className === '', env.els.spk.className);
    env.agentReply('a reply arriving with the speaker muted', 'r-muted');
    await settle();
    check('nothing is spoken while muted', env.tts().length === 0, `${env.tts().length} /tts calls`);

    env.els.spk.dispatch('click');
    await settle();
    check('tapping the speaker turns it on', env.els.spk.className === 'on', env.els.spk.className);
    env.agentReply('now this one should be spoken', 'r-spoken');
    await settle();
    check('a reply after unmuting is spoken', env.tts().length === 1, `${env.tts().length} /tts calls`);

    env.els.spk.dispatch('click');
    await settle();
    check('tapping again mutes it', env.els.spk.className === '', env.els.spk.className);
    env.agentReply('and this one should stay silent', 'r-silent');
    await settle();
    check('muting is independent of the mic and takes effect at once', env.tts().length === 1);
  }

  console.log('\nspoken replies — the backlog is never read aloud');
  {
    const env = liveEnv();
    env.els.spk.dispatch('click'); // speaker on
    await settle();
    const before = env.tts().length;
    // A full read, as happens on load/refresh, carrying old agent replies.
    env.store.es.onmessage({ data: JSON.stringify({ entries: [] }) });
    await settle();
    check('an empty push speaks nothing', env.tts().length === before);
    check('history present at boot was marked spoken, not queued', before === 0, `${before} /tts calls at boot`);
  }

  console.log('\nspoken replies — what is worth listening to');
  {
    const env = liveEnv();
    env.els.spk.dispatch('click');
    await settle();
    env.agentReply(
      'Done — see https://example.com/very/long/path?x=1 for details.\n' +
      '```\ncurl -s http://127.0.0.1:3901/health | jq .\nsecond line\n```\n' +
      'The file is at /etc/nginx/nginx.conf and the id is 9f8e7d6c5b4a39281706abcdef0123456789.',
      'r-condense',
    );
    await settle();
    const said = env.tts()[0] && env.tts()[0].body.text;
    check('something was spoken', !!said, String(said));
    check('the URL is not read out character by character', !/https?:\/\//.test(said || ''), said);
    check('the code block is not read out', !/curl/.test(said || ''), said);
    check('the file path is not spelled out', !/nginx\.conf/.test(said || ''), said);
    check('the long identifier is not read out', !/9f8e7d6c/.test(said || ''), said);
    check('it says a link was there rather than dropping the clause', /a link/.test(said || ''), said);
    check('it says there was a code block', /code block/.test(said || ''), said);
    check('the actual sentence survives', /Done/.test(said || '') && /for details/.test(said || ''), said);
  }

  console.log('\nspoken replies — a dead TTS engine is loud about it');
  {
    const env = liveEnv();
    env.els.spk.dispatch('click');
    await settle();
    env.store.ttsFail = true;
    await startConv(env);
    env.agentReply('this cannot be synthesised', 'r-fail');
    await settle();
    check('the failure is shown, not swallowed', /show/.test(env.els.err.className), env.els.err.className);
    check('it says the reply is still on screen', /on screen/i.test(env.els.err.textContent), env.els.err.textContent);
    check('it says the mic is unaffected', /microphone is unaffected/i.test(env.els.err.textContent));
    check('it is reported to the server',
      env.posted.some((p) => p.url === '/client-log' && p.body && p.body.event === 'tts-failed'));
    await wait(700);
    check('a TTS failure still releases the mic gate', env.track().enabled === true);
  }

  console.log('\nstopping is instant');
  {
    const env = liveEnv();
    await startConv(env);
    env.agentReply('a long reply that is midway through being spoken', 'r-stop');
    await settle();
    check('it is speaking', env.track().enabled === false);

    env.els.convo.dispatch('click'); // tap to stop, mid-sentence
    check('the microphone is released immediately', env.track().stopped === true);
    check('the button is off immediately', env.els.convo.className === '', env.els.convo.className);
    check('aria-pressed is cleared', env.els.convo.getAttribute('aria-pressed') === 'false');
    check('the status bar is gone immediately', env.els.voice.className === '', env.els.voice.className);
    check('one-shot dictation is available again', env.els.mic.disabled === false);

    const sentBefore = env.sent().length;
    env.store.sttText = 'this should never be posted';
    try { env.feed(2000, true); env.feed(1400, false); } catch (e) { /* the graph is gone: also fine */ }
    await settle();
    check('nothing captured before the stop is posted afterwards', env.sent().length === sentBefore,
      `${env.sent().length - sentBefore} posted after stopping`);
    check('the stop is reported to the server',
      env.posted.some((p) => p.url === '/client-log' && p.body && p.body.event === 'conv-stop'));
  }

  console.log('\nconversation mode when the mic is refused');
  {
    const env = makeEnv({
      secure: true, protocol: 'https:', host: 'relay.example.com',
      mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
    });
    env.els.convo.dispatch('click');
    await settle();
    check('the conversation does not stay half-on', env.els.convo.className === '', env.els.convo.className);
    check('the button is usable again', env.els.convo.disabled === false);
    check('permission denial is explained', /permission denied/i.test(env.els.err.textContent), env.els.err.textContent);
    check('one-shot dictation is not left locked out', env.els.mic.disabled === false);
  }

  // ============================================ fragmentation (the reported bug)
  /*
   * Real symptom: one person talking continuously came out as four queue
   * entries — "First, I..." / "It's a surprise, it's a good surprise." /
   * "Jesus, Jesus, Jesus, Jesus." / "We have it, so...". Transcription was fine;
   * the timing was wrong. These are the tests that keep it fixed.
   */
  console.log('\nfragmentation — one train of thought is one message');
  {
    const env = liveEnv();
    await startConv(env);

    env.store.sttText = 'First, I';
    env.sayOneThing();
    await settle();
    check('a finished transcript is NOT posted immediately', env.sent().length === 0,
      `${env.sent().length} posted too early`);
    check('the pending words are shown in the composer', env.els.input.value === 'First, I',
      JSON.stringify(env.els.input.value));

    env.store.sttText = 'it is a surprise';
    env.sayAgain();
    await settle();
    env.store.sttText = 'we have it, so';
    env.sayAgain();
    await settle();
    check('still nothing posted while they are talking', env.sent().length === 0,
      `${env.sent().length} posted mid-thought`);
    check('the fragments accumulate visibly',
      env.els.input.value === 'First, I it is a surprise we have it, so', JSON.stringify(env.els.input.value));

    await wait(2400); // past STITCH_MS with no further speech
    check('*** three fragments become ONE message ***', env.sent().length === 1,
      `${env.sent().length} messages`);
    check('and it is the whole sentence',
      env.sent()[0] && env.sent()[0].body.text === 'First, I it is a surprise we have it, so',
      JSON.stringify(env.sent()[0] && env.sent()[0].body.text));
    check('the composer is left clean afterwards', env.els.input.value === '',
      JSON.stringify(env.els.input.value));
  }

  console.log('\nfragmentation — a genuine pause still makes two messages');
  {
    const env = liveEnv();
    await startConv(env);
    env.store.sttText = 'first question';
    env.sayOneThing();
    await wait(2400); // they genuinely stopped
    check('the first message posts on its own', env.sent().length === 1, `${env.sent().length}`);

    env.store.sttText = 'second question';
    env.sayAgain();
    await wait(2400);
    check('a later utterance is a separate message', env.sent().length === 2, `${env.sent().length}`);
    check('...with its own text',
      env.sent()[1] && env.sent()[1].body.text === 'second question',
      JSON.stringify(env.sent()[1] && env.sent()[1].body.text));
  }

  console.log('\nfragmentation — the debounce waits for slow transcription');
  {
    const env = liveEnv();
    let release;
    const gate = new Promise((r) => { release = r; });
    const realFetch = env.sandbox.fetch;
    let n = 0;
    env.sandbox.fetch = (url, init) => {
      if (url !== '/stt' || n++ === 0) return realFetch(url, init);
      return gate.then(() => realFetch(url, init)); // the SECOND one hangs
    };
    await startConv(env);
    env.store.sttText = 'part one';
    env.sayOneThing();
    await settle();
    env.store.sttText = 'part two';
    env.sayAgain();
    await settle();
    await wait(2400); // the debounce would have fired by now
    check('it does not post while a transcription is still in flight', env.sent().length === 0,
      `${env.sent().length} posted early`);
    release();
    await settle();
    await wait(2400);
    check('and both parts land as one message', env.sent().length === 1, `${env.sent().length}`);
    check('...joined together',
      env.sent()[0] && env.sent()[0].body.text === 'part one part two',
      JSON.stringify(env.sent()[0] && env.sent()[0].body.text));
  }

  // ======================================= the wedge (messages that never send)
  /*
   * Reported as "the page crashes". It does not crash here — it goes silent,
   * which from a phone is the same thing, and the reload it provokes is what
   * misroutes the next message into the wrong conversation.
   *
   * The mechanism: the debounce re-arms for as long as `stillTalking()` is
   * true, and that is true for as long as the endpointer sits in its 'speak'
   * phase. Background noise — a fan, a television, someone packing a suitcase —
   * refreshes the last-loud timestamp on every frame, so the phase never ends,
   * so the re-arm never stops, so the message is never posted. The composer
   * goes on saying "Still listening — sending: …" for ever.
   */
  console.log('\nthe wedge — a noisy room cannot defer a message for ever');
  {
    const env = liveEnv();
    await startConv(env);
    env.store.sttText = 'this message must not be lost';
    env.sayOneThing();
    await settle();
    check('the transcript is pending, not yet posted', env.sent().length === 0,
      `${env.sent().length}`);

    // Hold the endpointer in 'speak' the way a noisy room does: never silent
    // long enough to end the utterance, and never quiet enough to drop out.
    const noise = setInterval(() => { try { env.feed(200, true); } catch (e) {} }, 100);

    await wait(6000);
    check('it is still deferred while that looks like speech', env.sent().length === 0,
      `${env.sent().length} posted too early`);

    await wait(9000); // now past MAX_DEFER_MS since the last real transcript
    clearInterval(noise);
    check('*** a wedged endpointer still posts the message ***', env.sent().length === 1,
      `${env.sent().length} messages — 0 means it is deferring for ever again`);
    check('...and the words are intact',
      env.sent()[0] && env.sent()[0].body.text === 'this message must not be lost',
      JSON.stringify(env.sent()[0] && env.sent()[0].body.text));
    check('the composer is left clean', env.els.input.value === '',
      JSON.stringify(env.els.input.value));
  }

  console.log('\nfragmentation — Send cuts it short, and stopping never loses words');
  {
    const env = liveEnv();
    await startConv(env);
    env.store.sttText = 'send this now';
    env.sayOneThing();
    await settle();
    env.els.send.dispatch('click');
    await settle();
    check('Send posts the pending words immediately', env.sent().length === 1, `${env.sent().length}`);
    check('it is tagged as conversational voice',
      env.sent()[0] && env.sent()[0].body.from === 'voice-conversation',
      JSON.stringify(env.sent()[0] && env.sent()[0].body.from));
    await wait(2400);
    check('the debounce does not post it a second time', env.sent().length === 1, `${env.sent().length}`);

    const env2 = liveEnv();
    await startConv(env2);
    env2.store.sttText = 'half a thought';
    env2.sayOneThing();
    await settle();
    env2.els.convo.dispatch('click'); // stop mid-thought
    await settle();
    check('stopping posts nothing', env2.sent().length === 0, `${env2.sent().length}`);
    check('but the words are kept in the composer', env2.els.input.value === 'half a thought',
      JSON.stringify(env2.els.input.value));
    await wait(2400);
    check('and still nothing is posted after stopping', env2.sent().length === 0, `${env2.sent().length}`);
  }

  console.log('\nfragmentation — a filler word mid-thought is kept, alone is dropped');
  {
    const env = liveEnv();
    await startConv(env);
    env.store.sttText = 'so';
    env.sayOneThing();
    await wait(2400);
    check('a lone filler word never becomes a message', env.sent().length === 0, `${env.sent().length}`);

    env.store.sttText = 'check the widgets';
    env.sayAgain();
    await settle();
    env.store.sttText = 'so';
    env.sayAgain();
    await settle();
    await wait(2400);
    check('but the same word continuing a sentence is kept', env.sent().length === 1, `${env.sent().length}`);
    check('...as part of the text',
      env.sent()[0] && env.sent()[0].body.text === 'check the widgets so',
      JSON.stringify(env.sent()[0] && env.sent()[0].body.text));
  }

  // ================================================================ conversations
  console.log('\nconversations — the menu');
  {
    const env = liveEnv();
    await settle();
    check('every thread read is scoped to a conversation',
      env.reads().length > 0 && env.reads().every((p) => /conversation=main/.test(p.url)),
      env.reads().map((p) => p.url).join(' '));
    check('the header names the conversation you are in', env.els.title.textContent === 'Main',
      env.els.title.textContent);
    check('the menu lists both conversations', env.els.convlist.children.length === 2,
      `${env.els.convlist.children.length} rows`);

    check('a row shows its title', textOf(env.els.convlist.children[0]).indexOf('Main') > -1,
      textOf(env.els.convlist.children[0]));
    check('a row shows a hint of the last message',
      textOf(env.els.convlist.children[0]).indexOf('the first thread') > -1);
    check('the active one is marked', /active/.test(env.els.convlist.children[0].className),
      env.els.convlist.children[0].className);
    check('the other one is not', !/active/.test(env.els.convlist.children[1].className));
    check('a conversation with waiting work says so',
      textOf(env.els.convlist.children[1]).indexOf('2 waiting') > -1,
      textOf(env.els.convlist.children[1]));

    env.els.menu.dispatch('click');
    await settle();
    check('the drawer opens', env.els.drawer.hidden === false && env.els.drawer.className === 'open',
      `hidden=${env.els.drawer.hidden} class=${env.els.drawer.className}`);
    env.els.scrim.dispatch('click');
    check('tapping the scrim closes it', env.els.drawer.className === '');
  }

  console.log('\nconversations — switching');
  {
    const env = liveEnv();
    await settle();
    const before = env.reads().length;
    env.els.convlist.children[1].dispatch('click'); // switch to "Widget audit"
    await settle();
    check('the new conversation is read', env.reads().length > before
      && /conversation=c2/.test(env.reads()[env.reads().length - 1].url),
      env.reads()[env.reads().length - 1].url);
    check('the header follows', env.els.title.textContent === 'Widget audit', env.els.title.textContent);
    check('the drawer closes on switch', env.els.drawer.className === '');
    check('the active marker moved', /active/.test(env.els.convlist.children[1].className)
      && !/active/.test(env.els.convlist.children[0].className));

    env.els.input.value = 'a typed message';
    env.els.send.dispatch('click');
    await settle();
    check('a sent message goes to the conversation you are in',
      env.sent()[0] && env.sent()[0].body.conversationId === 'c2', JSON.stringify(env.sent()[0] && env.sent()[0].body));
  }

  // ===================================== the conversation lives in the URL
  /*
   * The bug this closes: reloading the page silently put you back in `main`.
   * Reloading is what this user does whenever the page looks stuck, so the next
   * message went to whichever agent owns `main` rather than the one being
   * talked to. Nothing announced the switch — a misrouted message is only
   * discovered when an agent acts on something never meant for it.
   */
  console.log('\nthe URL — the conversation survives a reload');
  {
    const env = liveEnv();
    await settle();
    check('a bare address gets the conversation written into it',
      env.sandbox.location.hash === '#/c/main', env.sandbox.location.hash);
    check('...by replacing, so Back does not step into a state nobody chose',
      env.sandbox.history.entries.length === 1 && env.sandbox.history.entries[0].how === 'replace',
      JSON.stringify(env.sandbox.history.entries));

    env.els.convlist.children[1].dispatch('click'); // switch to "Widget audit"
    await settle();
    check('switching puts that conversation in the address bar',
      env.sandbox.location.hash === '#/c/c2', env.sandbox.location.hash);
    check('...and that one IS a history entry, so Back comes back',
      env.sandbox.history.entries.slice(-1)[0].how === 'push',
      JSON.stringify(env.sandbox.history.entries));
  }

  console.log('\nthe URL — a link opens the thread it names');
  {
    const env = liveEnv({ hash: '#/c/c2' });
    await settle();
    check('*** a reload lands in the conversation it was in ***',
      env.els.title.textContent === 'Widget audit', env.els.title.textContent);
    check('and it is that conversation that gets read',
      /conversation=c2/.test(env.reads().slice(-1)[0].url), env.reads().slice(-1)[0].url);

    env.els.input.value = 'a message after the reload';
    env.els.send.dispatch('click');
    await settle();
    check('*** so the next message cannot be misrouted ***',
      env.sent()[0] && env.sent()[0].body.conversationId === 'c2',
      JSON.stringify(env.sent()[0] && env.sent()[0].body));
  }

  console.log('\nthe URL — it outranks what this device last had open');
  {
    const env = liveEnv({ hash: '#/c/c2', stored: { 'relay.conv': 'main' } });
    await settle();
    check('a shared link wins over the remembered conversation',
      env.els.title.textContent === 'Widget audit', env.els.title.textContent);

    const remembered = liveEnv({ stored: { 'relay.conv': 'c2' } });
    await settle();
    check('...but with no link, the remembered one is still honoured',
      remembered.els.title.textContent === 'Widget audit', remembered.els.title.textContent);
    check('...and it is written into the address bar too',
      remembered.sandbox.location.hash === '#/c/c2', remembered.sandbox.location.hash);
  }

  console.log('\nthe URL — Back and Forward move between conversations');
  {
    const env = liveEnv();
    await settle();
    env.els.convlist.children[1].dispatch('click');
    await settle();
    check('we are in the second conversation', env.els.title.textContent === 'Widget audit');

    // What the browser does on Back: the fragment changes, then it tells us.
    env.sandbox.location.hash = '#/c/main';
    env.sandbox.dispatchWindow('popstate');
    await settle();
    check('*** Back returns to the previous conversation ***',
      env.els.title.textContent === 'Main', env.els.title.textContent);
    check('...and it does not push a new entry for a move it did not make',
      env.sandbox.history.entries.slice(-1)[0].url === '#/c/c2',
      JSON.stringify(env.sandbox.history.entries));

    env.sandbox.location.hash = '#/c/c2';
    env.sandbox.dispatchWindow('hashchange');
    await settle();
    check('Forward works the same way', env.els.title.textContent === 'Widget audit',
      env.els.title.textContent);
  }

  console.log('\nthe URL — a dead link degrades to the default, out loud');
  {
    const env = liveEnv({ hash: '#/c/archived-last-week' });
    await settle();
    check('*** an unknown conversation does not leave a blank page ***',
      env.els.title.textContent === 'Main', env.els.title.textContent);
    check('it says so rather than switching you silently',
      /not here any more/i.test(env.els.err.textContent), JSON.stringify(env.els.err.textContent));
    check('and the bad address is repaired, so a reload does not repeat it',
      env.sandbox.location.hash === '#/c/main', env.sandbox.location.hash);
    check('...by replacing, so Back does not lead to the dead link',
      env.sandbox.history.entries.slice(-1)[0].how === 'replace',
      JSON.stringify(env.sandbox.history.entries));

    /*
     * The same link pasted into a page that is already open. This one is not a
     * reload — the fragment changes and nothing else does — so the page has to
     * notice by itself. It did not, and sat on an empty thread titled "relay"
     * until the ten-minute repair poll; a real browser caught what the stub
     * above could not, because the stub had reloaded.
     */
    const open = liveEnv();
    await settle();
    open.sandbox.location.hash = '#/c/archived-last-week';
    open.sandbox.dispatchWindow('hashchange');
    await settle();
    check('a dead link pasted into an already-open page is repaired too',
      open.els.title.textContent === 'Main' && /not here any more/i.test(open.els.err.textContent),
      `${open.els.title.textContent} / ${open.els.err.textContent}`);
  }

  console.log('\nconversations — activity elsewhere is flagged, not merged');
  {
    const env = liveEnv();
    env.els.spk.dispatch('click'); // speaker on, so we can prove it stays quiet
    await settle();
    const ttsBefore = env.tts().length;
    env.convReply('c2', 'an answer in the other conversation', 'other-1');
    await settle();
    check('it is not merged into the thread on screen',
      JSON.stringify(env.els.list.children).indexOf('an answer in the other') === -1);
    check('the hamburger shows there is something to see', env.els.menudot.className === 'show',
      env.els.menudot.className);
    check('a reply in another conversation is NOT read aloud', env.tts().length === ttsBefore,
      `${env.tts().length - ttsBefore} spoken`);

    env.agentReply('an answer in the one I am looking at', 'mine-1');
    await settle();
    check('but a reply in the active conversation still is', env.tts().length === ttsBefore + 1);
  }

  console.log('\nconversations — creating one');
  {
    const env = liveEnv();
    await settle();
    env.els.menu.dispatch('click');
    env.els.newtitle.value = 'Deploy notes';
    env.els.newconv.dispatch('click');
    await settle();
    await settle();
    const made = env.posted.filter((p) => p.url === '/conversations' && p.body && p.body.title);
    check('it is created on the server', made.length === 1 && made[0].body.title === 'Deploy notes',
      JSON.stringify(made.map((p) => p.body)));
    check('and switched into', env.els.title.textContent === 'Deploy notes', env.els.title.textContent);
    check('the input is cleared', env.els.newtitle.value === '', env.els.newtitle.value);
    check('the drawer closed', env.els.drawer.className === '');
  }

  console.log('\nconversations — a transcript cannot be misrouted by switching');
  {
    const env = liveEnv();
    let release;
    const gate = new Promise((r) => { release = r; });
    const realFetch = env.sandbox.fetch;
    env.sandbox.fetch = (url, init) => (url === '/stt' ? gate.then(() => realFetch(url, init)) : realFetch(url, init));
    await startConv(env);
    check('the conversation starts in Main', env.els.title.textContent === 'Main');

    env.sayOneThing();                       // spoken while "Main" is open
    await settle();
    env.els.convlist.children[1].dispatch('click'); // ...user switches away mid-transcription
    await settle();
    check('the switch happened', env.els.title.textContent === 'Widget audit', env.els.title.textContent);
    check('the live microphone was not stranded by the switch', env.track().stopped === false);

    release();
    await settle();
    await wait(2400);
    check('*** the utterance posts to the conversation it was SPOKEN into ***',
      env.sent().length === 1 && env.sent()[0].body.conversationId === 'main',
      JSON.stringify(env.sent().map((p) => p.body.conversationId)));

    env.sayOneThing();                       // said after the switch
    await wait(2400);
    check('and a later utterance posts to the new one',
      env.sent().length === 2 && env.sent()[1].body.conversationId === 'c2',
      JSON.stringify(env.sent().map((p) => p.body.conversationId)));
  }

  console.log('\nconversations — sparkline and agent liveness');
  {
    const env = liveEnv();
    env.store.convs = [
      conv2('main', 'Main', { spark: [0, 2, 5, 1, 0, 0, 3, 8, 2, 0, 1, 4], sparkBucketMs: 900000,
        agent: 'communicator', agentState: { state: 'watching', seenAgoSec: 4, actedAgoSec: 9, waitingSec: null } }),
      conv2('c2', 'Widget audit', { spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sparkBucketMs: 900000,
        agent: 'coordinator-2', agentState: { state: 'stuck', seenAgoSec: 2, actedAgoSec: 480, waitingSec: 470 } }),
      conv2('c3', 'Empty', { spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sparkBucketMs: 900000,
        agent: null, agentState: { state: 'unassigned', seenAgoSec: null, actedAgoSec: null, waitingSec: null } }),
    ];
    await settle();
    env.els.menu.dispatch('click');
    await settle();

    const rows = env.els.convlist.children;
    check('all three conversations are listed', rows.length === 3, `${rows.length}`);
    const sparks = rows.map((r) => r.children.find((k) => /spark/.test(k.className)));
    check('a busy conversation gets a sparkline', !!sparks[0] && sparks[0].children.length === 12,
      `${sparks[0] && sparks[0].children.length} bars`);
    check('bar heights vary with the data',
      new Set(sparks[0].children.map((b) => b.style.height)).size > 1,
      JSON.stringify(sparks[0].children.map((b) => b.style.height)));
    check('it is described in words, not just drawn',
      /messages in the last/.test(sparks[0].getAttribute('aria-label') || ''),
      sparks[0].getAttribute('aria-label'));
    check('a busy conversation is tinted with its own hue',
      !!sparks[0].children[1].style.backgroundColor, String(sparks[0].children[1].style.backgroundColor));

    check('an empty conversation still draws a baseline, not nothing',
      sparks[2].children.length === 12
      && sparks[2].children.every((b) => parseFloat(b.style.height) > 0),
      JSON.stringify(sparks[2].children.map((b) => b.style.height)));
    check('...and is marked quiet rather than left blank', /quiet/.test(sparks[2].className),
      sparks[2].className);
    check('...and says so in words', /nothing in the last/.test(sparks[2].getAttribute('aria-label') || ''),
      sparks[2].getAttribute('aria-label'));

    const agents = rows.map((r) => r.children.find((k) => /convagent/.test(k.className)));
    check('the owning agent is named', textOf(agents[0]).indexOf('communicator') > -1, textOf(agents[0]));
    check('a working agent says "working", not merely "checking in"',
      /working/.test(textOf(agents[0])), textOf(agents[0]));
    check('*** beating-but-not-acting reads as STUCK, not healthy ***',
      /STUCK/.test(textOf(agents[1])) && /stuck/.test(agents[1].className),
      `${textOf(agents[1])} | ${agents[1].className}`);
    check('...and never as "fine"', !/^.*working/.test(textOf(agents[1])), textOf(agents[1]));
    check('...with how long it has done nothing', /for /.test(textOf(agents[1])), textOf(agents[1]));
    check('the stuck one is named too', textOf(agents[1]).indexOf('coordinator-2') > -1, textOf(agents[1]));
    check('liveness is not conveyed by colour alone',
      textOf(agents[0]).indexOf('●') > -1 && textOf(agents[1]).indexOf('!') > -1,
      `${textOf(agents[0])} / ${textOf(agents[1])}`);
    check('an unassigned conversation says nobody is on it',
      /nobody assigned/.test(textOf(agents[2])), textOf(agents[2]));
  }

  console.log('\ncolour — decoration that carries information');
  {
    const env = liveEnv();
    await settle();
    const mainHue = env.cssVar('--hue');
    check('the page takes a hue from the conversation', mainHue !== undefined, String(mainHue));
    check('a second hue is derived for the gradient', env.cssVar('--hue2') !== undefined);
    check('the hue is a legal degree', Number(mainHue) >= 0 && Number(mainHue) < 360, String(mainHue));

    env.els.convlist.children[1].dispatch('click'); // switch conversations
    await settle();
    check('switching conversation changes the colour', env.cssVar('--hue') !== mainHue,
      `${mainHue} -> ${env.cssVar('--hue')}`);

    const again = liveEnv();
    await settle();
    check('the same conversation always gets the same colour', again.cssVar('--hue') === mainHue,
      `${again.cssVar('--hue')} vs ${mainHue}`);
    check('each row in the menu is striped with its own colour',
      again.els.convlist.children[0].style.borderLeftColor
      !== again.els.convlist.children[1].style.borderLeftColor,
      String(again.els.convlist.children[0].style.borderLeftColor));
  }

  console.log('\ncolour — message state is readable without relying on hue');
  {
    const env = liveEnv();
    await settle();
    const at = (n) => `2026-01-01T00:00:0${n}.000Z`;
    env.store.es.onmessage({
      data: JSON.stringify({
        conversationId: 'main',
        entries: [
          { id: 'm1', role: 'user', text: 'one', ts: at(0), rev: at(0), status: 'pending', conversationId: 'main' },
          { id: 'm2', role: 'user', text: 'two', ts: at(1), rev: at(1), status: 'claimed', conversationId: 'main' },
          { id: 'm3', role: 'user', text: 'three', ts: at(2), rev: at(2), status: 'done', conversationId: 'main' },
        ],
      }),
    });
    await settle();
    const bubbles = env.els.list.children;
    check('every message rendered', bubbles.length === 3, `${bubbles.length}`);
    check('pending carries its own class', /st-pending/.test(bubbles[0].className), bubbles[0].className);
    check('claimed carries its own class', /st-claimed/.test(bubbles[1].className), bubbles[1].className);
    check('answered carries its own class', /st-done/.test(bubbles[2].className), bubbles[2].className);
    const chips = ['○ pending', '◐ claimed', '✓ answered'];
    for (let i = 0; i < 3; i++) {
      check(`state ${i + 1} is marked with a glyph as well as a colour`,
        textOf(bubbles[i]).indexOf(chips[i]) > -1, textOf(bubbles[i]));
    }
    check('the three glyphs are all different', new Set(chips.map((c) => c[0])).size === 3);
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  // Each stub page left its poll timer armed; exit rather than wait them out.
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
