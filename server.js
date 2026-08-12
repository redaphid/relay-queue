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
const crypto = require('node:crypto');
// The home-screen icons, drawn and PNG-encoded rather than committed as blobs.
const icons = require('./icons.js');

const NAME = 'relay-queue';
const VERSION = '1.5.0';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3901);
/*
 * A one-shot token a test harness passes in, echoed back on /health.
 *
 * The harness learns WHERE its child is from the "listening on" line the child
 * prints below. This answers the other half: whether the server ANSWERING at
 * that address is still that child. A harness whose child died at birth
 * otherwise interrogates whoever else holds the port and reports the findings
 * as fact. Unset in production, where it reads as null. See
 * tools/harness-lib.js.
 */
const BOOT_NONCE = process.env.RELAY_BOOT_NONCE || null;
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

/*
 * AGENT MESSAGES AND THE INTERNAL CHANNEL.
 *
 * `POST /tasks` sets `role` itself and always to "user", so an agent had no way
 * to say anything unprompted: it had to post a task *as the human* and then
 * answer itself, putting both halves in his thread. 36 of the 312 messages on
 * the night of 2026-08-07 were that workaround, and 19 of them were agents
 * talking to each other, routed through his phone because there was nowhere
 * else to put it.
 *
 * `POST /messages` is that missing route. A message is an ordinary task record
 * in the one append-only log — no second store, no second write path — with
 * `role: "agent"` and, critically, `status: "done"`: it is a statement, not a
 * request, so it must never sit `pending` where it would trip the poster's own
 * watcher and read as work waiting.
 *
 * `visibility: "internal"` is the agent-to-agent channel. The rule for it is
 * exclusion by default, everywhere: an internal message is filtered out of
 * every pre-existing read path — the thread, the task list, the conversation
 * summaries, the counts, the status feed, the live stream — and is visible only
 * to a caller that asks for it by channel. That direction matters. If a new
 * filter is ever missed, the failure is that agents cannot see their own
 * traffic, not that it lands on the user's phone.
 */
const DEFAULT_CHANNEL = 'agents';
const MAX_CHANNEL = 100;
const MAX_AUTHOR = 200;
/*
 * An internal message still carries a conversationId, because every projection
 * in this file reads one. It is `#<channel>`, and the `#` is what makes it safe:
 * real ids are either the literal "main" or a generated base36 pair, so a
 * `#`-prefixed id can never name a real conversation, and `POST /tasks` refuses
 * it for the same reason it refuses any unknown conversation. Belt and braces —
 * the visibility filters are the actual guarantee.
 */
const INTERNAL_PREFIX = '#';
const isInternal = (t) => t.visibility === 'internal';
const channelOf = (t) => (typeof t.channel === 'string' && t.channel ? t.channel : DEFAULT_CHANNEL);

// --- web push --------------------------------------------------------------
/*
 * The only path that reaches him when the tab is closed.
 *
 * Everything before this could shout only at a page he was already looking at,
 * which is exactly when he does not need shouting at. Delivery goes
 *   this server -> Mozilla autopush / Google FCM -> his phone
 * so it never traverses relay.hypnodroid.com, and Cloudflare Access is not in
 * the path. See push.js for the specs and for why the crypto is hand-rolled.
 *
 * Three categories, deliberately: more than three or four is unlearnable by
 * feel, and the whole point is that he can tell what happened without looking.
 */
const wp = require('./push.js');

const PUSH_ON = process.env.PUSH !== '0';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:relay@hypnodroid.com';
const KEYS_FILE = path.join(DATA_DIR, 'push-keys.json');
const MAX_SUBS = 20;
const MAX_PUSH_BODY = 140; // chars of preview; the rest is on the page
/*
 * The hourly ceiling — the last line of defence, not the first. It was 20,
 * which is far too generous for his bar: the 16 "done" pushes of 2026-08-08
 * fit inside it comfortably and `suppressedBudget` stayed 0, so the ceiling
 * never fired once during the incident it should have caught. 6 an hour is
 * about the most a human wants from a channel he cannot walk away from. The
 * env override is intact for an operator who disagrees.
 */
const PUSH_PER_HOUR = Number(process.env.PUSH_PER_HOUR || 6);

const CATEGORIES = ['needs-you', 'done', 'broken'];
const NOTIFY_VALUES = new Set([...CATEGORIES, 'none']);
/*
 * How long to sit on a notification before sending. This is the anti-spam
 * mechanism and it does three jobs at once: it collapses a burst into one buzz,
 * it lets a "needs-you" be cancelled by its own answer arriving (the documented
 * post-a-task-then-answer-it pattern would otherwise buzz him twice for one
 * unprompted update), and it costs no latency he would notice on a phone.
 */
const PUSH_DEBOUNCE_MS = { 'needs-you': 15000, done: 15000, broken: 3000 };
// One knob for all three, for tests and for an operator who wants it snappier.
const PUSH_DEBOUNCE_OVERRIDE = Number(process.env.PUSH_DEBOUNCE_MS || 0) || null;
const PUSH_TTL_SEC = { 'needs-you': 6 * 3600, done: 6 * 3600, broken: 3600 };
const PUSH_URGENCY = { 'needs-you': 'high', done: 'normal', broken: 'high' };
/*
 * The page labels its own posts, so this is how "he typed it" is told apart
 * from "an agent handed him something". Never buzz the phone that sent it.
 *
 * ADDING A UI ACTION? ADD ITS ORIGIN HERE, IN THE SAME COMMIT.
 *
 * This is an allowlist whose default is *notify*, which makes forgetting it
 * silent and self-inflicted rather than merely wrong. `checklist` was missing:
 * ticking a box on his own phone posts a task with from:'checklist', fell
 * through to `return 'needs-you'`, and pushed a notification back at the very
 * phone that had just sent it. He ticked a box and got buzzed about it, by
 * himself. Every future UI origin will do exactly the same until it is listed.
 *
 * The safer shape is the inverse — treat everything as his unless it is a known
 * agent — but `from` is a free-text field that agents also set, so there is no
 * reliable way to invert it today. Hence the shouting comment.
 */
const PAGE_ORIGINS = new Set(['web', 'voice', 'voice-conversation', 'checklist']);

/** @type {Map<string, object>} id -> { id, endpoint, p256dh, auth, ua, label, createdAt } */
const subscriptions = new Map();
let pushConfig = {
  // UTC by default, and shown as such: an unset zone must *look* unset rather
  // than pass for a local time that happens to be wrong. The UI offers one tap
  // to adopt the phone's own zone, which is what makes this survive a flight.
  timezone: 'UTC',
  quietFrom: null,
  quietTo: null,
  categories: { 'needs-you': true, done: true, broken: true },
  brokenOverridesQuiet: false,
  updatedAt: null,
};
let vapidKeys = null;

// ---------------------------------------------------------------- event log
/** @type {Map<string, object>} id -> task (insertion order == creation order) */
const tasks = new Map();
/** @type {Map<string, object>} id -> conversation (insertion order == creation order) */
const conversations = new Map();
/*
 * Ticked checkboxes, keyed by THREAD ENTRY id rather than task id — a checklist
 * usually arrives as an agent's *result*, which projects to the derived entry
 * `<taskId>:r`, and a single task can therefore carry two independent lists.
 * Value: { [index]: { on, by, at } }. The message text stays the source of truth
 * for the items themselves; this only records the ticks made from a page, which
 * is the one thing the append-only text can never be rewritten to express.
 */
const checks = new Map();
let logFd = null;
let mutations = 0; // bumped on every applied event; memoisation keys off it

/* ------------------------------------------------------------ activity feed
 * What is this coordinator actually doing right now: which subagents it spawned,
 * which finished, and — if something is bothering to report them — which tools
 * it ran. An append-only ring per conversation, capped, oldest dropped first.
 *
 * DURABILITY IS SPLIT ON PURPOSE, and the split is the whole design:
 *
 *   - subagent spawned/finished and worktree claims are DURABLE. They are rare,
 *     and they are the only record of what is still running and what is still
 *     holding a git worktree when this process restarts. This server restarts
 *     itself whenever server.js changes, i.e. constantly, and forgetting "there
 *     are three subagents out there holding trees" across a restart would
 *     recreate the exact ghost the stop fields above exist to prevent.
 *
 *   - tool calls are EPHEMERAL, memory only. They are high volume and would
 *     bury the actual history in `events.jsonl` — the same reason heartbeats
 *     are not logged. A live view is allowed to start empty after a restart;
 *     the queue's own record of what happened is not.
 *
 * NOTHING HERE FEEDS LIVENESS. A tool call is not proof of useful work: an agent
 * sitting in a poll loop emits them forever while achieving nothing, which is
 * precisely the lie a heartbeat tells. `lastActedAt` keeps coming from claims
 * and results only. This feed is colour, not evidence.
 */
const ACTIVITY = new Map(); // conversationId -> entry[] (oldest first)
const ACTIVITY_CAP = Number(process.env.ACTIVITY_CAP || 200); // per conversation
const ACTIVITY_CONVS = 50; // distinct conversations tracked before the quietest is dropped
const DURABLE_KINDS = new Set(['spawned', 'finished', 'worktree']);
// How far back an explicit `at` may reach. Backfill is for a coordinator
// resumed mid-flight, which is hours; anything older is a caller bug and is
// rejected rather than quietly accepted into a feed that cannot hold it.
const ACT_AT_MAX_AGE_MS = Number(process.env.ACT_AT_MAX_AGE_MS || 30 * 86400000);

/*
 * WHERE A TIMESTAMP CAME FROM, in three states rather than two.
 *
 *   false — the server stamped it when the POST arrived. Observed.
 *   true  — the client supplied `at`. Reconstructed, and possibly a guess.
 *   null  — UNKNOWN. The entry pre-dates this field.
 *
 * `null` is not tidiness, it is the honest answer for entries already in the
 * append-only log. Some of those ARE backfills — a coordinator resumed
 * mid-flight recorded six subagents with the backfill time as their start, so
 * one that had been running an hour reported ten seconds. Nothing in the log
 * distinguishes those from genuinely observed ones, and the log must not be
 * rewritten to pretend otherwise. Defaulting them to `false` would launder a
 * guess into an observation, which is the exact defect this field exists to
 * expose. So they normalise to `null` and every consumer can see it does not
 * know.
 *
 * Normalised HERE because every entry reaches the ring through this function —
 * fresh from a POST and replayed from the log alike — so the key is always
 * present on the way out, and no consumer ever needs an existence check.
 */
function actProvenance(v) {
  return v === true ? true : v === false ? false : null;
}

function pushActivity(entry) {
  if (!entry || typeof entry.conversationId !== 'string') return null;
  entry.reconstructed = actProvenance(entry.reconstructed);
  let feed = ACTIVITY.get(entry.conversationId);
  if (!feed) {
    if (ACTIVITY.size >= ACTIVITY_CONVS) {
      // Drop whichever feed has been quiet longest, not whichever was created
      // first — a long-lived busy conversation must not be evicted by churn.
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, f] of ACTIVITY) {
        // The NEWEST timestamp in the feed, not the last one appended: a
        // backfilled entry carries an older `at`, and reading arrival order as
        // time order here would let a busy conversation be evicted for having
        // just corrected its own history.
        let at = 0;
        for (const e of f) { const t = msOf(e.at); if (t > at) at = t; }
        if (at < oldestAt) { oldestAt = at; oldestId = id; }
      }
      if (oldestId !== null) ACTIVITY.delete(oldestId);
    }
    feed = [];
    ACTIVITY.set(entry.conversationId, feed);
  }
  feed.push(entry);
  while (feed.length > ACTIVITY_CAP) feed.shift();
  return entry;
}

/*
 * THE STOP FIELDS, AND THE LIE THEY EXIST TO PREVENT.
 *
 * A coordinator is two separate things: this row, and a Claude agent running in
 * some session. The UI can only reach the row. Archiving or deleting it does
 * NOT stop the agent — it keeps running, keeps holding git worktrees, and may
 * keep posting into a conversation that now looks closed. That is strictly
 * worse than leaving it alone, because it *looks* resolved.
 *
 * So there is no kill here, and deliberately never will be. `stopRequested` is
 * a note pinned to the door: the agent reads it the next time it happens to
 * wake, and stops itself. Nothing in this process can make that happen sooner,
 * because an agent cannot be woken from outside — a Monitor event is only
 * delivered at the start of a turn. The acknowledgement fields exist purely so
 * the difference between "asked" and "actually stopped" stays visible instead
 * of being assumed, and they are only ever written by the agent itself.
 */
function newConversation(id, title, agent) {
  return {
    id,
    title,
    agent: agent || null, // who is meant to answer here; set and read by the agent side
    createdAt: nowIso(),
    archived: false,
    archivedAt: null,
    stopRequested: false,
    stopRequestedAt: null,
    stopRequestedBy: null,
    // Written by the agent, from inside a turn. `null` means it has not been
    // heard from since the request — the normal state, not an error.
    stopAck: null,        // null | 'stopping' | 'stopped'
    stopAckAt: null,
    stoppedAt: null,
    stopNote: null,
    // What the agent says it was holding when it wound down. Reported, never
    // observed: this server does not touch git and cannot verify a word of it.
    worktrees: null,
  };
}

/*
 * Conversations written before the stop fields existed replay as bare objects.
 * Normalising on the way in keeps every reader free of `undefined` checks and,
 * more importantly, stops "never asked to stop" and "asked, no answer yet" from
 * both arriving as `undefined` at the point where the UI picks a badge.
 */
function normaliseConv(conv) {
  const base = {
    archived: false, archivedAt: null,
    stopRequested: false, stopRequestedAt: null, stopRequestedBy: null,
    stopAck: null, stopAckAt: null, stoppedAt: null, stopNote: null, worktrees: null,
  };
  for (const [k, v] of Object.entries(base)) if (conv[k] === undefined) conv[k] = v;
  return conv;
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
    conversations.set(ev.conv.id, normaliseConv(ev.conv));
  } else if (ev.t === 'convpatch') {
    const conv = conversations.get(ev.id);
    if (conv) Object.assign(conv, ev.patch);
  } else if (ev.t === 'act') {
    // The durable half of the activity feed — see the feed section below for
    // why only some kinds get a line in the log at all.
    pushActivity(ev.entry);
  } else if (ev.t === 'sub') {
    // One row per browser. Firefox and Chrome are separate subscriptions with
    // separate push services, so this is a set and never a single value.
    subscriptions.set(ev.sub.id, ev.sub);
  } else if (ev.t === 'unsub') {
    subscriptions.delete(ev.id);
  } else if (ev.t === 'pushcfg') {
    pushConfig = { ...pushConfig, ...ev.cfg };
  } else if (ev.t === 'image') {
    /*
     * One posting of one blob. The bytes live on disk under the content hash;
     * this is the record that it was posted, by whom, and into which
     * conversation. Two maps because those are two different lifetimes — the
     * file is shared, the posting is not.
     */
    const im = ev.image;
    if (im && typeof im.id === 'string' && typeof im.blob === 'string') {
      images.set(im.id, im);
      const meta = blobs.get(im.blob);
      if (meta) meta.posts++;
      else blobs.set(im.blob, { type: im.type, bytes: im.bytes, width: im.width, height: im.height, posts: 1 });
    }
  } else if (ev.t === 'check') {
    // One tick. Last write wins, and the record keeps who and when, because
    // "who ticked this" is the first question asked of a shared list.
    let row = checks.get(ev.entryId);
    if (!row) { row = {}; checks.set(ev.entryId, row); }
    row[String(ev.index)] = { on: !!ev.on, by: ev.by || null, at: ev.at };
  }
  // An unknown `t` is ignored, as it always has been: a log written by a newer
  // build replays on an older one without tripping it.
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
  else if (ev.t === 'sub' || ev.t === 'unsub' || ev.t === 'pushcfg') { /* not thread state; nothing to stream */ }
  else if (ev.t === 'check') broadcast(taskIdOfEntry(ev.entryId));
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

const truthyParam = (v) => v !== null && v !== 'false' && v !== '0';

/** Applies status / unread / since / limit query filters. Throws {code,message}. */
function applyFilters(list, q) {
  // Internal agent-to-agent traffic is invisible to every query that does not
  // name a channel. This is first, so no later filter can accidentally let one
  // through, and it is why every call written before channels existed returns
  // exactly what it always did.
  const channel = q.get('channel');
  if (channel !== null && channel !== '') {
    list = list.filter((t) => isInternal(t) && channelOf(t) === channel);
  } else if (!truthyParam(q.get('internal'))) {
    list = list.filter((t) => !isInternal(t));
  }

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

  // `expired=1` is how an abandoned claim gets found at all. Nothing sweeps them
  // up, so without a way to ask, a lease that has run out changes nothing.
  if (truthyParam(q.get('expired'))) {
    list = list.filter((t) => { const l = leaseOf(t); return l !== null && l.expired; });
  }

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
    if (isInternal(t)) continue; // agent chatter is not queue depth
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
  const first = {
    id: t.id,
    role: t.role === 'agent' ? 'agent' : 'user',
    text: asText(t.instruction),
    ts: t.ts,
    status: t.status,
    rev: new Date(revMs).toISOString(),
    conversationId,
  };
  // Only ever added, never removed: an entry without an author is exactly the
  // shape every client was already written against.
  if (t.author) first.author = t.author;
  /*
   * Attached pictures. Added only when there are some, so an entry for a
   * message with none is byte-for-byte the shape every existing client was
   * written against — including the copy the service worker saved yesterday.
   */
  if (Array.isArray(t.images) && t.images.length) first.images = t.images.slice();
  const out = [first];
  if (t.result !== null && t.result !== undefined) {
    const at = t.resultTs || t.ts;
    const reply = {
      id: `${t.id}:r`,
      role: 'agent',
      text: asText(t.result),
      ts: at,
      status: 'done',
      rev: new Date(Math.max(msOf(at), createdMs)).toISOString(),
      replyTo: t.id,
      conversationId,
    };
    if (Array.isArray(t.resultImages) && t.resultImages.length) reply.images = t.resultImages.slice();
    out.push(reply);
  }
  /*
   * A tick is a change to the entry, so it has to move `rev` — a client polling
   * `since=<rev>` would otherwise never be told, and his second device would sit
   * showing a stale list until something unrelated happened in the thread.
   */
  for (const e of out) {
    const row = checks.get(e.id);
    if (!row) continue;
    const cl = checklistOf(e.id);
    if (!cl) continue;
    e.checklist = { total: cl.total, done: cl.done, items: cl.items };
    let latest = msOf(e.rev);
    for (const k of Object.keys(row)) latest = Math.max(latest, msOf(row[k].at));
    e.rev = new Date(latest).toISOString();
  }
  return out;
}

/** A task's conversation, defaulting for records written before they existed. */
const convIdOf = (t) => (typeof t.conversationId === 'string' && t.conversationId ? t.conversationId : DEFAULT_CONV);

// ---------------------------------------------------------------- checklists
/*
 * A ticked box has to survive a reload, a second device, and a server restart,
 * so it is stored here rather than in one browser's localStorage — and it has
 * to be READABLE BY AN AGENT, which is the whole point of the feature: "check
 * things off and have Claude notice."
 *
 * The items themselves are never stored. They are parsed out of the message
 * text on demand, so there is exactly one source of truth for *what is on the
 * list* (the message, which is append-only and cannot be rewritten) and exactly
 * one for *what is ticked* (the `check` events). Those two cannot drift apart,
 * because neither is a copy of the other. Editing is impossible by
 * construction; a corrected list is a new message, which correctly starts with
 * fresh ticks rather than inheriting stale ones.
 *
 * The index is the ordinal of the task line within the message, counted exactly
 * as the browser counts it — the client and the server MUST agree here, so the
 * fence-skipping below mirrors the page's renderer line for line. A checkbox
 * inside a fenced code block is sample text, not a task, on both sides.
 */
const RE_TASKLINE = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/;
const RE_FENCELINE = /^\s*(?:```|~~~)/;

/** Task-list items in a message, in document order. Fenced code is not a list. */
function parseChecklist(text) {
  const out = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let fenced = false;
  for (const line of lines) {
    if (RE_FENCELINE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = RE_TASKLINE.exec(line);
    if (!m) continue;
    out.push({
      index: out.length,
      depth: Math.floor(m[1].replace(/\t/g, '    ').length / 2),
      label: m[3].trim(),
      checkedInText: /x/i.test(m[2]),
    });
  }
  return out;
}

/** `abc-123:r` -> `abc-123`. A derived reply entry belongs to its own task. */
const taskIdOfEntry = (entryId) => String(entryId || '').replace(/:r$/, '');

/**
 * The text an entry id names, or null if there is no such entry. `<id>` is the
 * instruction, `<id>:r` the agent's result — the two halves `entriesOf` builds.
 */
function entryTextOf(entryId) {
  const id = String(entryId || '');
  const isReply = /:r$/.test(id);
  const task = tasks.get(taskIdOfEntry(id));
  if (!task) return null;
  if (isReply) {
    if (task.result === null || task.result === undefined) return null;
    return { task, text: asText(task.result), role: 'agent' };
  }
  return { task, text: asText(task.instruction), role: task.role === 'agent' ? 'agent' : 'user' };
}

/**
 * The live state of one entry's checklist: the parsed items, with any tick that
 * a page has made laid over the text's own `[x]`. Returns null when the entry
 * has no task list at all, so "no checklist here" is distinguishable from "an
 * empty one".
 */
function checklistOf(entryId) {
  const found = entryTextOf(entryId);
  if (!found) return null;
  const items = parseChecklist(found.text);
  if (!items.length) return null;
  const row = checks.get(String(entryId)) || {};
  let done = 0;
  const out = items.map((it) => {
    const rec = row[String(it.index)];
    const checked = rec ? !!rec.on : it.checkedInText;
    if (checked) done++;
    return {
      index: it.index,
      label: it.label,
      depth: it.depth,
      checked,
      // Where this value came from, so an agent can tell "he ticked it" from
      // "it was written already ticked" without guessing.
      source: rec ? 'checked' : 'text',
      by: rec ? rec.by || null : null,
      at: rec ? rec.at || null : null,
    };
  });
  return {
    entryId: String(entryId),
    taskId: found.task.id,
    conversationId: convIdOf(found.task),
    role: found.role,
    total: out.length,
    done,
    remaining: out.length - done,
    items: out,
  };
}

/** Every checklist in the queue, newest task last. Optionally one conversation. */
function allChecklists(conversationId) {
  const out = [];
  for (const t of tasks.values()) {
    if (isInternal(t)) continue;
    if (conversationId && convIdOf(t) !== conversationId) continue;
    for (const entryId of [t.id, `${t.id}:r`]) {
      const cl = checklistOf(entryId);
      if (cl) out.push(cl);
    }
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------
 * HOW AN AGENT FINDS OUT — and why this is debounced rather than immediate.
 *
 * Ticking a box has to reach an agent, because "check it off and have Claude
 * notice" is the feature; a checkbox that only a browser knows about is a
 * to-do app, and he already has one of those. But a coordinator only wakes on
 * *pending work in its own conversation*, and the human's thread is for things
 * he needs to read — so one message per tap would be both the only thing that
 * works and completely unusable. Six items ticked while packing is six
 * interruptions in the thread he reads on his phone.
 *
 * So a burst of taps settles into ONE notification. The timer restarts on every
 * tick, so it fires after he stops, not on a fixed schedule, and a list worked
 * through steadily produces a single line at the end of it.
 *
 * Two things are written, deliberately:
 *   - a `checklist` CHANNEL message, always. Internal, excluded from his thread
 *     and from SSE, so it costs him nothing and gives an agent a durable, `since`
 *     -pollable record of exactly what changed.
 *   - a PENDING task in the conversation, which is the only construct that
 *     actually wakes that conversation's coordinator. Terse and worth reading:
 *     what he ticked, and what is left.
 *
 * It never pushes and never speaks. He performed this action himself, seconds
 * ago, with his own thumb — notifying him of it would be pure noise, and the
 * push budget is spent on things he does not already know.
 * ---------------------------------------------------------------------------
 */
const CHECK_SETTLE_MS = Number(process.env.CHECK_SETTLE_MS || 20000);
const CHECK_CHANNEL = 'checklist';
/** conversationId -> { timer, changes: Map<string, {label, on, by, entryId}> } */
const checkNotices = new Map();

/** One line of a summary, flattened so a label can never become markup itself. */
function safeLabel(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s>#*+-]+/, '')   // cannot open a list, heading or quote
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '(untitled item)';
}

function noticeText(conversationId, changes) {
  const on = changes.filter((c) => c.on);
  const off = changes.filter((c) => !c.on);
  const lines = [];
  if (on.length) lines.push(`Ticked off: ${on.map((c) => safeLabel(c.label)).join('; ')}`);
  if (off.length) lines.push(`Un-ticked: ${off.map((c) => safeLabel(c.label)).join('; ')}`);
  // Where each touched list now stands, so the agent does not have to go and ask.
  const seen = new Set(changes.map((c) => c.entryId));
  for (const entryId of seen) {
    const cl = checklistOf(entryId);
    if (!cl) continue;
    const left = cl.items.filter((i) => !i.checked).map((i) => safeLabel(i.label));
    lines.push(`List ${entryId}: ${cl.done}/${cl.total} done` +
      (left.length ? `, still open: ${left.slice(0, 12).join('; ')}${left.length > 12 ? ` (+${left.length - 12} more)` : ''}` : ', all done'));
  }
  return lines.join('\n').slice(0, MAX_TEXT);
}

function flushCheckNotice(conversationId) {
  const rec = checkNotices.get(conversationId);
  if (!rec) return;
  checkNotices.delete(conversationId);
  if (rec.timer) clearTimeout(rec.timer);
  const changes = [...rec.changes.values()];
  if (!changes.length) return;
  const body = noticeText(conversationId, changes);
  const ts = nowIso();

  // 1. The durable, thread-free record. An agent polls
  //    /messages?channel=checklist&since=… and sees every change with no noise.
  appendEvent({
    t: 'create',
    task: {
      id: newId(),
      role: 'agent',
      instruction: body,
      from: 'checklist',
      author: 'checklist',
      ts,
      status: 'done',
      claimedBy: null, claimedAt: null, result: null, resultTs: null,
      relayed: true, relayedAt: ts,
      visibility: 'internal',
      channel: CHECK_CHANNEL,
      conversationId: `#${CHECK_CHANNEL}`,
      // Kept so a channel reader can tell which real conversation this came from.
      about: conversationId,
    },
  });

  // 2. The wake-up. Only a pending task in the conversation rouses its
  //    coordinator, so this is the half that makes "Claude notices" true.
  if (conversations.has(conversationId)) {
    const ts2 = nowIso();
    appendEvent({
      t: 'create',
      task: {
        id: newId(),
        role: DEFAULT_ROLE, // he did this; it is his action, not an agent's
        conversationId,
        instruction: body,
        from: 'checklist',
        ts: ts2,
        status: 'pending',
        claimedBy: null, claimedAt: null, result: null, resultTs: null,
        relayed: false, relayedAt: null,
      },
    });
    // Deliberately no notify(): see the comment above. He just did this.
  }
}

/** Record one tick for the batch, and (re)arm the settle timer. */
function queueCheckNotice(conversationId, entryId, index, label, on) {
  let rec = checkNotices.get(conversationId);
  if (!rec) { rec = { timer: null, changes: new Map() }; checkNotices.set(conversationId, rec); }
  // Keyed by item: ticking and un-ticking the same box before it settles is one
  // net change, and settles to whatever it ended up as — usually nothing at all.
  rec.changes.set(`${entryId}#${index}`, { entryId, index, label, on });
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => flushCheckNotice(conversationId), CHECK_SETTLE_MS);
  if (rec.timer.unref) rec.timer.unref(); // never hold the process open for this
}

function threadEntries(conversationId) {
  const out = [];
  for (const t of tasks.values()) {
    if (isInternal(t)) continue; // never, under any filter: this is the human's view
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
    if (isInternal(t)) continue; // no counts, no preview text, and no stray "#agents" row
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
    // is answering is busy, not idle. An agent posting a message of its own is
    // acting too: it can only have come from inside a turn.
    for (const at of [t.claimedAt, t.resultTs, t.role === 'agent' ? t.ts : null]) {
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

/*
 * THE LIFECYCLE VALUE — one field, and the only one a badge should switch on.
 *
 * Liveness (is it there?) and stopping (has it been asked to go?) are two
 * independent axes, and both are kept in the payload. But a UI needs a single
 * value to render, and if each client recombines the axes itself they will
 * disagree — so the combination is made here, once.
 *
 * The precedence exists to keep five things that are genuinely different from
 * ever rendering the same:
 *
 *   unassigned      no agent has ever been assigned. Nothing to stop.
 *   never           assigned, but has not acted or checked in even once.
 *   idle/watching   assigned, acted recently, nothing waiting or being handled.
 *   stale/silent/stuck  assigned, work is waiting, nothing is happening.
 *   stop-requested  asked to stop, HAS NOT ANSWERED. Still running, as far as
 *                   anyone here knows. This is the state people will misread as
 *                   "done", so it carries the loudest wording in the payload.
 *   stopping        it answered, and is winding down.
 *   stopped         it said it was finished and stood itself down. The ONLY
 *                   state that means the agent is actually gone.
 *
 * `stopped` outranks `unassigned` deliberately: a stopped agent unassigns itself
 * as its last act, so without this a clean shutdown would be indistinguishable
 * from a conversation that never had an agent at all.
 */
function stopStateOf(c) {
  const requestedAgoSec = secSince(c.stopRequestedAt);
  const ackAgoSec = secSince(c.stopAckAt);
  const phase = c.stopAck === 'stopped' ? 'stopped'
    : c.stopAck === 'stopping' ? 'stopping'
      : c.stopRequested ? 'requested' : null;

  // Did the agent do any real queue work AFTER being asked? Proof it is alive
  // and has not read the note — the difference between "winding down" and
  // "carrying on regardless", which no timeout could tell you.
  const actedSince = c.stopRequestedAt && c.lastActedAt
    ? msOf(c.lastActedAt) > msOf(c.stopRequestedAt) : false;

  return {
    phase,
    requested: !!c.stopRequested,
    requestedAt: c.stopRequestedAt || null,
    requestedAgoSec,
    requestedBy: c.stopRequestedBy || null,
    ack: c.stopAck || null,
    ackAt: c.stopAckAt || null,
    ackAgoSec,
    stoppedAt: c.stoppedAt || null,
    note: c.stopNote || null,
    worktrees: c.worktrees || null,
    worktreesAreSelfReported: true,
    actedSinceRequest: actedSince,
    /*
     * Nobody is listening. A stop request on a conversation with no agent is a
     * note pinned to a door with no room behind it — it will sit `requested`
     * forever, and that must not be mistaken for "any moment now".
     */
    willNeverBeSeen: !!c.stopRequested && !c.agent && !c.stopAck,
    // Asked a while ago, still nothing back. Not necessarily broken — an agent
    // is only able to notice at the start of a turn — but worth showing plainly.
    unacknowledgedForSec: c.stopRequested && !c.stopAck ? requestedAgoSec : null,
  };
}

function agentLifecycle(c) {
  const live = agentLiveness(c);
  const stop = stopStateOf(c);
  const lifecycle = stop.phase === 'stopped' ? 'stopped'
    : stop.phase === 'stopping' ? 'stopping'
      : stop.phase === 'requested' ? 'stop-requested'
        : live.state;
  return {
    ...live,
    lifecycle,
    stop,
    /*
     * Carried on every row, not just on the ones being stopped, because the UI
     * has to be able to explain the limit at the moment he reaches for the
     * control — not after he has already assumed it worked.
     */
    forceKill: FORCE_KILL_NOTE,
  };
}

/** Summaries plus live agent state — what the conversation list actually renders. */
const conversationsWithLiveness = () =>
  conversationSummaries().map((c) => ({
    ...c,
    agentState: agentLifecycle(c),
    // Compact enough to ride along on the list; the full feed has its own route.
    activity: activitySummary(c.id),
  }));

/** Just the counters, for the conversation list. The entries are the big part. */
function activitySummary(id) {
  const a = activityOf(id);
  return {
    running: a.running,
    subagents: a.subagents.length,
    toolCalls: a.toolCalls,
    lastAt: a.lastAt,
    reporting: a.reporting,
    count: a.count,
  };
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
  // The stream feeds open pages, so internal traffic must never enter it. An
  // agent reads its channel by polling; it does not get a push.
  if (isInternal(task)) return;
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
    /*
     * The service worker will only save a shell carrying this header. It exists
     * because the page sits behind Cloudflare Access, whose login screen is a
     * 200 full of HTML — and a worker that cached *that* as the app would lock
     * him out of his own thread with a saved copy of a login form. Nothing else
     * served here sets it.
     */
    'x-relay-app': '1',
    // The page is fully self-contained; this forbids any external request from it.
    // `blob:` in script-src/worker-src is for the inline AudioWorklet used by voice
    // dictation — the worklet source is built into a Blob so the page stays one file.
    // It grants nothing new: the page already runs with 'unsafe-inline'.
    // `worker-src 'self'` was added for /sw.js: a service worker must be a real
    // same-origin file, a blob: worker cannot control the page, and without this
    // registration fails silently in a way that looks like the browser's fault.
    // `manifest-src 'self'` and `'self'` in img-src were added when the app
    // became installable: without the first the manifest is blocked outright
    // and Android will not offer to install, and the icons are now real files
    // rather than the data: URI the favicon still uses. Note that a service
    // worker is governed by worker-src, which was already 'self' — script-src
    // stays as tight as it was.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline' blob:; worker-src 'self' blob:; img-src 'self' data:; " +
      "media-src blob: data:; connect-src 'self'; manifest-src 'self'; " +
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
 * THE CLAIM LEASE. A claim used to last forever, so an agent that died still
 * held its message: one sat 3h14m and another 32m, and nothing but luck found
 * either. The lease is deliberately PERMISSIVE rather than pre-emptive:
 *
 *   - No timer ever touches a task. Nothing is force-cleared, nothing reverts to
 *     `pending`, and an agent that is legitimately still working is never
 *     interrupted — an expiry merely stops the queue *refusing* a second agent.
 *   - The one-result-per-task rule is untouched, so the worst case of an expiry
 *     that fired too early is a duplicate worker, and the loser gets a 409
 *     instead of overwriting the answer.
 *   - The holder can renew by re-claiming its own task, which is an act from
 *     inside a turn. Heartbeats deliberately do NOT renew: a heartbeat comes
 *     from a poll loop and proves nothing about whether the agent is awake,
 *     which is the exact lie this file already refuses to tell elsewhere.
 *
 * Same 15 minutes as STUCK_CLAIM_MS above, on purpose: the moment /status starts
 * calling a claim stuck is the moment another agent is allowed to take it, so
 * the page and the protocol can never disagree about what "stuck" means.
 */
const CLAIM_LEASE_MS = Number(process.env.CLAIM_LEASE_MS || STUCK_CLAIM_MS);
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
    if (isInternal(t)) continue; // the status page is his too
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
    if (isInternal(t)) continue;
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
  const snap = watchSnapshot();
  const changed = snap.level !== lastWatchLevel;
  lastWatchLevel = snap.level;
  /*
   * Decided before the no-streams early return, on purpose. A push notification
   * is the only thing that reaches him when no page is open, which is the exact
   * case the old comment above called an "honest limit" — so it must not sit
   * behind a check for whether a page is open.
   */
  if (changed) notifyWatchLevel(snap);
  if (streams.size === 0) return;
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

/*
 * Every conversation that has, or recently had, an agent — plus the ones that
 * were asked to stop and never answered, which are the whole reason this exists.
 * A conversation nobody was ever assigned to is left out; it is not a
 * coordinator and would only pad the list.
 */
function coordinatorRoster() {
  const rows = [];
  for (const c of conversationsWithLiveness()) {
    if (!c.agent && !c.stopRequested && !c.stopAck) continue;
    rows.push({
      id: c.id,
      title: c.title,
      agent: c.agent,
      archived: c.archived,
      lifecycle: c.agentState.lifecycle,
      lastActedAt: c.lastActedAt,
      actedAgoSec: c.agentState.actedAgoSec,
      stop: c.agentState.stop,
      activity: c.activity,
    });
  }
  // Anything mid-stop first: those are the rows a human is waiting on.
  const rank = (r) => (r.lifecycle === 'stop-requested' ? 0 : r.lifecycle === 'stopping' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || msOf(b.lastActedAt) - msOf(a.lastActedAt));
  return {
    count: rows.length,
    awaitingStop: rows.filter((r) => r.lifecycle === 'stop-requested' || r.lifecycle === 'stopping').length,
    // Archived, agent never confirmed stopped: invisible in the UI, possibly alive.
    ghosts: rows.filter((r) => r.archived && r.agent && r.stop.ack !== 'stopped').length,
    rows,
  };
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
    /*
     * The coordinator roster. Here as well as on /conversations so a status page
     * can render the whole lifecycle — including who has been asked to stop and
     * has not answered — without a second request per conversation.
     *
     * Archived conversations are INCLUDED, unlike the conversation list, and
     * that is the point: an archived row with a running agent is exactly the
     * ghost worth showing, and hiding it here would hide the only evidence left.
     */
    coordinators: coordinatorRoster(),
    forceKill: FORCE_KILL_NOTE,
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

// ---------------------------------------------------------------- web push
/*
 * Keys. Generated once and kept in data/ (gitignored, 0600) rather than asked
 * for in the environment, so that merging this branch is the whole install —
 * there is no key ceremony to perform on a phone at an airport. Losing the file
 * invalidates every existing subscription, because the browser pinned this
 * public key when it subscribed, so a failure to persist is shouted about.
 */
function loadVapidKeys() {
  const fromEnv = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (wp.looksLikeVapidKeys(fromEnv)) return fromEnv;
  try {
    const disk = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (wp.looksLikeVapidKeys(disk)) return disk;
  } catch { /* absent or corrupt: mint a new pair below */ }
  const fresh = wp.generateVapidKeys();
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    console.log(`[push] WARNING could not save VAPID keys to ${KEYS_FILE}: ${e.message}`);
    console.log('[push] every restart will mint new keys and silently break existing subscriptions');
  }
  return fresh;
}

/*
 * One row per browser, keyed by a device id the page keeps in localStorage.
 * Re-subscribing from the same browser therefore *replaces* its own row instead
 * of accumulating duplicates; a browser that never sends one falls back to a
 * hash of its endpoint, which is stable for as long as the subscription is.
 */
function subIdFor(body, endpoint) {
  const dev = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return `d-${dev}`;
  return `e-${crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 22)}`;
}

/** A short, honest name for a browser, for the "which devices are armed" list. */
function browserLabel(ua) {
  const s = String(ua || '');
  const fx = /Firefox\/(\d+)/.exec(s);
  if (fx) return `Firefox ${fx[1]}`;
  const ch = /Chrome\/(\d+)/.exec(s);
  if (ch) return `Chrome ${ch[1]}`;
  return 'this browser';
}

function subscribeRoute(res, body) {
  if (!PUSH_ON) return fail(res, 503, 'push is disabled on this server');
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const keys = body.keys && typeof body.keys === 'object' ? body.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 1000) {
    return fail(res, 400, 'endpoint is required and must be an https URL');
  }
  if (!p256dh || !auth) return fail(res, 400, 'keys.p256dh and keys.auth are required');
  // Prove the keys encrypt before storing them, so a broken subscription fails
  // here — where the page can say so — rather than silently at 3am.
  try {
    wp.encrypt(Buffer.from('probe'), p256dh, auth, {});
  } catch (e) {
    return fail(res, 400, `subscription keys are unusable: ${e.message}`);
  }

  const id = subIdFor(body, endpoint);
  // Drop any other row holding this same endpoint, or the browser would get two.
  for (const [otherId, s] of subscriptions) {
    if (otherId !== id && s.endpoint === endpoint) appendEvent({ t: 'unsub', id: otherId });
  }
  if (!subscriptions.has(id) && subscriptions.size >= MAX_SUBS) {
    return fail(res, 429, `too many devices subscribed (max ${MAX_SUBS})`);
  }
  const sub = {
    id,
    endpoint,
    p256dh,
    auth,
    label: browserLabel(body.ua),
    createdAt: nowIso(),
  };
  appendEvent({ t: 'sub', sub });
  console.log(`[push] subscribed ${id} (${sub.label}) — ${subscriptions.size} device(s) armed`);
  send(res, 201, { ok: true, id, label: sub.label, devices: subscriptions.size });
}

function unsubscribeRoute(res, body) {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  let id = typeof body.id === 'string' ? body.id : '';
  if (!id && typeof body.deviceId === 'string' && body.deviceId.trim()) id = `d-${body.deviceId.trim()}`;
  let removed = 0;
  for (const [subId, s] of [...subscriptions]) {
    if (subId === id || (endpoint && s.endpoint === endpoint)) {
      appendEvent({ t: 'unsub', id: subId });
      removed++;
    }
  }
  send(res, 200, { ok: true, removed, devices: subscriptions.size });
}

/** Everything the UI needs to state plainly what is and is not armed. */
function pushSnapshot(deviceId) {
  const quiet = wp.quietState(pushConfig);
  const mine = typeof deviceId === 'string' && deviceId ? `d-${deviceId}` : null;
  return {
    enabled: PUSH_ON,
    vapidPublicKey: vapidKeys ? vapidKeys.publicKey : null,
    // Per-browser, because a subscription made in Firefox is invisible to
    // Chrome. Without this the page cannot tell him "not set up *here*", and he
    // grants permission once, opens the other browser, and thinks it is broken.
    subscribedHere: mine ? subscriptions.has(mine) : false,
    devices: [...subscriptions.values()].map((s) => ({
      id: s.id,
      label: s.label,
      createdAt: s.createdAt,
      // The endpoint is a capability URL — anyone holding it can buzz his
      // phone — so it is never handed back out, not even to his own page.
      failures: s.failures || 0,
      lastOkAt: s.lastOkAt || null,
    })),
    categories: { ...pushConfig.categories },
    brokenOverridesQuiet: !!pushConfig.brokenOverridesQuiet,
    quiet,
    budgetLeft: pushBudget,
    stats: { ...pushStats },
  };
}

function pushConfigRoute(res, body) {
  const cfg = {};
  if (body.timezone !== undefined) {
    const tz = String(body.timezone || '').trim();
    if (!wp.zoneIsKnown(tz)) return fail(res, 400, `unknown timezone "${tz}"`);
    cfg.timezone = tz;
  }
  for (const [field, key] of [['quietFrom', 'quietFrom'], ['quietTo', 'quietTo']]) {
    if (body[field] === undefined) continue;
    if (body[field] === null || body[field] === '') { cfg[key] = null; continue; }
    if (wp.parseHhMm(body[field]) === null) return fail(res, 400, `${field} must be "HH:MM" in 24-hour time`);
    cfg[key] = String(body[field]).trim();
  }
  if (body.categories && typeof body.categories === 'object') {
    const next = { ...pushConfig.categories };
    for (const c of CATEGORIES) if (typeof body.categories[c] === 'boolean') next[c] = body.categories[c];
    cfg.categories = next;
  }
  if (typeof body.brokenOverridesQuiet === 'boolean') cfg.brokenOverridesQuiet = body.brokenOverridesQuiet;
  if (Object.keys(cfg).length === 0) return fail(res, 400, 'nothing to change');
  cfg.updatedAt = nowIso();
  appendEvent({ t: 'pushcfg', cfg });
  send(res, 200, pushSnapshot(typeof body.deviceId === 'string' ? body.deviceId : null));
}

/*
 * Categorisation. Pure and exported, because this is the rule that must never
 * regress: agent-to-agent traffic on `channel` carries visibility:'internal'
 * and must not reach his phone under any category, any hint, or any config.
 *
 * WHY PUSHING IS OPT-IN
 * --------------------
 * This function used to end `if (kind === 'result' || kind === 'message')
 * return 'done'`, so every agent result and every agent message posted into one
 * of his conversations buzzed his phone by default. On 2026-08-08 that
 * delivered 17 pushes in one hour — 16 of them saying nothing more than "done"
 * — while he was abroad. Nothing was suppressed (suppressedBudget was 0); the
 * ceiling never even came near being hit. He had reined in the room speaker for
 * exactly this a day earlier, and the phone is a channel he cannot walk away
 * from. The lesson is that a default of "notify" turns ordinary agent chatter
 * into a pager, and agents chatter constantly.
 *
 * His bar, made mechanical here rather than left to agent politeness. He wants
 * to hear about: (1) things that need him, (2) things he was waiting on that
 * finished, (3) things that are broken. NOT progress, NOT status, NOT
 * acknowledgements. So:
 *
 *   message  -> null. Agent chatter never buzzes him. An agent that genuinely
 *               needs to reach him says so, by passing notify:"done" |
 *               "needs-you" | "broken". Saying nothing wakes nobody.
 *   result   -> 'done' ONLY when it answers a task HE HIMSELF posted, i.e.
 *               role:'user' AND `from` is one of his page origins. That is
 *               precisely "something he was waiting on that finished", so it
 *               stays. A result on an agent-posted task is one agent answering
 *               another and is silent — that is the bulk of the 16.
 *   task     -> unchanged: an agent asking him something is "needs you"; a task
 *               he typed himself never buzzes the phone that sent it.
 *
 * An explicit `notify` hint still wins over all of it (that is the opt-in), and
 * notify:"none" still silences everything, including rule zero's own categories.
 * If you are about to widen a default here: don't. Add a hint at the caller.
 *
 * The hazard that survives all of the above is PAGE_ORIGINS, which the `task`
 * branch consults. It is an allowlist whose default is "notify", so any new UI
 * action that posts from an origin nobody remembered to add will buzz the very
 * phone that sent it. That is not hypothetical: `checklist` was missing, and
 * his own tick paged him. Read the comment on PAGE_ORIGINS before you add a
 * posting surface — the wrong rule was never written, it was merely omitted.
 */
function classify(kind, task, hint) {
  if (!task || isInternal(task)) return null; // rule zero, before anything else
  if (hint === 'none') return null;
  if (hint && NOTIFY_VALUES.has(hint)) return hint;
  // Opt-in: an agent speaking without asking to be heard is not an event.
  if (kind === 'message') return null;
  if (kind === 'result') {
    // Only an answer to something he posted from the page counts as "the thing
    // I was waiting on finished". Anything else is agent-to-agent bookkeeping.
    return task.role === 'user' && PAGE_ORIGINS.has(task.from) ? 'done' : null;
  }
  if (kind === 'task') {
    // He typed it himself. Never buzz the phone that just sent the message.
    if (PAGE_ORIGINS.has(task.from)) return null;
    return 'needs-you';
  }
  return null;
}

function readNotifyHint(body) {
  const v = body && typeof body.notify === 'string' ? body.notify.trim() : '';
  return NOTIFY_VALUES.has(v) ? v : null;
}

// ---- the outbound queue
let pushBudget = PUSH_PER_HOUR;
setInterval(() => { pushBudget = PUSH_PER_HOUR; }, 3600000).unref();
/** @type {Map<string, object>} category -> { count, body, url, taskIds:Set, timer } */
const pushPending = new Map();
/*
 * Counters, exposed on /push/config. Two jobs: they let the selftest prove over
 * HTTP that a `channel` message queues nothing and that quiet hours really do
 * suppress, and they answer "has this thing ever actually fired?" — which is
 * otherwise unanswerable from a phone.
 */
const pushStats = { queued: 0, flushed: 0, suppressedQuiet: 0, suppressedBudget: 0, delivered: 0 };
let notifyDepth = 0; // guards the appendEvent -> pushWatch -> notify re-entry

const PUSH_TITLE = {
  'needs-you': (n) => (n > 1 ? `${n} things need you` : 'Needs you'),
  done: (n) => (n > 1 ? `${n} replies ready` : 'Reply ready'),
  broken: () => 'Something is broken',
};

function preview(v) {
  const s = asText(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > MAX_PUSH_BODY ? `${s.slice(0, MAX_PUSH_BODY - 1)}…` : s;
}

/** Queue one notification, coalescing into whatever is already waiting. */
function queueNotify(category, text, conversationId, taskId) {
  if (!PUSH_ON || !CATEGORIES.includes(category)) return;
  if (pushConfig.categories[category] === false) return;
  let slot = pushPending.get(category);
  if (!slot) {
    slot = { count: 0, body: '', url: '/', taskIds: new Set(), timer: null };
    pushPending.set(category, slot);
  }
  slot.count++;
  pushStats.queued++;
  slot.body = preview(text);
  if (conversationId) slot.url = `/#/c/${encodeURIComponent(conversationId)}`;
  if (taskId) slot.taskIds.add(taskId);
  if (!slot.timer) {
    const wait = PUSH_DEBOUNCE_OVERRIDE || PUSH_DEBOUNCE_MS[category] || 15000;
    slot.timer = setTimeout(() => flushNotify(category), wait);
    if (slot.timer.unref) slot.timer.unref();
  }
}

/*
 * An answer landing cancels the "needs you" that was still waiting to go out.
 * This is what makes the agents' post-a-task-then-answer-it pattern cost one
 * buzz instead of two, and it is why the debounce exists at all.
 */
function cancelPendingFor(taskId) {
  const slot = pushPending.get('needs-you');
  if (!slot || !slot.taskIds.has(taskId)) return;
  slot.taskIds.delete(taskId);
  slot.count = Math.max(0, slot.count - 1);
  if (slot.count === 0) {
    if (slot.timer) clearTimeout(slot.timer);
    pushPending.delete('needs-you');
  }
}

function flushNotify(category) {
  const slot = pushPending.get(category);
  pushPending.delete(category);
  if (!slot || slot.count === 0) return;
  if (slot.timer) clearTimeout(slot.timer);

  /*
   * Quiet hours are decided here, at send time, not when the event was queued —
   * so a message that arrives at 22:29 and flushes at 22:30 is correctly
   * silenced. Suppressed notifications are DROPPED, never deferred: holding
   * them would deliver the whole night in one avalanche at 07:00, and the
   * thread is still there for him whenever he opens it.
   */
  const quiet = wp.quietState(pushConfig);
  if (quiet.active && !(category === 'broken' && pushConfig.brokenOverridesQuiet)) {
    pushStats.suppressedQuiet++;
    console.log(`[push] suppressed ${category} x${slot.count} — quiet hours ${quiet.from}-${quiet.to} ${quiet.timezone} (now ${quiet.zoneNow})`);
    return;
  }
  if (pushBudget <= 0) {
    pushStats.suppressedBudget++;
    console.log(`[push] suppressed ${category} x${slot.count} — hourly budget of ${PUSH_PER_HOUR} spent`);
    return;
  }
  pushBudget--;
  pushStats.flushed++;

  const payload = JSON.stringify({
    c: category,
    t: PUSH_TITLE[category](slot.count),
    b: slot.body,
    u: slot.url,
    n: slot.count,
  });
  sendToAll(payload, category).catch((e) => console.log(`[push] send failed: ${e && e.message}`));
}

/*
 * Fan out to every subscribed browser. Delivered if any one succeeds — he
 * carries one phone but may have armed both Firefox and Chrome on it.
 */
async function sendToAll(payload, category) {
  if (!vapidKeys || subscriptions.size === 0) return 0;
  const opts = {
    keys: vapidKeys,
    subject: VAPID_SUBJECT,
    ttl: PUSH_TTL_SEC[category] || 3600,
    urgency: PUSH_URGENCY[category] || 'normal',
    // Same topic replaces an undelivered message of the same kind rather than
    // queueing both. On a plane with the phone offline this is what stops a
    // week of backlog landing at once — he gets the latest of each kind.
    topic: category,
  };
  let ok = 0;
  const results = [];
  for (const sub of [...subscriptions.values()]) {
    const r = await wp.sendOne(sub, payload, opts);
    results.push({ id: sub.id, label: sub.label, status: r.status, gone: !!r.gone, error: r.error || null });
    if (r.gone) {
      // 404/410 is permanent: permission revoked, browser data cleared, or the
      // subscription rotated. Retrying it forever is how this store rots.
      console.log(`[push] dropping dead subscription ${sub.id} (${sub.label}) — HTTP ${r.status}`);
      notifyDepth++;
      try { appendEvent({ t: 'unsub', id: sub.id }); } finally { notifyDepth--; }
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      ok++;
      pushStats.delivered++;
      sub.failures = 0;
      sub.lastOkAt = nowIso();
      continue;
    }
    sub.failures = (sub.failures || 0) + 1;
    console.log(`[push] ${sub.id} (${sub.label}) HTTP ${r.status}${r.error ? ` ${r.error}` : ''} — failure ${sub.failures}`);
    if (sub.failures >= 5) {
      // Not "gone", but consistently refused — most often a VAPID key that no
      // longer matches the one the browser pinned. It will never recover.
      console.log(`[push] dropping ${sub.id} after ${sub.failures} consecutive failures`);
      notifyDepth++;
      try { appendEvent({ t: 'unsub', id: sub.id }); } finally { notifyDepth--; }
    }
  }
  if (ok) console.log(`[push] sent ${category} to ${ok} device(s)`);
  return { ok, results };
}

/*
 * POST /push/test — let him prove it works with his thumb, before he needs it.
 *
 * SELF-TEST ONLY. Nothing routine may call this. It bypasses BOTH the debounce
 * and quiet hours by design, it ignores the hourly budget, and it cannot carry
 * custom text — so it is not a notification channel, it is a wiring check, and
 * an agent reaching for it to "just let him know" would buzz his handset at
 * 3am with the word "Test". Use POST /messages with an explicit `notify` hint
 * instead; that path respects the debounce, the budget and quiet hours.
 *
 * A deliberate action, so it skips the debounce and is not silenced by quiet
 * hours; it says which it did. It reports per-device HTTP status rather than a
 * bare ok, because the entire value of this endpoint is telling him *which*
 * browser is actually armed — the failure he will otherwise hit is granting
 * permission in Firefox, opening Chrome, and concluding the feature is broken.
 */
async function pushTestRoute(res, body) {
  if (!PUSH_ON) return fail(res, 503, 'push is disabled on this server');
  if (subscriptions.size === 0) {
    return fail(res, 409, 'no browser is subscribed yet — tap "Alert me on this phone" first');
  }
  const category = CATEGORIES.includes(body && body.category) ? body.category : 'done';
  const quiet = wp.quietState(pushConfig);
  const payload = JSON.stringify({
    c: category,
    t: PUSH_TITLE[category](1),
    b: quiet.active
      ? `Test — it works. (Quiet hours are on right now; a real ${category} alert would have been held back.)`
      : 'Test — it works. This is what a real alert will feel like.',
    u: '/',
    n: 1,
  });
  const out = await sendToAll(payload, category);
  send(res, 200, {
    ok: out.ok > 0,
    delivered: out.ok,
    sentDuringQuietHours: quiet.active,
    quiet,
    results: out.results,
  });
}

/** The one entry point the task lifecycle calls. */
function notify(kind, task, hint) {
  if (!PUSH_ON || notifyDepth > 0) return;
  if (kind === 'result' && task) cancelPendingFor(task.id);
  const category = classify(kind, task, hint);
  if (!category) return;
  const text = kind === 'result' ? task.result : task.instruction;
  queueNotify(category, text, task.conversationId, task.id);
}

/** The deadman banner, but for a phone with no page open. */
function notifyWatchLevel(snap) {
  if (!PUSH_ON || notifyDepth > 0) return;
  // A restart is not a breakage. watchSnapshot() already refuses to alarm out
  // of a fresh boot; this server restarts itself on every source change, so
  // without that the deploy loop alone would buzz him.
  if (snap.starting) return;
  if (snap.level !== 'alarm') return; // `warn` is not worth a buzz; `alarm` is
  queueNotify('broken', snap.text || 'The queue has stopped being answered.', DEFAULT_CONV, null);
}

/*
 * GET /sw.js — the service worker.
 *
 * The page is otherwise deliberately one self-contained file. This is the one
 * unavoidable second file: a service worker must be a real same-origin script
 * (a blob: worker cannot receive push events), so it cannot be inlined.
 */
let swCache = null;
const SW_FILE = path.join(__dirname, 'public', 'sw.js');

function sendServiceWorker(res) {
  let stat;
  try { stat = fs.statSync(SW_FILE); } catch { return fail(res, 503, 'service worker not found on disk'); }
  try {
    if (!swCache || swCache.mtimeMs !== stat.mtimeMs) {
      swCache = { mtimeMs: stat.mtimeMs, buf: fs.readFileSync(SW_FILE) };
    }
  } catch {
    return fail(res, 503, 'service worker is unreadable');
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': swCache.buf.length,
    // The checkout is the deployment here, so a cached worker is how you ship a
    // page nobody can update. Never store it.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'service-worker-allowed': '/',
  });
  res.end(swCache.buf);
}

/*
 * GET /manifest.webmanifest and the icons — what makes this installable.
 *
 * The manifest is an inline constant rather than a file, in keeping with the
 * rest of the page. The icons are drawn by icons.js rather than committed, so
 * `public/` stays text-only and the artwork stays reviewable as code.
 *
 * The name is deliberately not just "relay": on a home screen full of icons,
 * `short_name` is all he will see, and the full name is what a launcher search
 * matches on.
 */
const MANIFEST = Buffer.from(JSON.stringify({
  name: 'relay — messages to your agents',
  short_name: 'relay',
  description: 'The queue between you and your agents. Reads offline.',
  start_url: '/',
  scope: '/',
  id: '/',
  display: 'standalone',
  orientation: 'portrait',
  // Matches the dark theme's --bg, which is what the splash screen shows while
  // the page is starting. A white flash before a dark app is a jarring tell.
  background_color: '#0e1116',
  theme_color: '#0e1116',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    /*
     * A separate entry rather than `purpose: "any maskable"`. Combining them
     * makes one drawing serve two jobs it cannot both do: a maskable icon must
     * keep its content inside the central 80%, which leaves a plain icon
     * looking small and lost. Two entries, two croppings.
     */
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2), 'utf8');

function sendManifest(res) {
  res.writeHead(200, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'content-length': MANIFEST.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(MANIFEST);
}

/*
 * Icons are looked up in a fixed set by exact name, never by joining anything
 * from the URL onto a path. There is no filesystem read here at all, which is
 * the tidiest possible answer to the traversal bug this route would otherwise
 * be the first opportunity for.
 */
function sendIcon(res, name) {
  const buf = icons.icon(name);
  if (!buf) return fail(res, 404, `no such icon "${name}"`);
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': buf.length,
    // They are generated from source that only changes when the code does, and
    // the manifest is re-read on every install. A day is plenty.
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- images
/*
 * THE GALLERY. Agents make pictures; he is on a phone in another country and
 * could not see a single one. In one night 198 sprites were generated across
 * six subjects and none of them reached him, because every file sat in a temp
 * directory on a desktop he was thousands of miles from. The generation worked.
 * The *showing* did not exist. This is the showing.
 *
 * CONTENT-ADDRESSED, AND THAT IS THE SECURITY DESIGN RATHER THAN AN OPTIMISATION.
 *
 * This server has no authentication and answers anything that can reach the
 * port. The obvious API — "here is a path on disk, serve me that" — is a
 * file-disclosure hole: every device on his network could read every file on
 * his desktop, and the request would look exactly like a legitimate one. So no
 * client-supplied path is ever joined to a filesystem path. An agent POSTs the
 * BYTES; this process hashes them, names the file after its own hash, and
 * serves it back by that hash. Traversal is not filtered here, it is
 * UNREPRESENTABLE — the only characters that can occur in one of these
 * filenames are 64 hex digits that this process computed itself.
 *
 * The type is SNIFFED FROM THE BYTES and the client's `content-type` is
 * ignored, for the same reason: a caller must not be able to talk this server
 * into labelling an arbitrary blob as something a browser will treat as script.
 * Combined with `x-content-type-options: nosniff` on the way out, the type a
 * browser sees is one of four values this file chose.
 *
 * TWO MAPS FROM ONE EVENT, because a blob and a *posting* of a blob are
 * different things. The same contact sheet posted into two conversations is one
 * file on disk and two rows in the gallery. Keying the gallery by content hash
 * instead would silently drop the second post — the image would appear in
 * whichever conversation happened to get there first, and be missing from the
 * one he was actually looking at.
 */
const IMAGE_DIR = path.join(DATA_DIR, 'images');
// A contact sheet of several dozen candidates is the dominant artefact here and
// is far bigger than a message. Deliberately its own limit rather than MAX_BODY,
// which stays 1 MiB for JSON: a route that accepts megabytes of arbitrary bytes
// should say so in one obvious place.
const MAX_IMAGE = Number(process.env.MAX_IMAGE || 8 * 1024 * 1024);
// What this process itself produces from crypto.createHash('sha256'). Anything
// that fails this never becomes a filename.
const IMAGE_ID_RE = /^[a-f0-9]{64}$/;
const MAX_ALT = 300;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** @type {Map<string, object>} sha256 -> { type, bytes, width, height } */
const blobs = new Map();
/** @type {Map<string, object>} post id -> image record (insertion order == post order) */
const images = new Map();

/*
 * WHAT THESE BYTES ACTUALLY ARE, decided by looking at them.
 *
 * Dimensions are read out of the header too, and they are not decoration: the
 * page reserves the right box before the bytes arrive, so a thread full of
 * images does not shudder as each one loads. Every format here puts its size in
 * the first few bytes, so this needs no decoder and no dependency — which is
 * the only reason it is worth doing at all.
 *
 * `width`/`height` are null rather than guessed when the header is truncated or
 * unusual. A missing dimension makes the page fall back to a flexible box; a
 * WRONG one would lay the thread out around a lie.
 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const tag = (a, b) => buf.toString('latin1', a, b);

  // PNG: the 8-byte signature, then IHDR carrying width and height as BE u32.
  if (buf.length >= 24 && tag(0, 8) === '\x89PNG\r\n\x1a\n') {
    if (tag(12, 16) === 'IHDR') {
      return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { type: 'image/png', width: null, height: null };
  }

  // GIF: 'GIF87a'/'GIF89a', then the logical screen size as LE u16.
  if (tag(0, 6) === 'GIF87a' || tag(0, 6) === 'GIF89a') {
    return { type: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: a RIFF container whose form type is WEBP. Three sub-formats, each
  // storing the size differently, and the extended one (VP8X) is what anything
  // with animation or alpha uses.
  if (tag(0, 4) === 'RIFF' && buf.length >= 16 && tag(8, 12) === 'WEBP') {
    const form = tag(12, 16);
    if (form === 'VP8 ' && buf.length >= 30) {
      return { type: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (form === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (form === 'VP8X' && buf.length >= 30) {
      return {
        type: 'image/webp',
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    return { type: 'image/webp', width: null, height: null };
  }

  // JPEG: walk the marker segments to the start-of-frame, which is the only
  // place the size is recorded. EXIF thumbnails and comment blocks sit in front
  // of it, so this cannot be read at a fixed offset.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // Padding, and the standalone markers that carry no length field.
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break; // malformed: stop rather than loop forever
      // SOF0-SOF15, excluding the three that share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { type: 'image/jpeg', width: null, height: null };
  }

  return null;
}

/** The public shape. `url` is derived, never stored, so it cannot go stale. */
const imageView = (im) => ({ ...im, url: `/images/${im.blob}` });

function imagePath(blob) {
  return path.join(IMAGE_DIR, blob);
}

/*
 * POST /images — the bytes themselves, with the metadata in the query string.
 *
 *   curl --data-binary @sheet.png 'http://127.0.0.1:3901/images?conversationId=main&alt=crates'
 *
 * Raw rather than JSON base64 on purpose: base64 inflates by a third against a
 * cap that a contact sheet is already testing, and `--data-binary @file` is one
 * flag. The metadata rides in the query string because the body is not JSON and
 * cannot carry it.
 */
async function imageUploadRoute(req, res, q) {
  let buf;
  try {
    buf = await readRawBody(req, MAX_IMAGE);
  } catch (err) {
    return fail(res, err.code || 400, err.message || 'could not read the request body', {
      maxBytes: MAX_IMAGE,
    });
  }
  if (!buf.length) {
    return fail(res, 400, 'empty body: POST the image bytes themselves, e.g. curl --data-binary @file.png');
  }

  const kind = sniffImage(buf);
  if (!kind) {
    return fail(res, 415, 'these bytes are not an image format this server recognises', {
      supported: IMAGE_TYPES,
      // Said explicitly because a caller who set content-type correctly and was
      // still refused will otherwise assume the header was the problem.
      note: 'the format is read from the bytes; the content-type header is ignored',
      firstBytesHex: buf.slice(0, 8).toString('hex'),
    });
  }

  const alt = readString(q.get('alt'), 'alt', MAX_ALT);
  if (alt instanceof Error) return fail(res, 400, alt.message);
  const agent = readString(q.get('agent'), 'agent', MAX_AUTHOR);
  if (agent instanceof Error) return fail(res, 400, agent.message);

  const convRaw = q.get('conversationId') || q.get('conversation');
  const conversationId = convRaw || DEFAULT_CONV;
  if (!conversations.has(conversationId)) {
    return fail(res, 400, `no conversation with id "${conversationId}"`, { conversationId });
  }

  const blob = crypto.createHash('sha256').update(buf).digest('hex');

  /*
   * Write the bytes BEFORE logging the event, so the log never describes a file
   * that is not there. The reverse order would survive a crash as a permanent
   * broken image in his thread with no way to tell it from a bug.
   */
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    // Identical content is identical bytes, so a re-post is a no-op rather than
    // a rewrite — and a rewrite of a file a request may be streaming is exactly
    // the kind of race worth not having.
    if (!fs.existsSync(imagePath(blob))) {
      const tmp = imagePath(blob) + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, imagePath(blob)); // atomic within the directory
    }
  } catch (err) {
    return fail(res, 500, `could not store the image: ${err.message}`, { dir: IMAGE_DIR });
  }

  const image = {
    id: newId(),
    blob,
    type: kind.type,
    bytes: buf.length,
    width: kind.width === undefined ? null : kind.width,
    height: kind.height === undefined ? null : kind.height,
    alt,
    agent,
    conversationId,
    ts: nowIso(),
  };
  appendEvent({ t: 'image', image });
  send(res, 201, {
    ok: true,
    image: imageView(image),
    // Same bytes as something already here. Worth saying: an agent looping over
    // a directory of near-identical renders wants to know two of them matched.
    deduplicated: blobs.get(blob) ? blobs.get(blob).posts > 1 : false,
    markdown: `![${(alt || 'image').replace(/[[\]]/g, '')}](/images/${blob})`,
  });
}

/*
 * GET /images/:blob — the bytes.
 *
 * Immutable caching is honest here in a way it almost never is: the name IS the
 * hash of the content, so this URL cannot ever mean different bytes. That is
 * what makes a phone on hotel wifi bearable.
 */
function imageBytesRoute(req, res, blob) {
  if (!IMAGE_ID_RE.test(blob)) {
    return fail(res, 404, 'not an image id', {
      // The shape is named rather than the mistake, because the most likely
      // caller here is someone who put a filename or a path in the URL.
      expected: 'the 64-character sha256 this server returned from POST /images',
    });
  }
  const meta = blobs.get(blob);
  if (!meta) return fail(res, 404, `no image with id "${blob}"`);

  let buf;
  try {
    buf = fs.readFileSync(imagePath(blob));
  } catch (err) {
    /*
     * The log remembers the image and the bytes are gone — a DATA_DIR restored
     * without its images directory, or a manual tidy-up. Say precisely that.
     * Serving a placeholder, or a 200 with nothing in it, would leave him
     * looking at a broken square with no way to tell it from a bug in the page.
     */
    return fail(res, 410, 'this image is in the log but its bytes are no longer on disk', {
      id: blob, expectedAt: imagePath(blob), reason: err.code || 'unreadable',
    });
  }

  res.writeHead(200, {
    'content-type': meta.type,
    'content-length': buf.length,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    // Belt and braces on a route that returns caller-supplied bytes: even if
    // the sniffer were ever fooled, nothing here may act as a document.
    'content-disposition': 'inline',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
}

/** GET /images — the gallery listing, newest first. */
function imageListRoute(res, q) {
  const conversationId = q.get('conversationId') || q.get('conversation');
  let list = [...images.values()];
  if (conversationId) list = list.filter((im) => im.conversationId === conversationId);
  list.sort((a, b) => msOf(b.ts) - msOf(a.ts));
  const limit = Math.max(1, Math.min(Number(q.get('limit')) || 200, 500));
  const page = list.slice(0, limit);
  send(res, 200, {
    count: page.length,
    total: list.length,
    conversationId: conversationId || null,
    images: page.map(imageView),
  });
}

/*
 * Images attached to a message, as opposed to written into its text.
 *
 * Both work and they are for different things: markdown `![](/images/<id>)`
 * puts a picture at a chosen point in a sentence, while this hangs a strip of
 * them under the message, which is what "here are the twelve crates" wants.
 *
 * Validated against what has actually been uploaded, not merely shape-checked.
 * An id that names nothing would render as a broken square in his thread, and a
 * broken square is indistinguishable from a bug in the page — so it is refused
 * at the point where the caller can still fix it.
 */
const MAX_ATTACH = 24;

function readImages(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return new Error('images must be an array of image ids');
  if (raw.length > MAX_ATTACH) {
    return new Error(`too many images: ${raw.length}, max ${MAX_ATTACH} on one message`);
  }
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') return new Error('every entry in images must be a string id');
    // A caller who pastes back the `url` this server handed them is doing the
    // obvious thing, so accept it rather than making them slice the prefix off.
    const id = v.trim().replace(/^\/?images\//, '');
    if (!IMAGE_ID_RE.test(id)) {
      return new Error(`"${v}" is not an image id: expected the 64-character sha256 returned by POST /images`);
    }
    if (!blobs.has(id)) {
      return new Error(`no image with id "${id}" — upload the bytes first with POST /images`);
    }
    if (out.indexOf(id) < 0) out.push(id); // the same picture twice is a typo, not a layout
  }
  return out.length ? out : null;
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
  const imgs = readImages(body.images);
  if (imgs instanceof Error) return fail(res, 400, imgs.message);
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
  if (imgs) task.images = imgs; // a reference picture sent TO an agent
  appendEvent({ t: 'create', task });
  notify('task', task, readNotifyHint(body));
  send(res, 201, task);
}

/*
 * POST /tasks/:entryId/checks — one checkbox changed.
 *
 * Idempotent by value: sending `on: true` twice is one state, not two events,
 * and the second is a no-op that still answers 200 with the current list. That
 * matters because the page retries this call after being offline, and a retry
 * must never be able to double-toggle a box he only touched once.
 */
function setCheckRoute(res, entryId, body) {
  const cl = checklistOf(entryId);
  if (!cl) {
    return fail(res, 404, `no checklist on entry "${entryId}"`, {
      hint: 'the entry must exist and its text must contain at least one "- [ ]" line',
    });
  }
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= cl.total) {
    return fail(res, 400, `index must be an integer 0..${cl.total - 1}`, { total: cl.total });
  }
  if (typeof body.on !== 'boolean') return fail(res, 400, 'on is required and must be true or false');
  const by = readString(body.by !== undefined ? body.by : body.who, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  const before = cl.items[index];
  if (before.checked === body.on && before.source === 'checked') {
    // Already exactly this, and already recorded. Nothing to log, nothing to
    // tell an agent — but the caller still gets the truth back.
    return send(res, 200, { changed: false, checklist: checklistOf(entryId) });
  }

  appendEvent({
    t: 'check',
    entryId: String(entryId),
    index,
    on: body.on,
    by: by || 'web',
    at: nowIso(),
  });
  queueCheckNotice(cl.conversationId, String(entryId), index, before.label, body.on);
  return send(res, 200, { changed: true, checklist: checklistOf(entryId) });
}

/** Is this claim old enough that another agent may take it? See CLAIM_LEASE_MS. */
function leaseOf(task) {
  if (task.status !== 'claimed') return null;
  if (task.result !== null && task.result !== undefined) return null; // answered: nothing to rescue
  const since = msOf(task.claimedAt || task.ts);
  const leftMs = since + CLAIM_LEASE_MS - Date.now();
  return { expired: leftMs <= 0, leftSec: Math.max(0, Math.round(leftMs / 1000)) };
}

/*
 * POST /messages — an agent speaking, rather than answering.
 *
 * Purely additive: `POST /tasks` is untouched, still sets `role: "user"`, and
 * every existing client behaves exactly as before. The record is an ordinary
 * task in the same event log, so the thread projection, the replay and the live
 * stream all handle it with no special case.
 *
 * It is born `done`. That is the whole point: a statement is not a request, so
 * it must not sit `pending`, must not appear in another agent's work poll, and
 * must not count as a backlog on the status page. `relayed: true` for the same
 * reason — there is nothing outstanding to deliver.
 */
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readString(raw, label, max) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return new Error(`${label} must be a string`);
  const v = raw.trim();
  if (!v) return null;
  if (v.length > max) return new Error(`${label} too long: ${v.length} chars, max ${max}`);
  return v;
}

function createMessage(res, body) {
  const text = typeof body.text === 'string' ? body.text : body.instruction;
  if (typeof text !== 'string' || !text.trim()) {
    return fail(res, 400, 'text (alias: instruction) is required and must be a non-empty string');
  }
  if (text.length > MAX_TEXT) {
    return fail(res, 400, `message too long: ${text.length} chars, max ${MAX_TEXT}`);
  }

  // Who is speaking. `agent` matches the field a conversation already uses for
  // this; `author` and `by` are accepted because both are natural to reach for.
  const authorRaw = body.agent !== undefined ? body.agent
    : (body.author !== undefined ? body.author : body.by);
  const author = readString(authorRaw, 'agent', MAX_AUTHOR);
  if (author instanceof Error) return fail(res, 400, author.message);
  const to = readString(body.to, 'to', MAX_AUTHOR);
  if (to instanceof Error) return fail(res, 400, to.message);
  const imgs = readImages(body.images);
  if (imgs instanceof Error) return fail(res, 400, imgs.message);

  const channelRaw = readString(body.channel, 'channel', MAX_CHANNEL);
  if (channelRaw instanceof Error) return fail(res, 400, channelRaw.message);
  const internal = body.internal === true || channelRaw !== null;

  const ts = nowIso();
  const task = {
    id: newId(),
    role: 'agent', // server-set, as on /tasks — the difference is the route, not the client
    instruction: text,
    from: typeof body.from === 'string' && body.from ? body.from : 'agent',
    author,
    ts,
    status: 'done',
    claimedBy: null,
    claimedAt: null,
    result: null,
    resultTs: null,
    relayed: true,
    relayedAt: ts,
  };
  if (to) task.to = to;
  if (imgs) task.images = imgs;

  if (internal) {
    const channel = channelRaw === null ? DEFAULT_CHANNEL : channelRaw;
    if (!CHANNEL_RE.test(channel)) {
      return fail(res, 400, `invalid channel "${channel}": letters, digits, dot, dash and underscore only`);
    }
    task.visibility = 'internal';
    task.channel = channel;
    task.conversationId = INTERNAL_PREFIX + channel;
  } else {
    const conversationId = typeof body.conversationId === 'string' && body.conversationId
      ? body.conversationId
      : (typeof body.conversation === 'string' && body.conversation ? body.conversation : DEFAULT_CONV);
    if (!conversations.has(conversationId)) {
      return fail(res, 400, `no conversation with id "${conversationId}"`, { conversationId });
    }
    task.visibility = 'conversation';
    task.conversationId = conversationId;
  }

  appendEvent({ t: 'create', task });
  // classify() drops anything internal, so a `channel` message can never buzz
  // his phone — that is the single most important rule in this whole feature.
  notify('message', task, readNotifyHint(body));
  send(res, 201, task);
}

/** The channel's own view of a message: no queue machinery, because there is none. */
const messageView = (t) => ({
  id: t.id,
  channel: channelOf(t),
  author: t.author || null,
  to: t.to || null,
  text: asText(t.instruction),
  ts: t.ts,
});

function channelSummaries() {
  const acc = new Map();
  for (const t of tasks.values()) {
    if (!isInternal(t)) continue;
    const ch = channelOf(t);
    let a = acc.get(ch);
    if (!a) { a = { channel: ch, messages: 0, lastTs: null, lastAuthor: null, lastText: '' }; acc.set(ch, a); }
    a.messages++;
    if (!a.lastTs || msOf(t.ts) >= msOf(a.lastTs)) {
      a.lastTs = t.ts;
      a.lastAuthor = t.author || null;
      a.lastText = asText(t.instruction).replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  return [...acc.values()].sort((a, b) => msOf(b.lastTs) - msOf(a.lastTs));
}

function claimTask(res, id, body) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  const by = typeof body.by === 'string' && body.by ? body.by : null;

  if (task.status === 'claimed') {
    const lease = leaseOf(task);
    if (lease) {
      // The holder re-claiming its own task is a renewal: proof it is still on
      // the job, given from inside a turn, which is the only evidence we trust.
      if (by !== null && by === task.claimedBy) {
        appendEvent({ t: 'patch', id, patch: { claimedAt: nowIso() } });
        return send(res, 200, task);
      }
      if (lease.expired) {
        const from = task.claimedBy || null;
        appendEvent({ t: 'patch', id, patch: {
          claimedBy: by, claimedAt: nowIso(), takenOverFrom: from, takenOverAt: nowIso(),
        } });
        return send(res, 200, task);
      }
    }
    return fail(res, 409, `task is already ${task.status}`, {
      status: task.status,
      id: task.id,
      claimedBy: task.claimedBy || null,
      claimedAt: task.claimedAt || null,
      // Not an invitation to poll — it is the difference between "come back in a
      // moment" and "this one is never coming back", which the caller could not
      // previously tell apart.
      leaseExpiresInSec: lease ? lease.leftSec : null,
    });
  }

  if (task.status !== 'pending') {
    return fail(res, 409, `task is already ${task.status}`, { status: task.status, id: task.id });
  }
  const patch = { status: 'claimed', claimedBy: by, claimedAt: nowIso() };
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
  /*
   * Pictures attached to the ANSWER, which is the path that actually matters:
   * an agent asked for twelve crates claims the task, renders them, and hands
   * them back here. Kept under `resultImages` rather than `images` so a task
   * that was SENT with a reference picture and ANSWERED with renders does not
   * have one overwrite the other — they are two different sets on one record.
   */
  const imgs = readImages(body.images);
  if (imgs instanceof Error) return fail(res, 400, imgs.message);
  // A result may be posted straight to a pending task; no claim required.
  const patch = { status: 'done', result: body.result, resultTs: nowIso() };
  if (imgs) patch.resultImages = imgs;
  appendEvent({ t: 'patch', id, patch });
  notify('result', task, readNotifyHint(body));
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
    /*
     * Archiving says nothing whatsoever about the agent, and must not be allowed
     * to imply otherwise. It files the conversation away; the agent carries on.
     * If you want it to wind down you have to ask, separately and explicitly,
     * with `stopRequested` — and even then see below about what that buys you.
     */
  }

  if (body.stopRequested !== undefined) {
    if (typeof body.stopRequested !== 'boolean') {
      return fail(res, 400, 'stopRequested must be true or false');
    }
    if (body.stopRequested) {
      patch.stopRequested = true;
      patch.stopRequestedAt = nowIso();
      patch.stopRequestedBy = typeof body.stopRequestedBy === 'string' && body.stopRequestedBy.trim()
        ? body.stopRequestedBy.trim().slice(0, MAX_AGENT)
        : 'human';
      // A fresh request clears any previous acknowledgement: an agent that
      // stopped, was reassigned, and is now being asked again must not still be
      // wearing the last round's "stopped" badge.
      patch.stopAck = null;
      patch.stopAckAt = null;
      patch.stoppedAt = null;
    } else {
      // Withdrawing the request. The agent may already have acted on it — there
      // is no recall — so this only clears the ask, never the acknowledgement.
      patch.stopRequested = false;
      patch.stopRequestedAt = null;
      patch.stopRequestedBy = null;
    }
  }

  if (!Object.keys(patch).length) {
    return fail(res, 400, 'nothing to update (title, agent, archived or stopRequested)');
  }
  appendEvent({ t: 'convpatch', id, patch });
  /*
   * Answer with the honest truth about what just happened, so no client can
   * render this as a kill by accident. Asking is not stopping, and the reply
   * says so in words a UI can put straight on the screen.
   */
  if (patch.stopRequested === true) {
    return send(res, 200, { ...conv, stopRequestEffect: stopRequestEffect(conv) });
  }
  /*
   * Filing away a conversation whose agent never stood down leaves a process
   * running that nothing on screen can see any more. That is a legitimate
   * choice — sometimes you just want the row gone — but it has to be a CHOSEN
   * one, so the reply always names the cost. Silence here is how a ghost gets
   * made by accident.
   */
  if (patch.archived === true) {
    return send(res, 200, { ...conv, ghost: ghostWarning(conv) });
  }
  send(res, 200, conv);
}

/** null when there is genuinely nothing left running; otherwise, the bad news. */
function ghostWarning(conv) {
  if (!conv.agent || conv.stopAck === 'stopped') return null;
  return {
    agentStillAssigned: conv.agent,
    stopped: false,
    summary: `Archived, but "${conv.agent}" was never confirmed stopped.`,
    detail: 'Archiving hides the conversation. It does not stop the agent, which may still '
      + 'be running, still holding git worktrees, and still able to post here — where you '
      + 'will no longer see it. Ask it to stop first if you want it wound down.',
    forceKill: FORCE_KILL_NOTE,
  };
}

/*
 * The paragraph the UI should show after asking a coordinator to stop. It lives
 * here rather than in the page because every client must say the same thing,
 * and because the one sentence that must never be dropped in a redesign is the
 * last one.
 */
function stopRequestEffect(conv) {
  const live = conv.agent
    ? `"${conv.agent}" will see this the next time something wakes it.`
    : 'No agent is assigned to this conversation, so nothing will read it.';
  return {
    requested: true,
    stopped: false,
    agent: conv.agent || null,
    summary: `Asked to stop. ${live}`,
    detail: 'This is a request, not a kill. The queue cannot start, signal or stop an '
      + 'agent: it can only leave a note that the agent reads the next time it wakes on '
      + 'its own. Until it acknowledges, assume it is still running and still holding any '
      + 'git worktrees it checked out.',
    forceKill: FORCE_KILL_NOTE,
  };
}

/*
 * Said in exactly one place so it cannot drift between the API and the page.
 * A UI that shows a stop control MUST be able to tell him where the real kill
 * switch is, because it is not here and never will be.
 */
const FORCE_KILL_NOTE = {
  availableHere: false,
  where: 'top-level Claude session',
  how: 'Only the top-level Claude session that spawned the agent can actually terminate '
    + 'it (TaskStop, or ending the session). Nothing in relay-queue — archiving, deleting, '
    + 'or unassigning — will stop a running agent.',
};

/*
 * POST /conversations/:id/stop-ack — the agent answering the note on the door.
 *
 * Two phases, and both matter. `stopping` means "I have seen it and I am winding
 * down": claims released, worktrees being handed back. `stopped` means the agent
 * is done, and is the ONLY thing in this system entitled to say so. It unassigns
 * itself as its last act, because an `agent` still set on a stopped conversation
 * is the ghost all over again.
 *
 * This is a write only an agent can make, from inside a turn, which is why it is
 * trustworthy in a way no timeout could be. There is no server-side fallback
 * that marks a conversation stopped after N minutes of silence: that would be
 * inventing the very confirmation this endpoint exists to require.
 */
function stopAckRoute(res, id, body) {
  const conv = conversations.get(id);
  if (!conv) return fail(res, 404, `no conversation with id "${id}"`);

  const phase = typeof body.phase === 'string' ? body.phase.trim() : '';
  if (phase !== 'stopping' && phase !== 'stopped') {
    return fail(res, 400, 'phase must be "stopping" (winding down) or "stopped" (finished)');
  }
  if (conv.stopAck === 'stopped' && phase === 'stopping') {
    return fail(res, 409, 'this conversation is already marked stopped; a stopped agent cannot go back to stopping', {
      stopAck: conv.stopAck, stoppedAt: conv.stoppedAt,
    });
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
  let worktrees = null;
  if (body.worktrees !== undefined && body.worktrees !== null) {
    if (!Array.isArray(body.worktrees)) return fail(res, 400, 'worktrees must be an array of strings');
    worktrees = body.worktrees
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim().slice(0, 300))
      .slice(0, 50);
  }

  const at = nowIso();
  const patch = { stopAck: phase, stopAckAt: at, stopNote: note };
  if (worktrees !== null) patch.worktrees = worktrees;
  if (phase === 'stopped') {
    patch.stoppedAt = at;
    // Its last act: stand down from the conversation. Recorded first so that
    // even if this is the final thing the agent ever does, the row is honest.
    patch.agent = null;
  }
  appendEvent({ t: 'convpatch', id, patch });

  /*
   * Worktrees are REPORTED, not verified — this server does not touch git and
   * has no way to know whether they were really released. Say so, so nobody
   * reads the list as a guarantee that the disk is clean.
   */
  send(res, 200, {
    ...conv,
    worktreesAreSelfReported: true,
    releasedBy: typeof body.agent === 'string' ? body.agent.slice(0, MAX_AGENT) : null,
  });
}

/*
 * POST /conversations/:id/activity — a coordinator narrating its own work.
 *
 * Deliberately tiny, and deliberately not required: an agent that reports
 * nothing behaves exactly as it does today, and the panel simply shows that
 * nothing was reported. The distinction between "quiet" and "not instrumented"
 * is carried by `reporting` in the feed response rather than being guessed at.
 */
const ACT_KINDS = new Set(['spawned', 'finished', 'tool', 'note']);

function activityRoute(res, id, body) {
  const conv = conversations.get(id);
  if (!conv) return fail(res, 404, `no conversation with id "${id}"`);

  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  if (!ACT_KINDS.has(kind)) {
    return fail(res, 400, `kind must be one of: ${[...ACT_KINDS].join(', ')}`, { got: kind || null });
  }
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const subagent = str(body.subagent, 100);
  if ((kind === 'spawned' || kind === 'finished') && !subagent) {
    return fail(res, 400, `kind "${kind}" needs a subagent name, so the panel can pair the two halves`);
  }

  /*
   * An explicit `at`, for backfill — and the entry is MARKED when one is used.
   *
   * A coordinator resumed mid-flight reports subagents it spawned before it was
   * instrumented. Stamping those with the arrival time made a worker that had
   * been running the better part of an hour report `runningForSec: 10`: a
   * plausible number that is wrong, which is the one thing this feed exists to
   * refuse. So the true start may be supplied — and never silently, because a
   * reconstructed timestamp that looks observed is the same defect wearing a
   * better disguise.
   *
   * Validated and REJECTED rather than coerced. Clamping a bad timestamp to now
   * would resurrect the original bug and hide it behind a 201.
   */
  let at = nowIso();
  let reconstructed = false;
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') {
      return fail(res, 400, 'at must be an ISO 8601 string', { got: typeof body.at });
    }
    const t = Date.parse(body.at);
    if (Number.isNaN(t)) {
      return fail(res, 400, 'at is not a date this server can parse', { got: body.at });
    }
    // A few seconds of tolerance for clock skew; beyond that a "start" in the
    // future is a bug in the caller, and accepting it would make a subagent
    // report a negative age.
    if (t > Date.now() + 5000) {
      return fail(res, 400, 'at is in the future — a subagent cannot have started after now', {
        got: body.at, now: nowIso(),
      });
    }
    if (t < Date.now() - ACT_AT_MAX_AGE_MS) {
      return fail(res, 400,
        `at is more than ${Math.round(ACT_AT_MAX_AGE_MS / 86400000)} days old, which is further back than this feed keeps anything`,
        { got: body.at });
    }
    at = new Date(t).toISOString();
    reconstructed = true;
  }

  const entry = {
    at,
    conversationId: id,
    kind,
    agent: str(body.agent, MAX_AGENT),   // who is reporting
    subagent,                            // who it is about, for spawned/finished
    task: str(body.task, 200),           // what that subagent was asked to do
    tool: str(body.tool, 80),
    text: str(body.text, 300),
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    // true = client-supplied `at`, false = server-stamped, null = pre-dates
    // this field. See actProvenance().
    reconstructed,
  };

  if (DURABLE_KINDS.has(kind)) {
    appendEvent({ t: 'act', entry }); // applyEvent pushes it into the ring
  } else {
    pushActivity(entry);
  }
  send(res, 201, { ok: true, entry, durable: DURABLE_KINDS.has(kind) });
}

/*
 * The panel's data. Subagents are folded up into a roster here rather than in
 * the browser, because pairing spawned/finished is the only part with a rule to
 * get wrong: a subagent is "running" until a `finished` with the same name
 * arrives, and one that never finishes stays visible forever on purpose.
 */
function activityOf(conversationId) {
  const feed = ACTIVITY.get(conversationId) || [];
  /*
   * ORDER BY TIME, NOT BY ARRIVAL, and this is load-bearing now that `at` can
   * be supplied by the client.
   *
   * The ring is in append order. Backfill deliberately carries an OLDER `at`
   * than the entries around it, so the two orders diverge — and pairing over
   * arrival order gets the answer wrong in a way that is not subtle: a
   * coordinator that reports `finished` for a worker and only afterwards
   * backfills its `spawned` would have the late-arriving spawn reset
   * `finishedAt` to null, and a subagent that completed successfully would sit
   * in the roster as "running" forever.
   *
   * Sorting first fixes the pairing, the feed order, and `lastAt` together. The
   * sort is stable in Node, so entries sharing a timestamp keep arrival order.
   */
  const ordered = feed.slice().sort((a, b) => msOf(a.at) - msOf(b.at));
  const subagents = new Map();
  let tools = 0;
  for (const e of ordered) {
    if (e.kind === 'tool') tools++;
    if (e.kind !== 'spawned' && e.kind !== 'finished') continue;
    const cur = subagents.get(e.subagent) || {
      name: e.subagent, task: null, startedAt: null, finishedAt: null, ok: null,
      startedAtReconstructed: null, finishedAtReconstructed: null,
      spawns: 0, finishes: 0,
    };
    if (e.kind === 'spawned') {
      /*
       * A SECOND `spawned` UNDER A NAME THAT ALREADY HAS ONE.
       *
       * The roster is keyed by name, so this row is about to be overwritten:
       * the task text is replaced, and if the name had already finished, the
       * verdict is cleared and it goes back to "running" — permanently, since
       * the coordinator already sent its one `finished`. That manufactures a
       * phantom worker that looks like it is still holding a worktree, which
       * is precisely the ghost this feature exists to expose. A well-meaning
       * worker announcing itself under a name already in use is enough.
       *
       * The overwrite is kept — the latest run is the useful one — but it is
       * COUNTED and disclosed rather than done silently, because a row that
       * quietly means something other than what it says is the same failure as
       * a heartbeat with nobody home. The UI warns on `nameCollision`.
       */
      cur.spawns++;
      cur.startedAt = e.at; cur.task = e.task || cur.task; cur.finishedAt = null; cur.ok = null;
      // Carried onto the roster so a consumer cannot read an inferred age as an
      // observed one. `runningForSec` below is derived from exactly this.
      cur.startedAtReconstructed = actProvenance(e.reconstructed);
      cur.finishedAtReconstructed = null;
    } else {
      cur.finishes++;
      cur.finishedAt = e.at; cur.ok = e.ok; if (e.task && !cur.task) cur.task = e.task;
      cur.finishedAtReconstructed = actProvenance(e.reconstructed);
    }
    subagents.set(e.subagent, cur);
  }
  const roster = [...subagents.values()].map((s) => ({
    ...s,
    running: s.finishedAt === null && s.startedAt !== null,
    runningForSec: s.finishedAt === null ? secSince(s.startedAt) : null,
    /*
     * The duration is only as trustworthy as the start it was measured from.
     * `false` means observed, `true` means the coordinator reconstructed the
     * start, `null` means the entry pre-dates the field and nothing here knows.
     */
    runningForSecIsApprox: s.finishedAt === null && s.startedAtReconstructed !== false,
    /*
     * The name was used by more than one run, so this row is the most recent
     * of them and the earlier ones are not separately recoverable — the feed
     * still has their entries, but the roster cannot tell them apart. Said out
     * loud so "running" under a reused name is not read as one worker that has
     * been going the whole time.
     */
    nameCollision: s.spawns > 1 || s.finishes > 1,
  }));
  return {
    entries: ordered,
    count: feed.length,
    capped: feed.length >= ACTIVITY_CAP,
    cap: ACTIVITY_CAP,
    subagents: roster,
    running: roster.filter((s) => s.running).length,
    toolCalls: tools,
    /*
     * The MAXIMUM timestamp, not the last one appended. Those were the same
     * thing until `at` became client-supplied; now a backfill arriving last
     * would have dragged "last heard" backwards into the past, so a busy
     * coordinator would look like it had gone quiet the moment it tidied up
     * its own history.
     */
    lastAt: ordered.length ? ordered[ordered.length - 1].at : null,
    /*
     * Empty means one of two very different things and the UI must not guess:
     * either this coordinator has done nothing, or nobody taught it to report.
     * Agents report nothing by default, so "never" is overwhelmingly the latter.
     */
    reporting: feed.length > 0,
    toolCallsAreEphemeral: true,
    ephemeralSince: new Date(STARTED_AT).toISOString(),
  };
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
      boot: BOOT_NONCE, // null in production; a harness's proof of identity
      port: server.address() ? server.address().port : PORT,
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

  // /conversations/:id/stop-ack — the agent, and only the agent, answering a
  // stop request. /conversations/:id/activity — what it is doing meanwhile.
  if (seg.length === 3 && seg[0] === 'conversations') {
    if (seg[2] === 'stop-ack') {
      if (!need('POST')) return;
      return stopAckRoute(res, seg[1], await readBody(req));
    }
    if (seg[2] === 'activity') {
      if (m === 'POST') return activityRoute(res, seg[1], await readBody(req));
      if (m === 'GET') {
        if (!conversations.has(seg[1])) return fail(res, 404, `no conversation with id "${seg[1]}"`);
        const a = activityOf(seg[1]);
        const limit = Math.max(1, Math.min(Number(q.get('limit')) || ACTIVITY_CAP, ACTIVITY_CAP));
        // Newest first: a panel opens on what just happened, not on history.
        return send(res, 200, { ...a, entries: a.entries.slice(-limit).reverse() });
      }
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
    }
    return fail(res, 404, `no such conversation route "${seg[2]}"`, { known: ['stop-ack', 'activity'] });
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

  // /sw.js — the service worker, the one file the page cannot inline
  if (seg.length === 1 && seg[0] === 'sw.js') {
    if (!need('GET')) return;
    return sendServiceWorker(res);
  }

  // /manifest.webmanifest and the icons — the installable-app metadata
  if (seg.length === 1 && seg[0] === 'manifest.webmanifest') {
    if (!need('GET')) return;
    return sendManifest(res);
  }
  if (seg.length === 1 && icons.names().indexOf(seg[0]) >= 0) {
    if (!need('GET')) return;
    return sendIcon(res, seg[0]);
  }

  // /push/* — web push subscriptions and the quiet-hours config
  if (seg.length === 2 && seg[0] === 'push') {
    const what = seg[1];
    if (what === 'config') {
      if (m === 'GET') return send(res, 200, pushSnapshot(q.get('deviceId')));
      if (m === 'POST') return pushConfigRoute(res, await readBody(req));
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
    }
    if (what === 'subscribe') {
      if (!need('POST')) return;
      return subscribeRoute(res, await readBody(req));
    }
    if (what === 'unsubscribe') {
      if (!need('POST')) return;
      return unsubscribeRoute(res, await readBody(req));
    }
    if (what === 'test') {
      if (!need('POST')) return;
      return pushTestRoute(res, await readBody(req));
    }
  }

  /*
   * /images — the gallery. A new top-level segment that shadows nothing: no
   * existing route, icon name or static path begins with it, so every request
   * that worked before this feature still reaches exactly the handler it did.
   */
  if (seg.length === 1 && seg[0] === 'images') {
    if (m === 'GET') return imageListRoute(res, q);
    if (m === 'POST') return imageUploadRoute(req, res, q);
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }
  if (seg.length === 2 && seg[0] === 'images') {
    if (m !== 'GET' && m !== 'HEAD') {
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, HEAD' });
    }
    return imageBytesRoute(req, res, seg[1]);
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

  // /messages — an agent speaking for itself, and the agent-to-agent channel
  if (seg.length === 1 && seg[0] === 'messages') {
    if (m === 'POST') return createMessage(res, await readBody(req));
    if (m === 'GET') {
      // Reading is by channel; there is no "all messages" view, because the
      // human's thread is already that and this is deliberately not in it.
      const channel = q.get('channel') || DEFAULT_CHANNEL;
      let list = [...tasks.values()].filter((t) => isInternal(t) && channelOf(t) === channel);
      const since = q.get('since');
      if (since !== null) {
        const ms = parseSince(since);
        if (ms === null) throw httpErr(400, `invalid since "${since}" (want ISO 8601 or epoch ms)`);
        list = list.filter((t) => Date.parse(t.ts) > ms);
      }
      const limit = q.get('limit');
      if (limit !== null) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 0) throw httpErr(400, `invalid limit "${limit}"`);
        list = n === 0 ? [] : list.slice(-n); // most recent N — a channel reads from the end
      }
      return send(res, 200, { count: list.length, channel, messages: list.map(messageView) });
    }
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /channels — which internal channels exist, so one is discoverable at all
  if (seg.length === 1 && seg[0] === 'channels') {
    if (!need('GET')) return;
    const list = channelSummaries();
    return send(res, 200, { count: list.length, defaultChannel: DEFAULT_CHANNEL, channels: list });
  }

  // /results
  if (seg.length === 1 && seg[0] === 'results') {
    if (!need('GET')) return;
    // Answers, not merely finished records. An agent's own message is `done` the
    // moment it is posted and has no result, so it does not belong here.
    const done = [...tasks.values()].filter((t) => t.status === 'done' && t.result !== null && t.result !== undefined);
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

  // /checklists — every task list in the queue, or in one conversation.
  // This is the "what is on his list right now" question, answerable by an agent
  // in one call without parsing the thread itself.
  if (seg.length === 1 && seg[0] === 'checklists') {
    if (!need('GET')) return;
    const conv = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
    let list = allChecklists(conv || null);
    const open = q.get('open');
    if (open !== null && open !== 'false' && open !== '0') list = list.filter((c) => c.remaining > 0);
    return send(res, 200, { count: list.length, checklists: list });
  }

  // /tasks/:id/(claim|result|relayed|checks)
  if (seg.length === 3 && seg[0] === 'tasks') {
    const [, id, action] = seg;
    if (action === 'checks') {
      if (m === 'GET') {
        const cl = checklistOf(id);
        if (!cl) return fail(res, 404, `no checklist on entry "${id}"`);
        return send(res, 200, cl);
      }
      if (m === 'POST') return setCheckRoute(res, id, await readBody(req));
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
    }
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
module.exports = { repairTranscript, metaphone, headline, stuckClaims, classify, browserLabel };

if (require.main !== module) return;

fs.mkdirSync(DATA_DIR, { recursive: true });
ensureDefaultConv(); // before replay, so a rename of it replays onto something
const replayed = replay();
ensureDefaultConv(); // ...and after, in case the log somehow removed it
if (PUSH_ON) vapidKeys = loadVapidKeys(); // after mkdir: the key file lives in DATA_DIR
server.listen(PORT, HOST, () => {
  const c = counts();
  /*
   * The port we ASKED for is not necessarily the port we GOT: PORT=0 means "any
   * free one", which is how the selftests avoid fighting each other over a fixed
   * number. Print what the socket actually bound, because a harness reads this
   * line to learn where its own child is listening — and a log that echoed the
   * request back would hand it "0" and, worse, would keep looking correct on the
   * day the two ever differed.
   */
  const bound = server.address();
  const boundPort = bound && typeof bound === 'object' ? bound.port : PORT;
  console.log(`${NAME} v${VERSION} listening on http://${HOST}:${boundPort}`);
  console.log(`log: ${LOG_FILE} (${replayed.events} events replayed, ${replayed.skipped} skipped)`);
  const ui = findUiFile();
  console.log(ui ? `ui:  ${ui.file}` : `ui:  MISSING — searched ${UI_FILES.join(', ')}`);
  console.log(`tasks: ${tasks.size} total — ${c.pending} pending, ${c.claimed} claimed, ${c.done} done, ${c.unrelayed} unrelayed`);
  if (!PUSH_ON) {
    console.log('push: disabled (PUSH=0)');
  } else {
    const quiet = wp.quietState(pushConfig);
    console.log(`push: ${subscriptions.size} device(s) armed; quiet hours ${quiet.configured ? `${quiet.from}-${quiet.to}` : 'off'} in ${quiet.timezone} (now ${quiet.zoneNow}${quiet.active ? ', ACTIVE' : ''})`);
    if (!quiet.zoneKnown) console.log(`push: WARNING timezone "${quiet.requestedTimezone}" is unknown to this runtime — falling back to UTC`);
  }
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
