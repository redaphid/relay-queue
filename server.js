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
const VERSION = '1.2.0';
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
const STARTED_AT = Date.now();
const STATUSES = ['pending', 'claimed', 'done'];
const DEFAULT_ROLE = 'user'; // records written before roles existed are the human's messages

// ---------------------------------------------------------------- event log
/** @type {Map<string, object>} id -> task (insertion order == creation order) */
const tasks = new Map();
let logFd = null;

function applyEvent(ev) {
  if (ev.t === 'create') {
    // Records logged before `role` existed replay as the human's messages.
    if (ev.task.role !== 'agent') ev.task.role = DEFAULT_ROLE;
    tasks.set(ev.task.id, ev.task);
  } else if (ev.t === 'patch') {
    const task = tasks.get(ev.id);
    if (task) Object.assign(task, ev.patch);
  }
}

function appendEvent(ev) {
  if (logFd === null) logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, JSON.stringify(ev) + '\n');
  try {
    fs.fsyncSync(logFd); // best effort; some bind-mounted FSes reject fsync
  } catch { /* the write itself already left our process buffers */ }
  applyEvent(ev);
  broadcast(ev.t === 'create' ? ev.task.id : ev.id); // push to live pages, post-durability
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

function newId() {
  let id;
  do {
    id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  } while (tasks.has(id));
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
  const out = [{
    id: t.id,
    role: t.role === 'agent' ? 'agent' : 'user',
    text: asText(t.instruction),
    ts: t.ts,
    status: t.status,
    rev: new Date(revMs).toISOString(),
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
    });
  }
  return out;
}

function threadEntries() {
  const out = [];
  for (const t of tasks.values()) out.push(...entriesOf(t));
  // Stable sort: a reply is pushed after its parent, so equal timestamps keep order.
  return out.sort((a, b) => msOf(a.ts) - msOf(b.ts));
}

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

function broadcast(taskId) {
  if (streams.size === 0) return;
  const task = tasks.get(taskId);
  if (!task) return;
  const frame = `data: ${JSON.stringify({ now: nowIso(), entries: entriesOf(task) })}\n\n`;
  for (const res of streams) {
    try { res.write(frame); } catch { /* socket already going away; 'close' will evict it */ }
  }
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

/** Returns a feed(chunk) that invokes onEvent(type, data) per decoded event. */
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
      buf = buf.subarray(end); // payload bytes (if any) are skipped: replies carry none
      onEvent(header.type, data);
    }
  };
}

/** PCM (int16 LE) -> transcript text. Rejects with an httpErr on any failure. */
function transcribe(pcm, fmt) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: STT_HOST, port: STT_PORT });
    let settled = false;
    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(text);
    };
    const timer = setTimeout(
      () => finish(httpErr(504, `speech engine did not answer within ${STT_TIMEOUT_MS} ms`)),
      STT_TIMEOUT_MS,
    );

    sock.setTimeout(STT_CONNECT_MS, () => {
      if (sock.connecting) finish(httpErr(504, `speech engine at ${STT_HOST}:${STT_PORT} did not accept a connection`));
    });
    const feed = wyomingDecoder((type, data) => {
      if (type === 'transcript') finish(null, typeof data.text === 'string' ? data.text : '');
    });
    sock.on('data', (c) => { try { feed(c); } catch (err) { finish(err); } });
    sock.on('error', (err) =>
      finish(httpErr(502, `cannot reach the speech engine at ${STT_HOST}:${STT_PORT} — ${err.message}`)));
    // Only reached if the engine hung up early; a normal close comes after we resolve.
    sock.on('close', () => finish(httpErr(502, 'speech engine closed the connection without a transcript')));

    sock.on('connect', () => {
      sock.setTimeout(0); // connect watchdog only; inference can legitimately take a while
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
    });
  });
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
  const text = await transcribe(pcm, fmt);
  send(res, 200, {
    text: text.trim(),
    audioMs: Math.round((pcm.length / frame / fmt.rate) * 1000),
    tookMs: Date.now() - startedAt,
  });
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
  const task = {
    id: newId(),
    role: DEFAULT_ROLE, // server-set, never taken from the client
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
  // A result may be posted straight to a pending task; no claim required.
  appendEvent({ t: 'patch', id, patch: { status: 'done', result: body.result, resultTs: nowIso() } });
  send(res, 200, task);
}

function relayTask(res, id) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  if (!task.relayed) {
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
    let list = threadEntries();

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
fs.mkdirSync(DATA_DIR, { recursive: true });
const replayed = replay();
server.listen(PORT, HOST, () => {
  const c = counts();
  console.log(`${NAME} v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`log: ${LOG_FILE} (${replayed.events} events replayed, ${replayed.skipped} skipped)`);
  const ui = findUiFile();
  console.log(ui ? `ui:  ${ui.file}` : `ui:  MISSING — searched ${UI_FILES.join(', ')}`);
  console.log(`tasks: ${tasks.size} total — ${c.pending} pending, ${c.claimed} claimed, ${c.done} done, ${c.unrelayed} unrelayed`);
});

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
