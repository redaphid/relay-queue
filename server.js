'use strict';
/*
 * relay-queue — minimal durable local-only HTTP task queue. Run: node server.js
 * Zero runtime dependencies. Every mutation is appended to data/events.jsonl
 * (write + fsync) BEFORE the response is sent, then replayed into memory on boot.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'relay-queue';
const VERSION = '1.1.0';
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

function threadEntries() {
  const out = [];
  for (const t of tasks.values()) {
    const createdMs = msOf(t.ts);
    const revMs = Math.max(createdMs, msOf(t.claimedAt), msOf(t.resultTs));
    out.push({
      id: t.id,
      role: t.role === 'agent' ? 'agent' : 'user',
      text: asText(t.instruction),
      ts: t.ts,
      status: t.status,
      rev: new Date(revMs).toISOString(),
    });
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
  }
  // Stable sort: a reply is pushed after its parent, so equal timestamps keep order.
  return out.sort((a, b) => msOf(a.ts) - msOf(b.ts));
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
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline'; img-src data:; connect-src 'self'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(indexCache.buf);
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
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref(); // don't hang on keep-alive sockets
});
