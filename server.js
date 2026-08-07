'use strict';
/*
 * relay-queue — minimal durable local-only HTTP task queue.
 * Zero runtime dependencies. Node built-ins only. Run: node server.js
 *
 * Durability: every mutation is appended to data/events.jsonl (write + fsync)
 * BEFORE the HTTP response is sent, then replayed into memory on boot.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'relay-queue';
const VERSION = '1.0.0';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3901);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_BODY = 1024 * 1024; // 1 MiB
const STARTED_AT = Date.now();

const STATUSES = ['pending', 'claimed', 'done'];

// ---------------------------------------------------------------- event log

/** @type {Map<string, object>} id -> task (insertion order == creation order) */
const tasks = new Map();
let logFd = null;

function applyEvent(ev) {
  if (ev.t === 'create') {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('body must be a JSON object'), { code: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('malformed JSON body'), { code: 400 }));
      }
    });
    req.on('error', () => reject(Object.assign(new Error('request stream error'), { code: 400 })));
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
    if (!STATUSES.includes(status)) {
      throw Object.assign(new Error(`invalid status "${status}"`), { code: 400 });
    }
    list = list.filter((t) => t.status === status);
  }

  const unread = q.get('unread');
  if (unread !== null && unread !== 'false') list = list.filter((t) => t.relayed === false);

  const since = q.get('since');
  if (since !== null) {
    const ms = parseSince(since);
    if (ms === null) {
      throw Object.assign(new Error(`invalid since "${since}" (want ISO 8601 or epoch ms)`), { code: 400 });
    }
    list = list.filter((t) => Date.parse(t.ts) > ms); // strictly after
  }

  const limit = q.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 0) {
      throw Object.assign(new Error(`invalid limit "${limit}"`), { code: 400 });
    }
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

// ---------------------------------------------------------------- handlers

function createTask(res, body) {
  const instruction = body.instruction;
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return fail(res, 400, 'instruction is required and must be a non-empty string');
  }
  const task = {
    id: newId(),
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
  console.log(`tasks: ${tasks.size} total — ${c.pending} pending, ${c.claimed} claimed, ${c.done} done, ${c.unrelayed} unrelayed`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      if (logFd !== null) try { fs.closeSync(logFd); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
