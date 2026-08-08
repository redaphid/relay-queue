'use strict';
/*
 * relay-queue — minimal durable local-only HTTP task queue. Run: node server.js
 * Zero runtime dependencies. Every mutation is appended to data/events.jsonl
 * (write + fsync) BEFORE the response is sent, then replayed into memory on boot.
 */
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'relay-queue';
const VERSION = '1.5.0';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3901);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'events.jsonl');
// Where the UI page is read from, first match wins. `public/index.html` is the source of
// truth; the DATA_DIR copy is a shim for the container, which currently bind-mounts only
// server.js, package.json and data/ — drop it once compose mounts `./public:/app/public:ro`.
const UI_FILES = [
  process.env.UI_FILE,
  path.join(__dirname, 'public', 'index.html'),
  path.join(DATA_DIR, 'ui', 'index.html'),
].filter(Boolean);
const MAX_BODY = 1024 * 1024; // 1 MiB
const MAX_TEXT = 8000; // per-message cap for instruction/text; results are only bounded by MAX_BODY

// --- conversations ---------------------------------------------------------
// Every task belongs to exactly one conversation. Records written before
// conversations existed have no conversationId and replay into DEFAULT_CONV, so
// the whole existing history lands in one sensible thread and every pre-existing
// curl call (which sends no conversationId) keeps working unchanged.
const DEFAULT_CONV = 'main';
const DEFAULT_CONV_TITLE = 'Main';
const MAX_TITLE = 200;
const MAX_AGENT = 200;

// --- speech to text (POST /stt) -------------------------------------------
// Audio is relayed to a Wyoming ASR server (wyoming-whisper) over a plain TCP
// socket. Still zero runtime dependencies: node:net speaks the whole protocol.
// From inside the container the engine is on the *host*, so compose sets
// STT_HOST=host.docker.internal; bare node reaches it on loopback.
const STT_HOST = process.env.STT_HOST || '127.0.0.1';
const STT_PORT = Number(process.env.STT_PORT || 10300);
const STT_LANGUAGE = process.env.STT_LANGUAGE || null; // null = whatever the engine is configured for
const MAX_AUDIO = 8 * 1024 * 1024; // ~4.4 min of 16 kHz mono int16
const STT_CONNECT_MS = 5000;
const STT_TIMEOUT_MS = 120000; // whole exchange, including model inference
const STT_CHUNK_BYTES = 4096; // audio bytes per audio-chunk event

// --- text to speech (POST /tts) -------------------------------------------
// wyoming-piper speaks the *same* protocol as wyoming-whisper on a different
// port, so this reuses the identical client below — the only differences are
// which events are sent and which are listened for.
const TTS_HOST = process.env.TTS_HOST || '127.0.0.1';
const TTS_PORT = Number(process.env.TTS_PORT || 10200);
const TTS_VOICE = process.env.TTS_VOICE || null; // null = the engine's default voice
const TTS_TIMEOUT_MS = 60000;
const MAX_SPEAK_TEXT = 2000; // one reply's worth; the page condenses before it gets here
const STARTED_AT = Date.now();
const STATUSES = ['pending', 'claimed', 'done'];
const DEFAULT_ROLE = 'user'; // records written before roles existed are the human's messages

// ---------------------------------------------------------------- event log
/** @type {Map<string, object>} id -> task (insertion order == creation order) */
const tasks = new Map();
/** @type {Map<string, object>} id -> conversation (insertion order == creation order) */
const conversations = new Map();
let logFd = null;
let mutations = 0; // bumped on every applied event; memoisation keys off it

function newConversation(id, title, agent) {
  return {
    id,
    title,
    agent: agent || null, // who is meant to answer here; set and read by the agent side
    createdAt: nowIso(),
    archived: false,
    archivedAt: null,
  };
}

/*
 * The default conversation always exists, and is created in memory rather than
 * written to the log. That keeps `events.jsonl` untouched for an install that
 * has never used conversations: nothing is rewritten, nothing is migrated, and
 * a log written by the previous version replays byte for byte as before.
 * A rename lands as an ordinary `convpatch` on top of it.
 */
function ensureDefaultConv() {
  if (!conversations.has(DEFAULT_CONV)) {
    conversations.set(DEFAULT_CONV, newConversation(DEFAULT_CONV, DEFAULT_CONV_TITLE, null));
  }
}

function applyEvent(ev) {
  mutations++;
  if (ev.t === 'create') {
    // Records logged before `role` existed replay as the human's messages.
    if (ev.task.role !== 'agent') ev.task.role = DEFAULT_ROLE;
    // ...and records logged before conversations existed belong to the default one.
    if (typeof ev.task.conversationId !== 'string' || !ev.task.conversationId) {
      ev.task.conversationId = DEFAULT_CONV;
    }
    tasks.set(ev.task.id, ev.task);
  } else if (ev.t === 'patch') {
    const task = tasks.get(ev.id);
    if (task) Object.assign(task, ev.patch);
  } else if (ev.t === 'conv') {
    conversations.set(ev.conv.id, ev.conv);
  } else if (ev.t === 'convpatch') {
    const conv = conversations.get(ev.id);
    if (conv) Object.assign(conv, ev.patch);
  }
}

function appendEvent(ev) {
  if (logFd === null) logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, JSON.stringify(ev) + '\n');
  try {
    fs.fsyncSync(logFd); // best effort; some bind-mounted FSes reject fsync
  } catch { /* the write itself already left our process buffers */ }
  applyEvent(ev);
  // Push to live pages, post-durability.
  if (ev.t === 'conv' || ev.t === 'convpatch') broadcastConv(ev.t === 'conv' ? ev.conv.id : ev.id);
  else broadcast(ev.t === 'create' ? ev.task.id : ev.id);
  // An agent acting is what clears the deadman banner, and it must clear at once
  // rather than up to a tick later — recovery has to feel immediate to be trusted.
  pushWatch();
}

function replay() {
  if (!fs.existsSync(LOG_FILE)) return { events: 0, skipped: 0 };
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  let events = 0;
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      applyEvent(JSON.parse(line));
      events++;
    } catch {
      skipped++; // torn final line from a hard crash, or hand-edited garbage
    }
  }
  return { events, skipped };
}

// ---------------------------------------------------------------- helpers
const nowIso = () => new Date().toISOString();

function newId(into) {
  const taken = into || tasks;
  let id;
  do {
    id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  } while (taken.has(id));
  return id;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const fail = (res, code, error, extra) => send(res, code, { error, ...extra });
const httpErr = (code, message) => Object.assign(new Error(message), { code });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpErr(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => reject(httpErr(400, 'request stream error')));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({}); // empty body is a valid "no fields" request
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(httpErr(400, 'malformed JSON body'));
      }
    });
  });
}

/** Collects an un-parsed request body (audio), capped at `max` bytes. */
function readRawBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(httpErr(413, `body too large (max ${max} bytes)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => reject(httpErr(400, 'request stream error')));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Accepts ISO 8601 or epoch milliseconds. Returns ms, or null if unparseable. */
function parseSince(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Applies status / unread / since / limit query filters. Throws {code,message}. */
function applyFilters(list, q) {
  // `conversation` is the canonical name; `conversationId` is accepted too, since
  // that is what the record field is called and both are natural to reach for.
  const conv = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
  if (conv !== null && conv !== '') list = list.filter((t) => convIdOf(t) === conv);

  const status = q.get('status');
  if (status !== null) {
    if (!STATUSES.includes(status)) throw httpErr(400, `invalid status "${status}"`);
    list = list.filter((t) => t.status === status);
  }

  const unread = q.get('unread');
  if (unread !== null && unread !== 'false') list = list.filter((t) => t.relayed === false);

  const since = q.get('since');
  if (since !== null) {
    const ms = parseSince(since);
    if (ms === null) throw httpErr(400, `invalid since "${since}" (want ISO 8601 or epoch ms)`);
    list = list.filter((t) => Date.parse(t.ts) > ms); // strictly after
  }

  const limit = q.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 0) throw httpErr(400, `invalid limit "${limit}"`);
    list = list.slice(0, n);
  }
  return list;
}

const counts = () => {
  const c = { pending: 0, claimed: 0, done: 0, unrelayed: 0 };
  for (const t of tasks.values()) {
    c[t.status]++;
    if (!t.relayed) c.unrelayed++;
  }
  return c;
};

// ---------------------------------------------------------------- thread view
/*
 * The thread is a read-only projection of the same task records — there is no
 * second store and no second write path:
 *   - every task yields one entry carrying its own role ("user" by default);
 *   - a task that has a result *also* yields a derived role:"agent" entry
 *     (id `<taskId>:r`, `replyTo` set), so an agent replies to the human simply
 *     by POSTing a result. No extra endpoint, no change to claim/result rules.
 * `ts` is the immutable display/ordering key. `rev` is the last-changed key that
 * `since=` filters on, so a status change (pending -> claimed -> done) also
 * reaches an incrementally polling client.
 */
const msOf = (v) => { const n = Date.parse(v || ''); return Number.isNaN(n) ? 0 : n; };
const asText = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

/** The one or two thread entries a single task projects to. */
function entriesOf(t) {
  const createdMs = msOf(t.ts);
  const revMs = Math.max(createdMs, msOf(t.claimedAt), msOf(t.resultTs));
  const conversationId = convIdOf(t);
  const out = [{
    id: t.id,
    role: t.role === 'agent' ? 'agent' : 'user',
    text: asText(t.instruction),
    ts: t.ts,
    status: t.status,
    rev: new Date(revMs).toISOString(),
    conversationId,
  }];
  if (t.result !== null && t.result !== undefined) {
    const at = t.resultTs || t.ts;
    out.push({
      id: `${t.id}:r`,
      role: 'agent',
      text: asText(t.result),
      ts: at,
      status: 'done',
      rev: new Date(Math.max(msOf(at), createdMs)).toISOString(),
      replyTo: t.id,
      conversationId,
    });
  }
  return out;
}

/** A task's conversation, defaulting for records written before they existed. */
const convIdOf = (t) => (typeof t.conversationId === 'string' && t.conversationId ? t.conversationId : DEFAULT_CONV);

function threadEntries(conversationId) {
  const out = [];
  for (const t of tasks.values()) {
    if (conversationId && convIdOf(t) !== conversationId) continue;
    out.push(...entriesOf(t));
  }
  // Stable sort: a reply is pushed after its parent, so equal timestamps keep order.
  return out.sort((a, b) => msOf(a.ts) - msOf(b.ts));
}

/*
 * Conversations with their derived summary: counts, when they were last active,
 * and a snippet of the newest message so the menu can show a hint of it.
 *
 * Memoised on `mutations`, which is bumped by every applied event. The page
 * polls this alongside the thread, so recomputing a full scan per request would
 * be wasteful — but a scan is trivially correct, and invalidating on any write
 * keeps it that way. Nothing here reads the event log; it is all in memory.
 */
let summaryCache = { at: '', list: null };

/*
 * A sparkline of recent activity per conversation: how many messages and
 * replies landed in each slice of the last few hours. It only has to answer
 * "busy, quiet, or dead" at a glance, so it is a dozen small integers — no
 * axes, no labels, nothing to over-engineer. Bucketed here rather than in the
 * page so the browser never needs the event log.
 */
const SPARK_BUCKETS = 12;
const SPARK_BUCKET_MS = 15 * 60 * 1000; // 12 x 15 min = the last three hours
const SPARK_SPAN_MS = SPARK_BUCKETS * SPARK_BUCKET_MS;

function conversationSummaries() {
  // The buckets are relative to now, so the memo has to expire with time as
  // well as with writes — otherwise a quiet hour would keep showing stale bars.
  const key = mutations + ':' + Math.floor(Date.now() / SPARK_BUCKET_MS);
  if (summaryCache.at === key) return summaryCache.list;

  const spanStart = Date.now() - SPARK_SPAN_MS;
  const bucketOf = (iso) => {
    const t = msOf(iso);
    if (!t || t < spanStart) return -1;
    const i = Math.floor((t - spanStart) / SPARK_BUCKET_MS);
    return i >= SPARK_BUCKETS ? SPARK_BUCKETS - 1 : i;
  };

  const acc = new Map();
  for (const c of conversations.values()) {
    acc.set(c.id, {
      ...c,
      counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
      messages: 0,
      lastTs: null,
      lastRole: null,
      lastText: '',
      spark: new Array(SPARK_BUCKETS).fill(0),
      sparkBucketMs: SPARK_BUCKET_MS,
      lastActedAt: null,   // a claim or a result: proof an agent actually ran
      oldestWaitingTs: null,
    });
  }
  for (const t of tasks.values()) {
    const id = convIdOf(t);
    let a = acc.get(id);
    if (!a) {
      // A task pointing at a conversation that was never recorded. Surfacing it
      // under a placeholder beats hiding the user's messages.
      a = { ...newConversation(id, id, null), counts: { pending: 0, claimed: 0, done: 0, unrelayed: 0 },
        messages: 0, lastTs: null, lastRole: null, lastText: '', missing: true,
        spark: new Array(SPARK_BUCKETS).fill(0), sparkBucketMs: SPARK_BUCKET_MS,
        lastActedAt: null, oldestWaitingTs: null };
      acc.set(id, a);
    }
    a.counts[t.status]++;
    if (!t.relayed) a.counts.unrelayed++;
    a.messages++;
    // Both halves of a turn count as activity — a conversation where the agent
    // is answering is busy, not idle.
    for (const at of [t.claimedAt, t.resultTs]) {
      if (at && (!a.lastActedAt || msOf(at) > msOf(a.lastActedAt))) a.lastActedAt = at;
    }
    if (t.status !== 'done' && (!a.oldestWaitingTs || msOf(t.ts) < msOf(a.oldestWaitingTs))) {
      a.oldestWaitingTs = t.ts;
    }
    const bIn = bucketOf(t.ts);
    if (bIn >= 0) a.spark[bIn]++;
    if (t.resultTs) {
      const bOut = bucketOf(t.resultTs);
      if (bOut >= 0) a.spark[bOut]++;
    }
    const hasResult = t.result !== null && t.result !== undefined;
    const at = hasResult ? (t.resultTs || t.ts) : t.ts;
    if (!a.lastTs || msOf(at) >= msOf(a.lastTs)) {
      a.lastTs = at;
      a.lastRole = hasResult ? 'agent' : (t.role === 'agent' ? 'agent' : 'user');
      a.lastText = asText(hasResult ? t.result : t.instruction).replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  const list = [...acc.values()].sort((a, b) => msOf(b.lastTs || b.createdAt) - msOf(a.lastTs || a.createdAt));
  summaryCache = { at: key, list };
  return list;
}

/*
 * Is the agent that owns this conversation actually there? Same thresholds the
 * status page uses, so "watching" means the same thing in both places. Computed
 * outside the memo above because heartbeats arrive without changing the queue.
 */
/*
 * Per-conversation agent state, on the same evidence rules as the status page:
 * a heartbeat is weak, a claim or a result is strong, and the judgement is made
 * against whether work is actually waiting rather than against raw silence.
 *
 * `stuck` is the state that matters: checking in, but nothing done, while a
 * message sits unanswered. That is precisely the shape of a hung agent, and it
 * used to render as the healthiest thing on the page.
 */
function agentLiveness(c) {
  const seenAgoSec = c.agent && HEARTBEATS.get(c.agent) ? secSince(HEARTBEATS.get(c.agent).at) : null;
  const actedAgoSec = secSince(c.lastActedAt);
  const waitingSec = secSince(c.oldestWaitingTs);
  const base = { seenAgoSec, actedAgoSec, waitingSec };

  if (!c.agent) return { ...base, state: 'unassigned' };
  if (seenAgoSec === null && actedAgoSec === null) return { ...base, state: 'never' };

  const idle = actedAgoSec === null ? Infinity : actedAgoSec;
  const waited = waitingSec === null ? 0 : waitingSec;   // no waiting work = nothing is stalled
  const stalled = waitingSec === null ? 0 : Math.min(idle, waited);
  const beating = seenAgoSec !== null && seenAgoSec * 1000 <= WATCHING_MS;

  if (stalled * 1000 > WAITING_GRACE_MS) {
    // Work is genuinely sitting there with nothing happening.
    if (beating) return { ...base, state: 'stuck' };
    return { ...base, state: stalled * 1000 >= WAITING_ALARM_MS ? 'silent' : 'stale' };
  }
  if (beating || (actedAgoSec !== null && actedAgoSec * 1000 <= WATCHING_MS)) {
    return { ...base, state: 'watching' };
  }
  // Nothing waiting and nobody talking: resting, not broken.
  return { ...base, state: 'idle' };
}

/** Summaries plus live agent state — what the conversation list actually renders. */
const conversationsWithLiveness = () =>
  conversationSummaries().map((c) => ({ ...c, agentState: agentLiveness(c) }));

// ---------------------------------------------------------------- live stream
/*
 * GET /events is a Server-Sent Events stream: every mutation is pushed to every
 * open page the moment it is durable, so a second device sees a message appear
 * without waiting for its next poll. The payload is the same shape `/thread`
 * returns, so clients merge it with the identical code path.
 *
 * Polling is deliberately kept as the fallback — if the stream drops (or a proxy
 * eats it) the page keeps working exactly as it did before, just less instantly.
 * The comment heartbeat is what stops an idle proxy from closing the connection.
 */
const streams = new Set();
const MAX_STREAMS = 50;
const SSE_PING_MS = 25000; // under the ~100 s idle timeout proxies typically use
const SSE_RETRY_MS = 3000; // client reconnect delay

function push(payload) {
  if (streams.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams) {
    try { res.write(frame); } catch { /* socket already going away; 'close' will evict it */ }
  }
}

/*
 * Every frame names its conversation, so a page showing one conversation can
 * merge its own updates and merely *flag* the others. Deliberately not filtered
 * server-side: one stream carries everything, which is what lets the menu light
 * up for a conversation you are not looking at without a second connection.
 */
function broadcast(taskId) {
  if (streams.size === 0) return;
  const task = tasks.get(taskId);
  if (!task) return;
  push({ now: nowIso(), conversationId: convIdOf(task), entries: entriesOf(task) });
}

function broadcastConv(id) {
  if (streams.size === 0) return;
  const conv = conversations.get(id);
  if (!conv) return;
  push({ now: nowIso(), conversation: conv });
}

function sseRoute(req, res) {
  if (streams.size >= MAX_STREAMS) return fail(res, 503, 'too many live connections');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // ask buffering proxies to pass frames straight through
  });
  if (res.socket) { res.socket.setNoDelay(true); res.socket.setTimeout(0); }
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  res.write(`: connected ${nowIso()}\n\n`);
  streams.add(res);
  // A page opening into an already-stranded state must see it immediately, not
  // on the next tick. Reconnects land here too, so a dropped stream self-heals.
  try {
    res.write(`data: ${JSON.stringify({ now: nowIso(), watch: watchSnapshot() })}\n\n`);
  } catch { /* the close handler below will evict it */ }

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closing */ }
  }, SSE_PING_MS);
  if (ping.unref) ping.unref(); // never hold shutdown open
  const done = () => { clearInterval(ping); streams.delete(res); };
  req.on('close', done);
  res.on('close', done);
  res.on('error', done);
}

// ---------------------------------------------------------------- static UI
let indexCache = null; // { file, mtimeMs, buf } — re-read only when the file changes on disk

function findUiFile() {
  for (const f of UI_FILES) {
    try { return { file: f, mtimeMs: fs.statSync(f).mtimeMs }; } catch { /* try the next one */ }
  }
  return null;
}

function sendIndex(res) {
  const found = findUiFile();
  if (!found) {
    return fail(res, 503, 'UI page not found on disk', { searched: UI_FILES });
  }
  try {
    if (!indexCache || indexCache.file !== found.file || indexCache.mtimeMs !== found.mtimeMs) {
      indexCache = { ...found, buf: fs.readFileSync(found.file) };
    }
  } catch {
    return fail(res, 503, `UI page is unreadable: ${found.file}`);
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': indexCache.buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The page is fully self-contained; this forbids any external request from it.
    // `blob:` in script-src/worker-src is for the inline AudioWorklet used by voice
    // dictation — the worklet source is built into a Blob so the page stays one file.
    // It grants nothing new: the page already runs with 'unsafe-inline'.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline' blob:; worker-src blob:; img-src data:; " +
      "media-src blob: data:; connect-src 'self'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(indexCache.buf);
}

// ---------------------------------------------------------------- speech to text
/*
 * A minimal Wyoming protocol client (github.com/rhasspy/wyoming), enough to ask
 * wyoming-whisper for one transcript. The wire format is a JSON header line
 * ending in \n, then `data_length` bytes of UTF-8 JSON, then `payload_length`
 * bytes of raw audio — in that order:
 *
 *   {"type":"audio-chunk","data":{...},"payload_length":4096}\n<4096 bytes PCM>
 *
 * Both length fields are omitted when absent. We write `data` inline in the
 * header (the reference reader merges it) but must *parse* the separate data
 * block, because the server uses it for its reply. Framing is not
 * self-synchronising: PCM is full of 0x0A, so a "split on newline" reader would
 * corrupt instantly — every byte count is honoured exactly.
 *
 * The engine handles one utterance per connection and closes it after replying.
 */
function wyomingEvent(type, data, payload) {
  const header = { type, data: data || {} };
  if (payload && payload.length) header.payload_length = payload.length;
  const line = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
  return payload && payload.length ? Buffer.concat([line, payload]) : line;
}

/** Returns a feed(chunk) that invokes onEvent(type, data, payload) per decoded event. */
function wyomingDecoder(onEvent) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return; // header line still incomplete
      let header;
      try {
        header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        throw httpErr(502, 'speech engine sent a malformed event header');
      }
      const dLen = header.data_length > 0 ? header.data_length : 0;
      const pLen = header.payload_length > 0 ? header.payload_length : 0;
      const end = nl + 1 + dLen + pLen;
      if (buf.length < end) return; // body still incomplete — wait for more bytes
      const data = Object.assign({}, header.data);
      if (dLen) {
        try {
          Object.assign(data, JSON.parse(buf.subarray(nl + 1, nl + 1 + dLen).toString('utf8')));
        } catch {
          throw httpErr(502, 'speech engine sent a malformed event data block');
        }
      }
      // ASR replies carry no payload; TTS replies are almost entirely payload.
      const payload = pLen ? buf.subarray(nl + 1 + dLen, end) : null;
      buf = buf.subarray(end);
      onEvent(header.type, data, payload);
    }
  };
}

/*
 * One request/response exchange with a Wyoming server. Both engines here are
 * one-shot — send a request, read events until the terminal one, connection
 * closes — so the whole socket lifecycle (connect watchdog, overall deadline,
 * settle-exactly-once, premature close) is identical and lives here. /stt and
 * /tts differ only in what they write and which event ends the exchange.
 *
 * `onEvent(type, data, payload, done)` calls done(value) to resolve.
 */
function wyomingExchange(opts) {
  const { host, port, what, timeoutMs, send, onEvent } = opts;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(
      () => finish(httpErr(504, `${what} did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );

    sock.setTimeout(STT_CONNECT_MS, () => {
      if (sock.connecting) finish(httpErr(504, `${what} at ${host}:${port} did not accept a connection`));
    });
    const feed = wyomingDecoder((type, data, payload) => {
      onEvent(type, data, payload, (value) => finish(null, value));
    });
    sock.on('data', (c) => { try { feed(c); } catch (err) { finish(err); } });
    sock.on('error', (err) =>
      finish(httpErr(502, `cannot reach the ${what} at ${host}:${port} — ${err.message}`)));
    // Only reached if the engine hung up early; a normal close comes after we resolve.
    sock.on('close', () => finish(httpErr(502, `${what} closed the connection without a reply`)));

    sock.on('connect', () => {
      sock.setTimeout(0); // connect watchdog only; inference can legitimately take a while
      send(sock);
    });
  });
}

/** PCM (int16 LE) -> transcript text. Rejects with an httpErr on any failure. */
function transcribe(pcm, fmt) {
  return wyomingExchange({
    host: STT_HOST,
    port: STT_PORT,
    what: 'speech engine',
    timeoutMs: STT_TIMEOUT_MS,
    send(sock) {
      const frame = fmt.width * fmt.channels;
      const audio = { rate: fmt.rate, width: fmt.width, channels: fmt.channels };
      sock.cork();
      sock.write(wyomingEvent('transcribe', STT_LANGUAGE ? { language: STT_LANGUAGE } : {}));
      sock.write(wyomingEvent('audio-start', { ...audio, timestamp: 0 }));
      // rate/width/channels are read unconditionally per chunk by the engine — repeat them.
      for (let off = 0; off < pcm.length; off += STT_CHUNK_BYTES) {
        sock.write(wyomingEvent('audio-chunk', audio, pcm.subarray(off, Math.min(off + STT_CHUNK_BYTES, pcm.length))));
      }
      sock.write(wyomingEvent('audio-stop', { timestamp: Math.round((pcm.length / frame / fmt.rate) * 1000) }));
      sock.uncork();
    },
    onEvent(type, data, payload, done) {
      if (type === 'transcript') done(typeof data.text === 'string' ? data.text : '');
    },
  });
}

/*
 * Text -> spoken audio, via wyoming-piper. The engine answers with `audio-start`
 * (which declares the sample format — piper's own rate, typically 22050 Hz, NOT
 * the 16 kHz the ASR side uses), then a run of `audio-chunk` payloads, then
 * `audio-stop`. Chunks are collected rather than streamed to the client so the
 * response can carry a correct WAV header and content-length, which is what
 * lets the browser decode it without a media-source pipeline.
 */
function synthesize(text) {
  const parts = [];
  let fmt = { rate: 22050, width: 2, channels: 1 }; // sane default if audio-start is skipped
  return wyomingExchange({
    host: TTS_HOST,
    port: TTS_PORT,
    what: 'text-to-speech engine',
    timeoutMs: TTS_TIMEOUT_MS,
    send(sock) {
      const data = { text };
      if (TTS_VOICE) data.voice = { name: TTS_VOICE };
      sock.write(wyomingEvent('synthesize', data));
    },
    onEvent(type, data, payload, done) {
      if (type === 'audio-start') {
        fmt = {
          rate: Number(data.rate) || fmt.rate,
          width: Number(data.width) || fmt.width,
          channels: Number(data.channels) || fmt.channels,
        };
      } else if (type === 'audio-chunk' && payload && payload.length) {
        parts.push(Buffer.from(payload)); // copy: the decoder's buffer is reused
      } else if (type === 'audio-stop') {
        done({ pcm: Buffer.concat(parts), ...fmt });
      }
    },
  });
}

/** A 44-byte canonical RIFF/WAVE header for `bytes` of PCM. */
function wavHeader(bytes, rate, channels, width) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); // 1 = PCM
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * width, 28);
  h.writeUInt16LE(channels * width, 32); h.writeUInt16LE(width * 8, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/** POST /stt — body is raw int16 LE PCM; returns { text }. */
async function sttRoute(req, res, q) {
  const num = (name, dflt, ok) => {
    const raw = q.get(name);
    if (raw === null) return dflt;
    const n = Number(raw);
    if (!ok(n)) throw httpErr(400, `invalid ${name} "${raw}"`);
    return n;
  };
  const fmt = {
    rate: num('rate', 16000, (n) => Number.isInteger(n) && n >= 8000 && n <= 48000),
    width: num('width', 2, (n) => n === 2), // int16 only
    channels: num('channels', 1, (n) => n === 1), // mono only
  };
  const pcm = await readRawBody(req, MAX_AUDIO);
  const frame = fmt.width * fmt.channels;
  if (pcm.length < frame) return fail(res, 400, 'no audio in request body');
  if (pcm.length % frame) return fail(res, 400, `audio is not a whole number of ${frame}-byte frames`);

  const startedAt = Date.now();
  const heard = (await transcribe(pcm, fmt)).trim();
  // Repaired here rather than in the page, so every caller of /stt gets it — and
  // `raw` is returned alongside so the composer can offer a one-tap undo.
  const fixed = repairTranscript(heard);
  send(res, 200, {
    text: fixed.text,
    raw: heard,
    corrections: fixed.corrections,
    audioMs: Math.round((pcm.length / frame / fmt.rate) * 1000),
    tookMs: Date.now() - startedAt,
  });
}

/*
 * POST /tts — { text } in, a WAV out.
 *
 * Deliberately a dumb primitive, exactly like /stt: it speaks what it is given
 * and knows nothing about the conversation. Deciding *what* is worth listening
 * to (stripping URLs, collapsing code blocks) belongs to the page, which is
 * also where it can be seen and tuned.
 *
 * WAV rather than raw PCM because the browser has to decode this: a 44-byte
 * header is the difference between `decodeAudioData` working everywhere and
 * hand-rolling a PCM reader. Content-length is set, so playback can start
 * without a streaming pipeline.
 */
async function ttsRoute(req, res) {
  const body = await readBody(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(res, 400, 'text is required and must be a non-empty string');
  if (text.length > MAX_SPEAK_TEXT) {
    return fail(res, 400, `text too long to speak: ${text.length} chars, max ${MAX_SPEAK_TEXT}`);
  }

  const startedAt = Date.now();
  const audio = await synthesize(text);
  if (!audio.pcm.length) return fail(res, 502, 'the text-to-speech engine returned no audio');

  const wav = Buffer.concat([
    wavHeader(audio.pcm.length, audio.rate, audio.channels, audio.width),
    audio.pcm,
  ]);
  const frame = audio.width * audio.channels;
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': wav.length,
    'cache-control': 'no-store',
    // Handy for the page's status line and for curl-based debugging, since a
    // binary body cannot carry them itself.
    'x-audio-ms': String(Math.round((audio.pcm.length / frame / audio.rate) * 1000)),
    'x-took-ms': String(Date.now() - startedAt),
  });
  res.end(wav);
}

// ---------------------------------------------------------------- status
/*
 * GET /status — "is anything actually listening, or am I typing into a void?"
 *
 * That is the question this answers, and it is a question about TRUST, not
 * statistics. Counts alone are reassurance theatre: a queue with nothing in it
 * looks identical whether the whole agent side is healthy and caught up or has
 * been dead for a day. So the headline combines *liveness* with *backlog*, and
 * "idle, caught up" is never rendered the same way as "nothing is responding".
 *
 * Everything is derived from the task records already in memory and memoised on
 * the mutation counter — this endpoint is polled, and it must never read the
 * event log. Heartbeats live in memory only and are deliberately NOT written to
 * the log: they are ephemeral liveness, not queue state, and one durable line
 * per poll would bury the actual history.
 */
const HEARTBEATS = new Map(); // agent -> { at, note }
const MAX_AGENTS = 20;
const WATCHING_MS = 60 * 1000; // a check-in this recent means *something* is there
const SILENT_MS = 10 * 60 * 1000; // ...and this stale means nothing is
/*
 * Health is judged by whether WORK IS WAITING, not by raw silence. An agent
 * quiet for an hour with an empty conversation is perfectly healthy; an agent
 * quiet for a minute with an unanswered message in front of it is not. Fixed
 * silence thresholds get this exactly backwards and cry wolf at idle.
 */
// Tunable: "too long to wait" is a property of how you work, not a constant. The
// selftest also leans on these to exercise the transitions in seconds.
const WAITING_GRACE_MS = Number(process.env.WAITING_GRACE_MS || 60 * 1000); // normal latency: work this fresh is not a problem
const WAITING_ALARM_MS = Number(process.env.WAITING_ALARM_MS || 5 * 60 * 1000); // work stalled this long is an alarm, not a warning
/*
 * ORPHANED CLAIMS. A task claimed and never answered is the worst kind of
 * failure here, because it is invisible from every angle: a pending-only poll
 * skips it, so no agent will ever pick it up again, and the stall check above
 * misses it too whenever some *other* agent is busy — recent activity makes the
 * queue look healthy while that one task sits abandoned forever. It therefore
 * gets its own trigger rather than relying on the general staleness path.
 */
const STUCK_CLAIM_MS = Number(process.env.STUCK_CLAIM_MS || 15 * 60 * 1000);
const STUCK_ALARM_MS = Number(process.env.STUCK_ALARM_MS || 60 * 60 * 1000);
/*
 * Heartbeats live in memory only, so a restart wipes the whole roster — and this
 * server restarts itself whenever server.js changes, which during development is
 * constantly. For the first minute after boot, "nobody is watching" is far more
 * likely to mean "we just rebooted" than "every agent died", and an alarm that
 * fires every time you save a file is one people train themselves to ignore.
 */
const STARTUP_GRACE_MS = Number(process.env.STARTUP_GRACE_MS || 60 * 1000);
const RECENT_N = 25; // activity rows returned
const SAMPLE_N = 25; // most recent messages used for the timing sample

function heartbeatRoute(res, body) {
  const agent = typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim().slice(0, 100) : 'agent';
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  const at = nowIso();
  HEARTBEATS.set(agent, { at, note });
  // Keep the newest few; a typo in an agent name should not grow forever.
  if (HEARTBEATS.size > MAX_AGENTS) {
    const oldest = [...HEARTBEATS.entries()].sort((a, b) => msOf(a[1].at) - msOf(b[1].at))[0];
    if (oldest) HEARTBEATS.delete(oldest[0]);
  }
  send(res, 200, { ok: true, agent, lastSeen: at });
}

const secSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - msOf(iso)) / 1000)) : null);

function quantiles(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { median: s[Math.floor((s.length - 1) / 2)], worst: s[s.length - 1], samples: s.length };
}

/** Everything that only changes when the queue does. Memoised on `mutations`. */
let derivedCache = { at: -1, value: null };

function derivedStatus() {
  if (derivedCache.at === mutations) return derivedCache.value;

  const activity = [];
  const claimSecs = [];
  const answerSecs = [];
  let oldestWaiting = null;
  let lastMessageAt = null;
  let lastClaimAt = null;
  let lastResultAt = null;

  for (const t of tasks.values()) {
    const conversationId = convIdOf(t);
    const snippet = (v) => asText(v).replace(/\s+/g, ' ').trim().slice(0, 120);

    activity.push({ at: t.ts, kind: 'message', conversationId, who: t.from || null, text: snippet(t.instruction) });
    if (!lastMessageAt || msOf(t.ts) > msOf(lastMessageAt)) lastMessageAt = t.ts;

    if (t.claimedAt) {
      activity.push({ at: t.claimedAt, kind: 'claimed', conversationId, who: t.claimedBy || null, text: snippet(t.instruction) });
      if (!lastClaimAt || msOf(t.claimedAt) > msOf(lastClaimAt)) lastClaimAt = t.claimedAt;
      claimSecs.push({ at: msOf(t.claimedAt), sec: Math.max(0, Math.round((msOf(t.claimedAt) - msOf(t.ts)) / 1000)) });
    }
    if (t.resultTs) {
      activity.push({ at: t.resultTs, kind: 'answered', conversationId, who: t.claimedBy || null, text: snippet(t.result) });
      if (!lastResultAt || msOf(t.resultTs) > msOf(lastResultAt)) lastResultAt = t.resultTs;
      answerSecs.push({ at: msOf(t.resultTs), sec: Math.max(0, Math.round((msOf(t.resultTs) - msOf(t.ts)) / 1000)) });
    }
    if (t.status !== 'done') {
      if (!oldestWaiting || msOf(t.ts) < msOf(oldestWaiting.ts)) oldestWaiting = t;
    }
  }

  activity.sort((a, b) => msOf(b.at) - msOf(a.at));
  const recentOf = (arr) => arr.sort((a, b) => b.at - a.at).slice(0, SAMPLE_N).map((x) => x.sec);

  const value = {
    recent: activity.slice(0, RECENT_N),
    timeToClaim: quantiles(recentOf(claimSecs)),
    timeToAnswer: quantiles(recentOf(answerSecs)),
    oldestWaiting: oldestWaiting ? {
      id: oldestWaiting.id,
      conversationId: convIdOf(oldestWaiting),
      status: oldestWaiting.status,
      ts: oldestWaiting.ts,
      text: asText(oldestWaiting.instruction).replace(/\s+/g, ' ').trim().slice(0, 120),
    } : null,
    lastMessageAt,
    lastClaimAt,
    lastResultAt,
  };
  derivedCache = { at: mutations, value };
  return value;
}

/*
 * Is anyone watching? A heartbeat is the direct answer. Without one we fall back
 * to inference — an agent that claimed or answered something recently is
 * evidently alive — so the page still says something useful even if nobody ever
 * calls /heartbeat.
 */
/*
 * Is anyone actually working?
 *
 * TWO KINDS OF EVIDENCE, AND THEY ARE NOT EQUAL:
 *
 *   - "acted"     — a claim or a result. STRONG. Only an agent that genuinely
 *                   ran and did something can produce one.
 *   - "heartbeat" — a POST. WEAK. Anything with a socket can produce one, and
 *                   in practice it usually comes from a background poll loop,
 *                   which proves the LOOP is ticking and says nothing at all
 *                   about whether the agent is awake.
 *
 * This was learned the hard way: a coordinator hung for eight minutes while the
 * status page cheerfully showed it alive at "0s ago" the entire time, because
 * its heartbeat came from a shell loop. Liveness read healthiest exactly when it
 * was most stuck. So a fresh heartbeat is never treated as proof of health, and
 * the divergence between "last seen" and "last acted" is surfaced explicitly —
 * beating but not acting, with work waiting, is the most misleading state this
 * page can be in and now has a name.
 */
function watchState(derived) {
  const agents = [...HEARTBEATS.entries()]
    .map(([name, h]) => ({ name, lastSeen: h.at, agoSec: secSince(h.at), note: h.note }))
    .sort((a, b) => a.agoSec - b.agoSec);

  const acted = [derived.lastClaimAt, derived.lastResultAt]
    .filter(Boolean)
    .sort((a, b) => msOf(b) - msOf(a))[0] || null;
  const best = agents[0] || null;

  return {
    agents,
    agent: best ? best.name : null,
    // Strong evidence first: what an agent DID beats what it merely said.
    evidence: acted ? 'acted' : (best ? 'heartbeat' : 'none'),
    lastActedAt: acted,
    lastActedAgoSec: secSince(acted),
    lastSeenAt: best ? best.lastSeen : null,
    lastSeenAgoSec: best ? best.agoSec : null,
    // Kept for callers written against the previous shape.
    source: acted ? 'inferred' : (best ? 'heartbeat' : 'none'),
    agoSec: best ? best.agoSec : secSince(acted),
    state: best && best.agoSec * 1000 <= WATCHING_MS ? 'watching'
      : best && best.agoSec * 1000 <= SILENT_MS ? 'stale'
        : best ? 'silent'
          : acted && Date.now() - msOf(acted) <= SILENT_MS ? 'stale' : 'unknown',
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** A duration on its own: "7 min". Use when the sentence supplies "for". */
const humanFor = (sec) => {
  if (sec === null || sec === undefined) return 'a while';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
};
/** A point in the past: "7 min ago". */
const humanAgo = (sec) => (sec === null || sec === undefined ? 'never' : `${humanFor(sec)} ago`);

/*
 * The one line at the top of the page. Levels are deliberately coarse:
 *   ok    — someone is watching. Nothing to do.
 *   idle  — nothing is waiting. Quiet is not broken, and must not look it.
 *   warn  — work is waiting and the watcher is going stale.
 *   alarm — work is waiting and nothing is answering.
 * An empty queue can never reach `alarm`: with nothing to do, an agent that is
 * not checking in is not yet a problem, and crying wolf at 3am is how a status
 * page teaches you to ignore it.
 */
/*
 * Claimed, unanswered, and older than the threshold. Deliberately NOT part of
 * derivedStatus(): that is memoised on the mutation counter, and a task becomes
 * stuck purely by the passage of time, with nothing mutating. Memoising it would
 * mean the orphan is only noticed when something *else* happens — which is
 * exactly the blind spot this is here to close.
 */
function stuckClaims() {
  const now = Date.now();
  const out = [];
  for (const t of tasks.values()) {
    if (t.status !== 'claimed') continue;
    if (t.result !== null && t.result !== undefined) continue;
    const since = msOf(t.claimedAt || t.ts);
    const forSec = Math.round((now - since) / 1000);
    if (forSec * 1000 < STUCK_CLAIM_MS) continue;
    out.push({
      id: t.id,
      conversationId: convIdOf(t),
      claimedBy: t.claimedBy || null,
      claimedAt: t.claimedAt || null,
      stuckForSec: forSec,
      text: asText(t.instruction).slice(0, 120),
    });
  }
  return out.sort((a, b) => b.stuckForSec - a.stuckForSec);
}

function headline(c, watch, derived, stuck) {
  const waiting = c.pending + c.claimed;
  const oldestSec = derived.oldestWaiting ? secSince(derived.oldestWaiting.ts) : null;
  const actedAgo = watch.lastActedAgoSec;
  const seenAgo = watch.lastSeenAgoSec;
  const beating = seenAgo !== null && seenAgo * 1000 <= WATCHING_MS;

  // NOTHING IS WAITING. Quiet is not broken and must never be dressed up as an
  // alarm — with no work to do, an agent that is not talking is simply resting.
  if (!waiting) {
    if (actedAgo !== null && actedAgo * 1000 <= SILENT_MS) {
      return { level: 'ok', text: `All caught up. An agent was working ${humanAgo(actedAgo)}.` };
    }
    if (beating) return { level: 'ok', text: 'All caught up, and an agent is checking in.' };
    return { level: 'idle', text: 'Nothing is waiting.' };
  }

  /*
   * An orphaned claim outranks the general staleness check, and must be tested
   * BEFORE it: the grace window and the "has anything happened lately" test both
   * pass happily while another agent works, and the abandoned task stays hidden
   * behind that healthy-looking activity.
   */
  const orphans = stuck || [];
  if (orphans.length) {
    const worst = orphans[0];
    return {
      level: worst.stuckForSec * 1000 >= STUCK_ALARM_MS ? 'alarm' : 'warn',
      text: `${plural(orphans.length, 'message', 'messages')} claimed but never answered — `
        + `${worst.claimedBy || 'an agent'} took one ${humanAgo(worst.stuckForSec)} and never came back. `
        + `Nothing will pick it up again on its own.`,
    };
  }

  const what = c.pending
    ? `${plural(c.pending, 'message', 'messages')} waiting`
    : `${plural(c.claimed, 'message', 'messages')} being worked on`;

  /*
   * How long has nothing actually HAPPENED while work sits there? Whichever is
   * shorter: how long the oldest item has waited, or how long since an agent
   * last did something. Heartbeats deliberately do not enter this calculation.
   */
  const idle = actedAgo === null ? Infinity : actedAgo;
  const waited = oldestSec === null ? Infinity : oldestSec;
  const stalledRaw = Math.min(idle, waited);
  const stalled = Number.isFinite(stalledRaw) ? stalledRaw : (oldestSec !== null ? oldestSec : 0);

  if (stalled * 1000 <= WAITING_GRACE_MS) return { level: 'ok', text: `${what}.` };

  const level = stalled * 1000 >= WAITING_ALARM_MS ? 'alarm' : 'warn';

  // THE MISLEADING ONE: still checking in, but nothing has actually been done.
  // Worded so it reads as "stuck", never as "fine".
  if (beating) {
    return {
      level,
      text: `${watch.agent || 'An agent'} is still checking in but has done nothing for `
        + `${humanFor(stalled)}, with ${what}. It looks stuck.`,
    };
  }
  if (watch.evidence === 'none') {
    // Still say how long. "No agent has ever checked in" is alarming without a
    // duration attached, and the duration is what tells you whether to act.
    return { level, text: `${what} for ${humanFor(stalled)}, and no agent has ever checked in.` };
  }
  return { level, text: `${what}, and nothing has happened for ${humanFor(stalled)}.` };
}

/*
 * THE DEADMAN.
 *
 * Every other liveness mechanism in this system shares a fate with the thing it
 * watches. A heartbeat loop dies with its agent — one kept reporting "alive"
 * through eight minutes of the agent being asleep. A monitor cannot start a
 * turn, so it cannot wake anything. A session-scoped schedule dies exactly when
 * it would be needed. This process shares a fate with none of them: it is
 * `restart: unless-stopped`, it comes back with Docker, and it runs whether or
 * not any agent exists.
 *
 * The detection has always been here — `headline()` above already knows that
 * work is stranded. What was missing is that it never said so unprompted; it
 * only ever answered when asked. Both times this failed in practice, the user
 * was staring at a thread that looked completely normal. Telling them to go and
 * check a status page asks them to run the diff by hand, which is the same
 * failure as a heartbeat that beats when nobody is home: the information existed
 * and nothing surfaced it.
 *
 * The TIMER is the point. Going stale is the *absence* of events, so a push
 * driven by mutations can never detect it — nothing happening is precisely the
 * signal. So we re-evaluate on a clock and push the verdict at pages.
 *
 * Honest limit: if no page is open, this cannot tell anyone. A real push needs
 * something else. But the page is where the user types, so it covers the case
 * that actually happened.
 */
// How often the verdict is re-evaluated. This is the worst-case delay between
// work going stale and the banner saying so, so it wants to be well under the
// grace window. Tunable mostly so the selftest can drive it in milliseconds.
const WATCH_TICK_MS = Number(process.env.WATCH_TICK_MS || 15000);
let lastWatchLevel = null;

function watchSnapshot() {
  const c = counts();
  const derived = derivedStatus();
  const watch = watchState(derived);
  const stuck = stuckClaims();
  const h = headline(c, watch, derived, stuck);
  /*
   * Never alarm out of a fresh boot. Heartbeats are in-memory and a restart wipes
   * the roster, and this process restarts itself on every source change — so a
   * young uptime makes "nobody is watching" unreliable in exactly the situation
   * where it would fire most often. Note this suppresses the BANNER only:
   * /status still reports the unvarnished headline.
   */
  const starting = Date.now() - STARTED_AT < STARTUP_GRACE_MS;
  return {
    level: h.level,
    text: h.text,
    starting,
    /*
     * Judged on what an agent DID, never on heartbeats — `stalled` in headline()
     * is derived from lastClaimAt/lastResultAt, which are replayed from the event
     * log and therefore survive a restart. Heartbeats do not survive one, and a
     * heartbeat proves only that something is running, not that it is working.
     */
    stuck: stuck.slice(0, 5),
    stuckCount: stuck.length,
    /*
     * `bad` is the entire contract, and it is deliberately derived from
     * headline() rather than recomputed: idle and broken must never look the
     * same, and headline() already guarantees an empty queue can never reach
     * warn/alarm. Crying wolf at a quiet queue is how a banner teaches you to
     * ignore it, which would cost more than it ever saved.
     */
    bad: !starting && (h.level === 'warn' || h.level === 'alarm'),
    waiting: c.pending + c.claimed,
    // What an agent DID. Heartbeats deliberately do not count as acting.
    lastActedAgoSec: watch.lastActedAgoSec,
    at: nowIso(),
  };
}

function pushWatch() {
  if (streams.size === 0) return;
  const snap = watchSnapshot();
  const changed = snap.level !== lastWatchLevel;
  lastWatchLevel = snap.level;
  /*
   * Healthy and unchanged: say nothing. A quiet system should produce a quiet
   * stream. While it is bad we re-push every tick so the wording stays true —
   * "nothing has happened for 7 min" must not still say 7 at twenty.
   */
  if (!changed && !snap.bad) return;
  push({ now: snap.at, watch: snap });
}

/*
 * TCP reachability of the two voice engines, cached — the page may poll this,
 * and opening a socket to each engine on every request would be rude to them
 * and slow for us.
 */
const engineCache = new Map();
const ENGINE_CACHE_MS = 15000;
const ENGINE_TIMEOUT_MS = 1500;

function probeEngine(name, host, port) {
  const hit = engineCache.get(name);
  if (hit && Date.now() - hit.at < ENGINE_CACHE_MS) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      engineCache.set(name, { at: Date.now(), value });
      resolve(value);
    };
    sock.setTimeout(ENGINE_TIMEOUT_MS, () => finish({ ok: false, host, port, error: 'timed out' }));
    sock.on('connect', () => finish({ ok: true, host, port, ms: Date.now() - startedAt }));
    sock.on('error', (err) => finish({ ok: false, host, port, error: err.code || err.message }));
  });
}

async function statusRoute(req, res, q) {
  const c = counts();
  const derived = derivedStatus();
  const watch = watchState(derived);
  const stuck = stuckClaims();
  const body = {
    now: nowIso(),
    headline: headline(c, watch, derived, stuck),
    watch,
    // Claimed and abandoned. Its own list because it is its own failure: these
    // are invisible to a pending-only poll and nothing will ever retry them.
    stuck,
    counts: c,
    server: {
      name: NAME,
      version: VERSION,
      startedAt: new Date(STARTED_AT).toISOString(),
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      streams: streams.size,
      conversations: conversations.size,
      tasks: tasks.size,
    },
    activity: {
      lastMessageAt: derived.lastMessageAt,
      lastMessageAgoSec: secSince(derived.lastMessageAt),
      lastClaimAt: derived.lastClaimAt,
      lastClaimAgoSec: secSince(derived.lastClaimAt),
      lastResultAt: derived.lastResultAt,
      lastResultAgoSec: secSince(derived.lastResultAt),
    },
    responsiveness: {
      timeToClaimSec: derived.timeToClaim,
      timeToAnswerSec: derived.timeToAnswer,
      oldestWaiting: derived.oldestWaiting
        ? { ...derived.oldestWaiting, waitingSec: secSince(derived.oldestWaiting.ts) }
        : null,
    },
    recent: derived.recent,
  };
  // Probing costs a socket to each engine, so it is opt-out for callers that
  // only want the cheap half.
  if (q.get('engines') !== '0' && q.get('engines') !== 'false') {
    const [stt, tts] = await Promise.all([
      probeEngine('stt', STT_HOST, STT_PORT),
      probeEngine('tts', TTS_HOST, TTS_PORT),
    ]);
    body.engines = { stt, tts };
  }
  send(res, 200, body);
}

// ---------------------------------------------------------------- transcript repair
/*
 * The small Whisper model mangles this system's own vocabulary relentlessly.
 * Observed, all from one evening: "Claude" came out as "cloud", as "quad", and —
 * when spelled out letter by letter in frustration — as "C-L-O-U-D-E-U".
 * "mindmeld" became "mind about" and "mine mall". "Alexa" became "a Lexus".
 * "coordinator" became "coordinate or". Three consecutive messages were lost
 * trying to say one word.
 *
 * So transcripts get a repair pass before they become a message. Two things make
 * this safe enough to do at all:
 *
 * 1. IT IS CONSERVATIVE BY CONSTRUCTION. A wrong correction is worse than a
 *    missed one — this text becomes instructions an agent acts on, and silently
 *    rewriting a word the user actually said is a trust problem you only get to
 *    cause once. Corrections come primarily from an explicit list of things
 *    actually heard (stt-terms.json); sound-alike matching only fires when the
 *    pronunciation is long enough to be distinctive, and never over a protected
 *    ordinary word. "cold", "called" and "clot" are all phonetically identical to
 *    "Claude", which is exactly why short terms are never matched by sound.
 * 2. IT IS VISIBLE. The page shows what was changed and offers one tap to undo,
 *    so a bad correction is caught by the user in the composer rather than
 *    discovered later in something an agent already acted on.
 *
 * The dictionary is data, not code: add a term, save, done — the file is
 * re-read when its mtime changes.
 */
const TERMS_FILE = process.env.STT_TERMS_FILE || path.join(__dirname, 'stt-terms.json');
const MAX_SPAN_WORDS = 4; // longest multi-word misfire we will try to match

/*
 * Metaphone, trimmed to what this needs. Maps a word to how it SOUNDS, so
 * "a Lexus" and "Alexa" collide on ALKS and "coordinate or" lands on the same
 * key as "coordinator". Edit distance alone cannot see either of those, because
 * the engine's errors are acoustic, not typographical.
 */
function metaphone(word) {
  let w = String(word).toUpperCase().replace(/[^A-Z]/g, '');
  if (!w) return '';
  w = w.replace(/([^C])\1+/g, '$1'); // collapse doubles, CC excepted
  if (/^(AE|GN|KN|PN|WR)/.test(w)) w = w.slice(1);
  else if (w[0] === 'X') w = 'S' + w.slice(1);
  else if (/^WH/.test(w)) w = 'W' + w.slice(1);

  const V = 'AEIOU';
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const prev = w[i - 1] || '';
    const next = w[i + 1] || '';
    const after = w[i + 2] || '';
    if (V.includes(c)) { if (i === 0) out += c; continue; } // vowels count only first
    switch (c) {
      case 'B': if (!(i === w.length - 1 && prev === 'M')) out += 'B'; break;
      case 'C':
        if (next === 'H') { out += 'X'; i++; }
        else if (next === 'I' && after === 'A') out += 'X';
        else if ('IEY'.includes(next)) out += 'S';
        else out += 'K';
        break;
      case 'D':
        if (next === 'G' && 'IEY'.includes(after)) { out += 'J'; i++; } else out += 'T';
        break;
      case 'G':
        if (next === 'H') { if (i + 2 >= w.length || V.includes(after)) out += 'K'; i++; }
        else if (next === 'N') { /* silent */ }
        else if ('IEY'.includes(next)) out += 'J';
        else out += 'K';
        break;
      case 'H': if (!(V.includes(prev) && !V.includes(next))) out += 'H'; break;
      case 'K': if (prev !== 'C') out += 'K'; break;
      case 'P': if (next === 'H') { out += 'F'; i++; } else out += 'P'; break;
      case 'Q': out += 'K'; break;
      case 'S':
        if (next === 'H') { out += 'X'; i++; }
        else if (next === 'I' && 'OA'.includes(after)) out += 'X';
        else out += 'S';
        break;
      case 'T':
        if (next === 'H') { out += '0'; i++; }
        else if (next === 'I' && 'OA'.includes(after)) out += 'X';
        else out += 'T';
        break;
      case 'V': out += 'F'; break;
      case 'W': case 'Y': if (V.includes(next)) out += c; break;
      case 'X': out += 'KS'; break;
      case 'Z': out += 'S'; break;
      default: out += c; // F J L M N R
    }
  }
  return out.replace(/(.)\1+/g, '$1');
}

const normTerm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
/*
 * "c l o u d e u" and "cloudeu" must reach the same key: when the engine hears a
 * word being spelled out it emits single letters, and joining them back up is
 * what lets the phonetic pass recognise the attempt.
 */
const joinLetters = (s) => s.replace(/\b(?:[a-z]\s+){2,}[a-z]\b/g, (m) => m.replace(/\s+/g, ''));
const phoneticOf = (s) => metaphone(joinLetters(normTerm(s)).replace(/\s+/g, ''));

let termsCache = { mtimeMs: -1, index: null };

function loadTerms() {
  let stat = null;
  try { stat = fs.statSync(TERMS_FILE); } catch { /* no dictionary: repair is a no-op */ }
  if (!stat) return null;
  if (termsCache.mtimeMs === stat.mtimeMs) return termsCache.index;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
  } catch (err) {
    // A typo in the dictionary must never take transcription down with it.
    console.log(`[terms] ${TERMS_FILE} is not valid JSON — transcript repair disabled: ${err.message}`);
    termsCache = { mtimeMs: stat.mtimeMs, index: null };
    return null;
  }

  const exact = new Map(); // normalised heard phrase -> canonical
  const phonetic = new Map(); // distinctive sound -> canonical
  const canonical = new Set(); // already-correct spellings, never touched
  const minLen = Number(raw.minPhoneticLength) || 5;
  const protect = new Set((raw.protect || []).map(normTerm));
  let maxWords = 1;

  for (const entry of raw.terms || []) {
    if (!entry || typeof entry.term !== 'string') continue;
    const term = entry.term.trim();
    if (!term) continue;
    canonical.add(normTerm(term));
    const forms = [term, ...(Array.isArray(entry.heard) ? entry.heard : [])];
    for (const form of forms) {
      const n = normTerm(form);
      if (!n) continue;
      maxWords = Math.max(maxWords, n.split(' ').length);
      // Listed forms are ground truth: they win, and they bypass `protect`.
      if (n !== normTerm(term)) exact.set(n, term);
      const key = phoneticOf(form);
      // Only distinctive sounds may match something that was never listed.
      if (key.length >= minLen && !phonetic.has(key)) phonetic.set(key, term);
    }
  }

  const index = { exact, phonetic, canonical, protect, minLen, maxWords: Math.min(maxWords, MAX_SPAN_WORDS) };
  termsCache = { mtimeMs: stat.mtimeMs, index };
  console.log(`[terms] ${raw.terms ? raw.terms.length : 0} terms, ${exact.size} known mishearings`);
  return index;
}

/** Splits into words, keeping the punctuation around each so it can be rebuilt. */
function splitWords(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const piece = m[0];
    const core = piece.match(/^[^\p{L}\p{N}]*(.*?)[^\p{L}\p{N}]*$/u);
    const body = core ? core[1] : piece;
    const lead = piece.slice(0, piece.indexOf(body));
    out.push({ raw: piece, lead, body, tail: piece.slice(lead.length + body.length), norm: normTerm(body) });
  }
  return out;
}

/**
 * Repairs known vocabulary in a transcript.
 * Returns { text, corrections:[{from,to,how}] } and never throws.
 */
function repairTranscript(text) {
  const idx = loadTerms();
  if (!idx || typeof text !== 'string' || !text.trim()) return { text, corrections: [] };

  const words = splitWords(text);
  const corrections = [];
  const out = [];

  for (let i = 0; i < words.length;) {
    let hit = null;
    let keep = 0; // words to emit untouched, because a longer phrase claimed them
    // Longest span first: "cloud flare" must become Cloudflare, not "Claude flare".
    for (let n = Math.min(idx.maxWords, words.length - i); n >= 1; n--) {
      const span = words.slice(i, i + n);
      const phrase = span.map((w) => w.norm).filter(Boolean).join(' ');
      if (!phrase) continue;
      /*
       * Tested before any correction, and it claims the WHOLE span. An ordinary
       * phrase that merely contains a known mishearing has to survive intact:
       * "cloud nine" must not become "Claude nine" just because "cloud" is
       * listed. Same for anything already spelled correctly.
       */
      if (idx.canonical.has(phrase) || idx.protect.has(phrase)) { keep = n; break; }

      const listed = idx.exact.get(phrase);
      if (listed) { hit = { term: listed, n, how: 'known mishearing' }; break; }

      // Sound-alike: only for pronunciations distinctive enough to be safe.
      // "cold", "called" and "clot" all sound exactly like "Claude", so anything
      // this short is corrected from the explicit list or not at all.
      const key = phoneticOf(phrase);
      if (key.length < idx.minLen) continue;
      const sounds = idx.phonetic.get(key);
      if (sounds && normTerm(sounds) !== phrase) { hit = { term: sounds, n, how: 'sounds identical' }; break; }
    }

    if (keep) {
      for (let k = 0; k < keep; k++) out.push(words[i + k].raw);
      i += keep;
      continue;
    }
    if (!hit) { out.push(words[i].raw); i++; continue; }

    const span = words.slice(i, i + hit.n);
    corrections.push({
      from: span.map((w) => w.body).join(' '),
      to: hit.term,
      how: hit.how,
    });
    out.push(span[0].lead + hit.term + span[span.length - 1].tail);
    i += hit.n;
  }

  return { text: out.join(' '), corrections };
}

// ---------------------------------------------------------------- client log
/*
 * POST /client-log — write one line to stdout, visible in `docker logs relay-queue`.
 *
 * The UI's real home is a phone, where nobody can open a devtools console, so a
 * failure there is otherwise invisible: "the mic did nothing" is not something
 * anyone can debug. This is diagnostics only — nothing is stored, nothing enters
 * the event log, and it cannot affect the queue in any way.
 */
const CLIENT_LOG_FIELD = 300; // chars kept per field
const CLIENT_LOG_PER_MIN = 60;
let clientLogBudget = CLIENT_LOG_PER_MIN;
setInterval(() => { clientLogBudget = CLIENT_LOG_PER_MIN; }, 60000).unref();

function clientLogRoute(res, body) {
  if (clientLogBudget <= 0) return send(res, 429, { ok: false, error: 'rate limited' });
  clientLogBudget--;
  // Untrusted text goes to a terminal: flatten newlines and control characters so
  // it cannot forge extra log lines or smuggle escape sequences.
  const clean = (v) => String(v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, CLIENT_LOG_FIELD);
  console.log(`[client] ${clean(body.event) || 'log'} — ${clean(body.detail)} — url=${clean(body.url)} ua=${clean(body.ua)}`);
  send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- handlers
function createTask(res, body) {
  // `text` is the UI's field name and an alias for `instruction`; both are accepted.
  const instruction = typeof body.text === 'string' ? body.text : body.instruction;
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return fail(res, 400, 'instruction (alias: text) is required and must be a non-empty string');
  }
  if (instruction.length > MAX_TEXT) {
    return fail(res, 400, `message too long: ${instruction.length} chars, max ${MAX_TEXT}`);
  }
  // Omitting conversationId puts the message in the default conversation, which
  // is what every call written before conversations existed does.
  const conversationId = typeof body.conversationId === 'string' && body.conversationId
    ? body.conversationId
    : (typeof body.conversation === 'string' && body.conversation ? body.conversation : DEFAULT_CONV);
  if (!conversations.has(conversationId)) {
    return fail(res, 400, `no conversation with id "${conversationId}"`, { conversationId });
  }
  const task = {
    id: newId(),
    role: DEFAULT_ROLE, // server-set, never taken from the client
    conversationId,
    instruction,
    from: typeof body.from === 'string' && body.from ? body.from : null,
    ts: nowIso(),
    status: 'pending',
    claimedBy: null,
    claimedAt: null,
    result: null,
    resultTs: null,
    relayed: false,
    relayedAt: null,
  };
  appendEvent({ t: 'create', task });
  send(res, 201, task);
}

function claimTask(res, id, body) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  if (task.status !== 'pending') {
    return fail(res, 409, `task is already ${task.status}`, { status: task.status, id: task.id });
  }
  const patch = {
    status: 'claimed',
    claimedBy: typeof body.by === 'string' && body.by ? body.by : null,
    claimedAt: nowIso(),
  };
  appendEvent({ t: 'patch', id, patch });
  send(res, 200, task);
}

function resultTask(res, id, body) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  if (task.status === 'done') {
    return fail(res, 409, 'task already has a result', { status: task.status, id: task.id });
  }
  if (!('result' in body)) return fail(res, 400, 'result is required');
  // Without this, `{"result": null}` produces a task that is `done` carrying no
  // answer — which the relayed guard then (correctly) refuses to close, leaving
  // the message permanently unanswerable. Refuse it here, where it is fixable.
  if (body.result === null) {
    return fail(res, 400, 'result is null: a null answer is not an answer. Send the text the human should read.');
  }
  // A result may be posted straight to a pending task; no claim required.
  appendEvent({ t: 'patch', id, patch: { status: 'done', result: body.result, resultTs: nowIso() } });
  send(res, 200, task);
}

/*
 * Conversations. The write path is the same append-only, fsync-before-response
 * event log every other mutation uses — there is no second store.
 *
 * `agent` is the field the agent side owns: it names whoever is meant to answer
 * in this conversation. relay-queue never acts on it and never spawns anything;
 * it is a passive queue, and this is a place to record routing that something
 * else decides. `assignee` is accepted as an alias for it.
 */
function createConversation(res, body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return fail(res, 400, 'title is required and must be a non-empty string');
  if (title.length > MAX_TITLE) {
    return fail(res, 400, `title too long: ${title.length} chars, max ${MAX_TITLE}`);
  }
  const agent = readAgent(body);
  if (agent instanceof Error) return fail(res, 400, agent.message);
  const conv = newConversation(newId(conversations), title, agent);
  appendEvent({ t: 'conv', conv });
  send(res, 201, conv);
}

function readAgent(body) {
  const raw = body.agent !== undefined ? body.agent : body.assignee;
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null; // explicit unassign
  if (typeof raw !== 'string') return new Error('agent must be a string or null');
  if (raw.length > MAX_AGENT) return new Error(`agent too long: ${raw.length} chars, max ${MAX_AGENT}`);
  return raw;
}

function updateConversation(res, id, body) {
  const conv = conversations.get(id);
  if (!conv) return fail(res, 404, `no conversation with id "${id}"`);
  const patch = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return fail(res, 400, 'title must be a non-empty string');
    }
    if (body.title.length > MAX_TITLE) {
      return fail(res, 400, `title too long: ${body.title.length} chars, max ${MAX_TITLE}`);
    }
    patch.title = body.title.trim();
  }

  const agent = readAgent(body);
  if (agent instanceof Error) return fail(res, 400, agent.message);
  if (agent !== undefined) patch.agent = agent;

  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return fail(res, 400, 'archived must be true or false');
    // The default conversation is where every pre-conversation message lives and
    // where an omitted conversationId lands, so it cannot be archived away.
    if (body.archived && id === DEFAULT_CONV) {
      return fail(res, 400, `the default conversation "${DEFAULT_CONV}" cannot be archived`);
    }
    patch.archived = body.archived;
    patch.archivedAt = body.archived ? nowIso() : null;
  }

  if (!Object.keys(patch).length) return fail(res, 400, 'nothing to update (title, agent or archived)');
  appendEvent({ t: 'convpatch', id, patch });
  send(res, 200, conv);
}

/*
 * `relayed` means "this has been delivered to whoever it was for". A task with
 * no result has not been answered, so there is nothing to deliver, and flagging
 * it closes the human's question with silence — permanently, since the thread
 * offers no way to notice a message that is marked done.
 *
 * On the night of 2026-08-07 this happened four times. The shape every time: an
 * agent chained the result POST and the relayed POST in one command, the result
 * POST failed (400, a malformed body), the relayed POST succeeded anyway, and
 * the question was left `result: null, relayed: true`. Nobody would ever have
 * been told. Client-side ordering discipline was the only thing standing in the
 * way, and discipline is not a mechanism — so the server refuses instead.
 */
function relayTask(res, id) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  if (!task.relayed) {
    // Only the false -> true transition is guarded; re-flagging an already
    // relayed task stays idempotent, including for records written before this.
    if (task.result === null || task.result === undefined) {
      return fail(res, 409, 'cannot mark relayed: this task has no result, so there is nothing to deliver. POST /tasks/:id/result first, and check that it returned 200 before flagging.', {
        id: task.id,
        status: task.status,
        relayed: task.relayed,
      });
    }
    appendEvent({ t: 'patch', id, patch: { relayed: true, relayedAt: nowIso() } });
  }
  send(res, 200, task); // idempotent: re-flagging keeps the original relayedAt
}

// ---------------------------------------------------------------- router
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = url.searchParams;
  const m = req.method;
  const need = (want) => {
    if (m === want) return true;
    fail(res, 405, `method ${m} not allowed here`, { allow: want });
    return false;
  };

  // / — the mobile web UI
  if (seg.length === 0) {
    if (!need('GET')) return;
    return sendIndex(res);
  }

  // /health
  if (seg.length === 1 && seg[0] === 'health') {
    if (!need('GET')) return;
    return send(res, 200, {
      status: 'ok',
      name: NAME,
      version: VERSION,
      counts: counts(),
      conversations: conversations.size,
      streams: streams.size,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  }

  // /tasks
  if (seg.length === 1 && seg[0] === 'tasks') {
    if (m === 'GET') {
      const list = applyFilters([...tasks.values()], q);
      return send(res, 200, { count: list.length, tasks: list });
    }
    if (m === 'POST') return createTask(res, await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /conversations
  if (seg.length === 1 && seg[0] === 'conversations') {
    if (m === 'GET') {
      let list = conversationsWithLiveness();
      // Archived ones are hidden unless asked for; `archived=only` shows just them.
      const archived = q.get('archived');
      if (archived === 'only') list = list.filter((c) => c.archived);
      else if (archived === null || archived === 'false' || archived === '0') list = list.filter((c) => !c.archived);
      // `pending=1` is the agent side's question: where is there work waiting?
      const pending = q.get('pending');
      if (pending !== null && pending !== 'false' && pending !== '0') {
        list = list.filter((c) => c.counts.pending > 0);
      }
      const unread = q.get('unread');
      if (unread !== null && unread !== 'false' && unread !== '0') {
        list = list.filter((c) => c.counts.unrelayed > 0);
      }
      return send(res, 200, { count: list.length, defaultId: DEFAULT_CONV, conversations: list });
    }
    if (m === 'POST') return createConversation(res, await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /conversations/:id
  if (seg.length === 2 && seg[0] === 'conversations') {
    if (m === 'GET') {
      const found = conversationsWithLiveness().find((c) => c.id === seg[1]);
      if (!found) return fail(res, 404, `no conversation with id "${seg[1]}"`);
      return send(res, 200, found);
    }
    if (m === 'POST') return updateConversation(res, seg[1], await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /status — is anything actually listening?
  if (seg.length === 1 && seg[0] === 'status') {
    if (!need('GET')) return;
    return statusRoute(req, res, q);
  }

  // /heartbeat — an agent saying "I am here". In memory only, never logged.
  if (seg.length === 1 && seg[0] === 'heartbeat') {
    if (!need('POST')) return;
    return heartbeatRoute(res, await readBody(req));
  }

  // /watch — just the deadman verdict. Deliberately separate from /status: this
  // one is polled as a fallback and must stay cheap, with no engine probes.
  if (seg.length === 1 && seg[0] === 'watch') {
    if (!need('GET')) return;
    return send(res, 200, watchSnapshot());
  }

  // /client-log — one diagnostic line from the browser into the container log
  if (seg.length === 1 && seg[0] === 'client-log') {
    if (!need('POST')) return;
    return clientLogRoute(res, await readBody(req));
  }

  // /events — Server-Sent Events push of every change
  if (seg.length === 1 && seg[0] === 'events') {
    if (!need('GET')) return;
    return sseRoute(req, res);
  }

  // /stt — raw PCM in, transcript out (relayed to the Wyoming ASR engine)
  if (seg.length === 1 && seg[0] === 'stt') {
    if (!need('POST')) return;
    return sttRoute(req, res, q);
  }

  // /tts — text in, spoken WAV out (relayed to the Wyoming TTS engine)
  if (seg.length === 1 && seg[0] === 'tts') {
    if (!need('POST')) return;
    return ttsRoute(req, res);
  }

  // /results
  if (seg.length === 1 && seg[0] === 'results') {
    if (!need('GET')) return;
    const done = [...tasks.values()].filter((t) => t.status === 'done');
    const list = applyFilters(done, q);
    return send(res, 200, { count: list.length, tasks: list });
  }

  // /thread — chronological human + agent view; `since` filters on `rev`, `limit` takes the LAST N
  if (seg.length === 1 && seg[0] === 'thread') {
    if (!need('GET')) return;
    const conv = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
    let list = threadEntries(conv || null); // no filter = the whole queue, as before

    const since = q.get('since');
    if (since !== null) {
      const sinceMs = parseSince(since);
      if (sinceMs === null) throw httpErr(400, `invalid since "${since}" (want ISO 8601 or epoch ms)`);
      list = list.filter((e) => Date.parse(e.rev) > sinceMs); // strictly after
    }

    const limit = q.get('limit');
    if (limit !== null) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 0) throw httpErr(400, `invalid limit "${limit}"`);
      list = n === 0 ? [] : list.slice(-n); // most recent N — a thread is read from the end
    }
    return send(res, 200, { count: list.length, now: nowIso(), entries: list });
  }

  // /tasks/:id/(claim|result|relayed)
  if (seg.length === 3 && seg[0] === 'tasks') {
    const [, id, action] = seg;
    if (action === 'claim' || action === 'result' || action === 'relayed') {
      if (!need('POST')) return;
      const body = await readBody(req);
      if (action === 'claim') return claimTask(res, id, body);
      if (action === 'result') return resultTask(res, id, body);
      return relayTask(res, id);
    }
  }

  // /tasks/:id
  if (seg.length === 2 && seg[0] === 'tasks') {
    if (!need('GET')) return;
    const task = tasks.get(seg[1]);
    if (!task) return fail(res, 404, `no task with id "${seg[1]}"`);
    return send(res, 200, task);
  }

  fail(res, 404, `no route for ${m} ${url.pathname}`);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const code = Number(err && err.code) || 500;
    if (res.headersSent) return res.destroy();
    fail(res, code >= 400 && code < 600 ? code : 500, String((err && err.message) || 'internal error'));
  });
});

// ---------------------------------------------------------------- boot
/*
 * Pure helpers are exported so they can be unit-tested without standing a server
 * up. Everything with a side effect below is behind the `require.main` guard, so
 * `require('./server.js')` gives you the functions and nothing else — no port
 * bound, no data directory touched, no timers running.
 */
module.exports = { repairTranscript, metaphone, headline, stuckClaims };

if (require.main !== module) return;

fs.mkdirSync(DATA_DIR, { recursive: true });
ensureDefaultConv(); // before replay, so a rename of it replays onto something
const replayed = replay();
ensureDefaultConv(); // ...and after, in case the log somehow removed it
server.listen(PORT, HOST, () => {
  const c = counts();
  console.log(`${NAME} v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`log: ${LOG_FILE} (${replayed.events} events replayed, ${replayed.skipped} skipped)`);
  const ui = findUiFile();
  console.log(ui ? `ui:  ${ui.file}` : `ui:  MISSING — searched ${UI_FILES.join(', ')}`);
  console.log(`tasks: ${tasks.size} total — ${c.pending} pending, ${c.claimed} claimed, ${c.done} done, ${c.unrelayed} unrelayed`);
});

// The deadman's clock. Stale work is the absence of events, so only a timer can
// find it. unref'd: it must never be the reason the process stays up.
setInterval(pushWatch, WATCH_TICK_MS).unref();

// Every write is already fsynced, so shutdown just needs to stop accepting.
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const res of streams) { try { res.end(); } catch { /* already gone */ } }
  streams.clear();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref(); // don't hang on keep-alive sockets
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

// ---------------------------------------------------------------- self-restart
/*
 * Exit when our own source file changes; `restart: unless-stopped` starts us
 * again a second later running the new code, and replaying the event log makes
 * that lossless. Combined with the sync sidecar that fast-forwards origin/main,
 * a merge on GitHub deploys itself here with no Docker socket and no hooks.
 *
 * Two watchers on purpose. fs.watch is instant where inotify works but does not
 * fire reliably across a Windows bind mount, so fs.watchFile's mtime poll is the
 * guaranteed backstop; whichever notices first wins. The UI needs none of this —
 * public/index.html is re-read whenever its mtime changes.
 */
const WATCH_SOURCE = process.env.WATCH_SOURCE !== '0';
const WATCH_POLL_MS = Number(process.env.WATCH_POLL_MS || 2000);
const WATCH_SETTLE_MS = 300; // let a multi-write save land before acting

function watchSelf() {
  const self = __filename;
  const reload = (how) => {
    if (stopping) return;
    stopping = true; // claim the exit; the timer below finishes the job
    console.log(`${self} changed (${how}) — exiting so the supervisor restarts us`);
    setTimeout(() => { stopping = false; shutdown(0); }, WATCH_SETTLE_MS).unref();
  };
  try {
    fs.watch(self, { persistent: false }, () => reload('fs.watch'));
  } catch { /* unsupported on this filesystem; the mtime poll still covers us */ }
  fs.watchFile(self, { interval: WATCH_POLL_MS }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) reload('mtime poll');
  });
}
if (WATCH_SOURCE) watchSelf();
