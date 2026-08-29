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
/*
 * Publishing a conversation as a public snapshot. It COPIES rather than
 * proxies, because he asked for a link that works when this machine is off —
 * see the header of share.js for why a tunnel cannot answer that.
 */
const share = require('./share.js');

const NAME = 'relay-queue';
const VERSION = '1.6.0';
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

/*
 * PROGRESS NOTES. A task accepts exactly one result, and posting it closes the
 * task — so for an agent doing ten minutes of real work, the only way to say
 * "still here" was to spend the one answer it had. It therefore said nothing,
 * and silence is indistinguishable from death: the watchdog called healthy
 * agents dead three times in one night, and a coordinator believed it and
 * started a second agent on top of the first.
 *
 * A note is short and capped, and only the newest few are kept. This is a
 * running commentary, not an audit log — the event log keeps every one of them
 * regardless, and the record on the task exists to be READ, by a human on a
 * phone and by a watchdog deciding whether anyone is home.
 */
const MAX_NOTE = 500;      // one note; deliberately far below MAX_TEXT
const PROGRESS_CAP = 20;   // notes kept on the record; the log keeps them all

// --- conversations ---------------------------------------------------------
// Every task belongs to exactly one conversation. Records written before
// conversations existed have no conversationId and replay into DEFAULT_CONV, so
// the whole existing history lands in one sensible thread and every pre-existing
// curl call (which sends no conversationId) keeps working unchanged.
const DEFAULT_CONV = 'main';
const DEFAULT_CONV_TITLE = 'Main';
const MAX_TITLE = 200;
const MAX_AGENT = 200;
// A departure reason is a LABEL, not a report - "done", "handed off", "crashed".
// Capped well below MAX_NOTE so nobody is tempted to file a handover in it;
// the handover goes in a message or a task result, where it can be read.
const MAX_LEFT_REASON = 120;
/*
 * Session boundaries kept per conversation. This rides along on every
 * /conversations read, which the page polls, so it is capped rather than
 * unbounded — and capped at a number far larger than anyone will ever scroll
 * past, so the cap never silently eats a boundary he was looking for.
 */
const MAX_CONTEXT_MARKS = 100;

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
 *
 * TWO POOLS, not one, added 2026-08-23 after checking the actual log rather
 * than trusting the theory above. A single shared counter meant "done" spam
 * and real alerts drew from the same six slots, so on a busy day the ceiling
 * did the opposite of its job: in one hour it dropped 11 "needs-you" and 3
 * "broken" pushes — the ones he actually has to act on — right alongside the
 * routine "done" chatter it was built to cap. Splitting the pool keeps the
 * original spam cap on "done" (still 6, still the number that mattered on
 * 2026-08-08) while giving needs-you/broken — rare by construction, since
 * they only fire on a real question or a real failure — their own, more
 * generous ceiling so routine noise can never crowd out something urgent.
 */
const PUSH_PER_HOUR = Number(process.env.PUSH_PER_HOUR || 6); // "done" pool
const PUSH_PER_HOUR_ALERTS = Number(process.env.PUSH_PER_HOUR_ALERTS || 20); // needs-you + broken, shared

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
/*
 * Where a conversation is currently published, if it is: conversationId ->
 * { slug, url, sharedAt, ... }. Keyed by conversation so that re-sharing
 * overwrites the snapshot in place and every link he has already sent keeps
 * working. Absence means not shared; revoking deletes the row.
 */
const shares = new Map();
/*
 * Which attached pictures he has chosen, keyed by THREAD ENTRY id exactly as
 * `checks` is, and for the same reason: a task carries two independent image
 * sets — the references sent WITH it and the renders sent BACK — and they must
 * be selectable separately. Value: { [index]: { on, by, at } }.
 *
 * The message is the source of truth for WHICH pictures are on offer; these
 * events are the source of truth for WHICH ONE HE PICKED. Neither is a copy of
 * the other, so they cannot drift, and a revised set of candidates is a new
 * message that correctly starts with nothing chosen.
 */
const picks = new Map();
/*
 * CREDITS. A flat 1-credit-per-feature economy: the human awards credits for
 * genuinely significant real-world completions (a chore), and a coordinator
 * must spend exactly 1 before implementing any feature, declining if the
 * balance is 0. Replaces a free-text convention (`POST /messages` with
 * `channel:"credits"`, latest message's prose parsed as a running balance)
 * that had no structured amount/reason, no audit trail beyond scrolling, and
 * raced under two coordinators doing read-then-post-decremented-value.
 *
 * `creditsBalance` is the replayed total, not a ledger to sum on every read —
 * same split `mutations`/`tasks` already use between the append-only log and
 * the in-memory projection of it. `creditsHistory` is that same replay's
 * record of individual awards/spends, capped in memory (the log keeps every
 * one regardless, exactly like PROGRESS_CAP/ACTIVITY_CAP elsewhere).
 */
let creditsBalance = 0;
const creditsHistory = []; // oldest first; capped in memory, log keeps every entry
const CREDITS_HISTORY_CAP = 200;
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
  const at = nowIso();
  return {
    id,
    title,
    agent: agent || null, // who is meant to answer here; set and read by the agent side
    /*
     * WHEN THE CURRENT OCCUPANT SAT DOWN. Null whenever the chair is empty.
     *
     * sweepVacantChairs() asks "has whoever is sitting here gone quiet", and
     * every other clock it has answers a different question: `lastActedAt`,
     * `lastProgressAt` and the heartbeat all describe the TAB, and a tab that
     * has been quiet for an hour is quiet no matter who just sat down in it.
     * Without this field, seating a new agent in a long-quiet tab hands them a
     * clock that was already expired before they arrived, and the next sweep
     * vacates them on sight — see the sweep, and the honesty check at the end
     * of updateConversation() that caught this shape returning HTTP 200.
     *
     * It is deliberately NOT evidence of life, and nothing but the sweep should
     * read it that way. It says only "the chair was filled at this time", which
     * is exactly enough to give a new occupant the same full CHAIR_VACANT_MS of
     * silence everyone else gets before being presumed gone.
     */
    agentSince: agent ? at : null,
    createdAt: at,
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
    /*
     * WHO SPAWNED THE AGENT — and therefore who, if anyone, is able to kill it.
     *
     * This queue cannot stop a process and never will (see FORCE_KILL_NOTE).
     * The only thing that can is the top-level session that started the agent,
     * so a "stop it for real" control is only honest if it knows WHICH session
     * that was. Null is the truthful default and means exactly one thing: this
     * server has no record, so nothing may claim a kill is available. It is
     * never inferred — a guess here would put a confident button in front of a
     * process nobody can reach, which is the failure the whole stop/ack design
     * exists to refuse.
     */
    spawnedBy: null,
    /*
     * The context watermark for a cleared session. A fresh agent seated in this
     * conversation reads `?since=<contextFrom>` instead of the whole backlog, so
     * "clear" means the next occupant genuinely starts blank while the history
     * stays readable to the human. Null means never cleared, which is not the
     * same as cleared-at-the-beginning and must not render as it.
     */
    contextFrom: null,
    /*
     * EVERY watermark ever set here, oldest first, as `{ at, agent }` — where
     * `agent` is whoever was being cleared AWAY, the only occupant known at the
     * time. `contextFrom` alone is a single scalar and answers the agent's
     * question ("where do I start reading?"); it cannot answer the human's
     * ("where did each session begin?"), because setting a second watermark
     * overwrites the first. The thread draws one divider per entry here, so a
     * tab cleared five times shows five session boundaries instead of silently
     * losing four of them.
     */
    contextMarks: [],
    /*
     * A REQUEST ABOUT THIS TAB THAT IS CURRENTLY SITTING IN SOMEONE'S QUEUE.
     * `{ kind, at, taskId }`, or null when nothing is outstanding.
     *
     * This exists because of a race that happened within minutes of the clear
     * control shipping: a clear was queued for the Router, the Router acted on
     * it and spawned a fresh coordinator, and the tab was archived two seconds
     * later — so a brand new agent woke up inside a closed tab. It was caught
     * only because a human happened to be watching that tab. Nothing told
     * anyone, because a queued request had no representation anywhere except as
     * prose in a message.
     *
     * Recorded on the conversation rather than inferred from the queue so that
     * archiving can cancel it in the same write that archives, with no text
     * matching and no second round trip that could be interrupted half way.
     */
    pendingDispatch: null,
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
    spawnedBy: null, contextFrom: null, contextMarks: [], pendingDispatch: null,
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
  } else if (ev.t === 'progress') {
    /*
     * One "still working" note against a task that is still open. Appended
     * rather than patched, so a note costs a couple of hundred bytes instead of
     * rewriting the whole list every time, and two notes can never lose each
     * other to a read-modify-write.
     *
     * ROLLBACK SAFETY: a build that predates this branch falls off the end of
     * the chain and ignores the event — see the note there — so a log written
     * by this version replays on the old one with nothing skipped. `skipped`
     * counts only lines that fail to PARSE, never ones nothing handles.
     */
    const task = tasks.get(ev.id);
    if (task && ev.entry) {
      if (!Array.isArray(task.progress)) task.progress = [];
      task.progress.push(ev.entry);
      while (task.progress.length > PROGRESS_CAP) task.progress.shift();
      task.lastProgressAt = ev.entry.at;
      task.progressCount = (task.progressCount || 0) + 1;
    }
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
  } else if (ev.t === 'agent') {
    // A self-chosen name claimed. Keyed by the FOLDED form, which is what makes
    // two spellings that cannot be told apart the same agent rather than two.
    if (ev.agent && typeof ev.agent.fold === 'string') agentsByFold.set(ev.agent.fold, ev.agent);
  } else if (ev.t === 'agentpatch') {
    const a = agentsByFold.get(ev.fold);
    if (a) Object.assign(a, ev.patch);
  } else if (ev.t === 'inbox') {
    // The durable half of an addressed message. The file the agent tails is
    // written separately, at the moment of delivery — see agentMessageRoute.
    let box = INBOX.get(ev.fold);
    if (!box) { box = []; INBOX.set(ev.fold, box); }
    box.push(ev.msg);
    while (box.length > INBOX_CAP) box.shift();
    const a = agentsByFold.get(ev.fold);
    if (a) { a.inboxCount = (a.inboxCount || 0) + 1; a.lastDeliveredAt = ev.msg.ts; }
  } else if (ev.t === 'inboxack') {
    const box = INBOX.get(ev.fold) || [];
    const msg = box.find((m) => m.id === ev.id);
    if (msg && !msg.ackedAt) {
      msg.ackedAt = ev.at;
      const a = agentsByFold.get(ev.fold);
      if (a) { a.ackedCount = (a.ackedCount || 0) + 1; a.lastAckedAt = ev.at; }
    }
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
      if (meta) {
        meta.posts++;
        // The first description of a picture wins. Later postings of the same
        // bytes are usually a re-send, and letting one silently retitle a
        // picture already on his screen is a change he never asked for.
        if (!meta.alt && im.alt) meta.alt = im.alt;
      } else {
        blobs.set(im.blob, {
          type: im.type, bytes: im.bytes, width: im.width, height: im.height,
          alt: im.alt || null, posts: 1,
        });
      }
    }
  } else if (ev.t === 'check') {
    // One tick. Last write wins, and the record keeps who and when, because
    // "who ticked this" is the first question asked of a shared list.
    let row = checks.get(ev.entryId);
    if (!row) { row = {}; checks.set(ev.entryId, row); }
    row[String(ev.index)] = { on: !!ev.on, by: ev.by || null, at: ev.at };
  } else if (ev.t === 'list') {
    /*
     * The whole list, every structural change. These are tens of items, not
     * thousands, and a full snapshot replays correctly no matter what order
     * adds, edits and removes were written in — whereas a stream of deltas has
     * to be replayed perfectly to land on the right answer, and a list that
     * silently rebuilds wrong is worse than one that is slightly larger on disk.
     */
    lists.set(ev.conversationId, ev.list);
  } else if (ev.t === 'listtick') {
    // Ticks stay their own tiny event: it is the frequent one, and it must not
    // rewrite the item text as a side effect of someone tapping a box.
    const l = lists.get(ev.conversationId);
    if (l) {
      const it = l.items.find((i) => i.id === ev.itemId);
      if (it) {
        it.done = !!ev.on;
        it.doneAt = ev.on ? ev.at : null;
        it.doneBy = ev.on ? (ev.by || null) : null;
        // Un-ticking discards the "these were the words you ticked" note: there
        // is no longer a tick for it to qualify.
        if (!ev.on) it.tickedText = null;
      }
    }
  } else if (ev.t === 'pick') {
    /*
     * One choice. `exclusive` is how single-select stays consistent no matter
     * which client wrote it: the whole row is replaced rather than the caller
     * being trusted to un-pick the others, so a replay and a live tap agree.
     */
    let row = picks.get(ev.entryId);
    if (!row || (ev.exclusive && ev.on)) { row = {}; picks.set(ev.entryId, row); }
    row[String(ev.index)] = { on: !!ev.on, by: ev.by || null, at: ev.at };
  } else if (ev.t === 'share') {
    // Publishing is durable state: after a restart the UI must still know the
    // conversation is public and still be able to take it down.
    if (ev.share && ev.share.conversationId) shares.set(ev.share.conversationId, ev.share);
  } else if (ev.t === 'unshare') {
    shares.delete(ev.conversationId);
  } else if (ev.t === 'creditsAward' || ev.t === 'creditsSpend') {
    // Both event types carry the signed delta they apply, so replay is one
    // line regardless of direction — award logs +amount, spend always logs -1
    // (the flat per-feature cost; see spendCredits for where that is enforced).
    const delta = ev.t === 'creditsAward' ? ev.amount : -1;
    creditsBalance += delta;
    creditsHistory.push({ amount: delta, reason: ev.reason || null, by: ev.by || null, at: ev.at });
    while (creditsHistory.length > CREDITS_HISTORY_CAP) creditsHistory.shift();
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
  else if (ev.t === 'share' || ev.t === 'unshare') { /* publication state, not thread content; the panel reads it on open */ }
  else if (ev.t === 'creditsAward' || ev.t === 'creditsSpend') { /* not thread state; polled via GET /credits, nothing to stream */ }
  else if (ev.t === 'check') broadcast(taskIdOfEntry(ev.entryId));
  /*
   * The tab list belongs to a conversation, not to a task. Without this it
   * would fall through to the task broadcast below and be published under
   * `undefined` — a stream event naming nothing, which every client would
   * either ignore or, worse, treat as a task it should go and re-read.
   */
  else if (ev.t === 'list' || ev.t === 'listtick') broadcastConv(ev.conversationId);
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

/*
 * ---------------------------------------------------------------- text safety
 *
 * `fatal: true` is the entire point. The default decoder replaces whatever it
 * cannot read and says nothing, which is how mojibake reached a permanent log.
 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const REPLACEMENT = '\uFFFD';

/** Does this value carry a replacement character - i.e. text that is already lost? */
function isDamaged(v) {
  if (typeof v === 'string') return v.indexOf(REPLACEMENT) >= 0;
  if (v === null || v === undefined) return false;
  try { return JSON.stringify(v).indexOf(REPLACEMENT) >= 0; } catch { return false; }
}

/*
 * Refusing text that is ALREADY lost.
 *
 * Distinct from the UTF-8 check in readBody, and it has to be: bytes that
 * already encode U+FFFD are perfectly well-formed, so the strict decoder waves
 * them through. Something upstream did the damage and the original characters
 * are gone - writing that into an append-only archive makes the loss permanent
 * and invisible at once.
 *
 * WHERE THIS IS SAFE TO APPLY IS THE WHOLE DESIGN. It is used only on the two
 * routes the page provably never calls: POST /messages and POST
 * /tasks/:id/result are agents speaking and agents answering. POST /tasks is
 * shared with his own typed and dictated messages, so that one WARNS and stores
 * instead. Refusing an agent is good - it retries. Refusing him loses the
 * message, which is far worse than the bug being fixed.
 *
 * Deliberately NOT keyed on PAGE_ORIGINS. That set is an allowlist whose
 * default is "treat as an agent", and the comment above it records a posting
 * surface nobody remembered to add slipping through once already. Betting his
 * messages on that list staying complete is the same wager with a worse payout.
 */
function refuseDamaged(res, what) {
  return fail(res, 400,
    `${what} already contains a replacement character (U+FFFD), so part of it is already lost - nothing was stored`, {
      why: 'the text was mangled before it reached this server. The original characters cannot be '
        + 'recovered here, so storing it would put a permanent, silent gap in the archive.',
      fix: [
        'write the JSON to a file and send that: curl --data-binary @body.json',
        'PowerShell: pass ([System.Text.Encoding]::UTF8.GetBytes($json)) as the body',
        'or write the message in plain ASCII',
      ],
    });
}

/*
 * Where the bytes went wrong, in the caller's own text, because a 400 that is
 * merely correct gets retried unchanged. Decoding lossily on purpose: this runs
 * only on the failure path, and the position of the first replacement is
 * exactly the spot the caller needs to look at.
 */
function mojibakeDetail(buf) {
  const lossy = buf.toString('utf8');
  const at = lossy.indexOf(REPLACEMENT);
  const near = at < 0 ? null : {
    atCharacter: at,
    context: `${lossy.slice(Math.max(0, at - 40), at)}  <<HERE>>  ${lossy.slice(at + 1, at + 40)}`,
  };
  return {
    why: 'some bytes were re-encoded before they reached this server - almost always a shell '
      + 'rewriting the text on its way into curl. An em-dash sent as a lone CP1252 byte arrives '
      + 'like this.',
    wasPreviously: 'accepted with a 201 and stored with the character replaced, permanently',
    fix: [
      'write the JSON to a file and send that: curl --data-binary @body.json',
      'PowerShell: pass ([System.Text.Encoding]::UTF8.GetBytes($json)) as the body',
      'or write the message in plain ASCII',
    ],
    near,
  };
}

/*
 * THE WRITE THAT SUCCEEDS AND CORRUPTS IS THE WORST OF THE THREE OUTCOMES.
 *
 * `buf.toString('utf8')` - what stood here - SILENTLY substitutes U+FFFD
 * for every byte it cannot decode. So a shell that re-encoded an em-dash
 * into a lone CP1252 0x97 got back a cheerful 201, and the replacement
 * character went into an append-only archive where the original is now
 * unrecoverable. 26 of the 3060 events in the live log are damaged this
 * way, by ten different authors - the shared write path, not one bad shell.
 *
 * Verified on a scratch server rather than assumed: a body containing a
 * lone 0x97 stored as U+FFFD with HTTP 201, while the same text sent as
 * proper UTF-8 stored byte for byte. The corruption was this line.
 *
 * REFUSING IS SAFE FOR HIM, and that is the constraint that decides it.
 * His messages arrive from the page through `fetch` with a
 * `JSON.stringify` body, and that path encodes JS strings to UTF-8
 * itself - it cannot emit a malformed sequence, not even from a lone
 * surrogate, which it encodes as a well-formed U+FFFD. So this refuses
 * mangled agent writes and can never refuse a typed or dictated message.
 * Dictation does not pass through here at all: /stt reads raw audio bytes.
 *
 * Pulled out of readBody() as its own function so the v2 (Hono) routes
 * below can parse a body with IDENTICAL semantics — same empty-body-is-{},
 * same malformed-JSON message, same UTF-8 strictness — without a second,
 * drifting implementation. Throws the same httpErr shapes readBody rejected
 * with; callers that don't already return a Promise (Hono handlers) can
 * try/catch this synchronously.
 */
function parseBodyBuffer(buf) {
  let raw;
  try {
    raw = UTF8_STRICT.decode(buf);
  } catch {
    throw Object.assign(
      httpErr(400, 'the request body is not valid UTF-8, so nothing was stored'),
      { detail: mojibakeDetail(buf) },
    );
  }
  raw = raw.trim();
  if (!raw) return {}; // empty body is a valid "no fields" request
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw httpErr(400, 'malformed JSON body');
  }
}

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
      try {
        resolve(parseBodyBuffer(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
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
/*
 * An attached picture, as the thread hands it to a page.
 *
 * Expanded from the bare id the record stores, because the page needs the
 * DIMENSIONS to reserve the right box before the bytes arrive — a thread full
 * of images that resizes as each one lands is unreadable on a phone, and he
 * reads this on a phone. Width and height are whatever the header said and may
 * legitimately be null; a page that gets null lays out flexibly, where a page
 * given a guess would lay out around a wrong number.
 */
const imageRef = (blob) => {
  const meta = blobs.get(blob) || {};
  return {
    id: blob,
    url: `/images/${blob}`,
    /*
     * Where to open the bytes, spelled for the host — agents read pictures off
     * the disk, and a URL alone leaves them describing "an attachment" they
     * never opened. Computed at read time, never logged, so it stays true if
     * the data directory moves.
     */
    path: hostImagePath(blob),
    type: meta.type || null,
    width: meta.width === undefined ? null : meta.width,
    height: meta.height === undefined ? null : meta.height,
    alt: meta.alt || null,
  };
};

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
  if (Array.isArray(t.images) && t.images.length) first.images = t.images.map(imageRef);
  /*
   * DERIVED, never stored, and therefore retroactive: the 26 events already
   * damaged in the live log light up without rewriting one byte of an
   * append-only archive. A stored flag would have needed a migration and would
   * have been wrong for every record written before it existed.
   */
  if (isDamaged(first.text)) first.damaged = true;
  /*
   * WHO HOLDS THIS. `claimedBy` has always been on the record and has never
   * reached his page, so ownership was visible to the queue and to nobody else
   * — which is half of how two agents ended up on one job. Added only when
   * something actually holds it, so an unclaimed message is byte-for-byte the
   * shape every existing client was written against.
   */
  if (t.claimedBy) first.claimedBy = t.claimedBy;
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
    if (Array.isArray(t.resultImages) && t.resultImages.length) reply.images = t.resultImages.map(imageRef);
    if (isDamaged(reply.text)) reply.damaged = true;
    out.push(reply);
  }
  /*
   * A tick is a change to the entry, so it has to move `rev` — a client polling
   * `since=<rev>` would otherwise never be told, and his second device would sit
   * showing a stale list until something unrelated happened in the thread.
   */
  /*
   * Selectable pictures ride along with the entry so the page can draw the
   * picker without a second request, and a pick moves `rev` for the same reason
   * a tick does: a client polling since=<rev> would otherwise never be told,
   * and his other device would sit showing a stale choice.
   */
  for (const e of out) {
    const pl = pickListOf(e.id);
    if (!pl) continue;
    e.selection = { mode: pl.mode, total: pl.total, picked: pl.picked, decided: pl.decided, items: pl.items };
    const prow = picks.get(e.id);
    if (!prow) continue;
    let latest = msOf(e.rev);
    for (const k of Object.keys(prow)) latest = Math.max(latest, msOf(prow[k].at));
    e.rev = new Date(latest).toISOString();
  }
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
    /*
     * The tab list, if any, that absorbed this one's open items. There are 16
     * of these in Chores alone and not one of them can be deleted, so the only
     * way they stop competing with their replacement is to SAY they have one.
     * Null on the overwhelming majority, which have never been imported.
     */
    supersededBy: supersederOf(entryId),
  };
}

// ---------------------------------------------------------------- the tab list
/*
 * THE STICKY LIST: one editable checklist per conversation, and the deliberate
 * opposite of the one above it.
 *
 * The message checklist stores no items on purpose — they are parsed from an
 * append-only message, so "what is on the list" and "what is ticked" cannot
 * drift, and editing is impossible BY CONSTRUCTION. That is the right rule for
 * a message. It is the wrong rule for a list you live with, and the Chores tab
 * is the receipt: 16 checklists with open items, 44 open items between them,
 * NINE of them one-item lists, and the same laundry list posted twice at
 * different lengths. Nobody was being sloppy. A coordinator asked to add one
 * chore had exactly one move available — post another list — because the words
 * it needed to change were already immutable.
 *
 * So this is a different OBJECT, not a change to that one. Both survive.
 *
 * THE DECISION THAT MAKES IT WORK: a tick is keyed to an item's IDENTITY, not
 * to its position in a body of text. The message version keys ticks by the
 * ordinal of the line, which is precisely why it cannot be edited — insert a
 * chore at the top and every tick below it slides onto the wrong task. Here the
 * id is minted once, when the item is created, and nothing else is ever allowed
 * to address an item. Reordering, rewording and inserting are all safe, and the
 * feature the fragmentation was working around simply exists.
 *
 * A TICK SURVIVES AN EDIT, and that is a judgement, not an oversight. Dropping
 * it on every edit would restore the original problem with extra steps: a
 * coordinator fixing a typo would silently un-tick finished work, so it would
 * go back to posting a new list instead. But a tick earned against different
 * words is not quite the same fact, so the words that were ticked are kept in
 * `tickedText` and shown. Nothing is silently reinterpreted.
 */
const MAX_LIST_ITEMS = 200;
const MAX_LIST_TEXT = 500;

/** @type {Map<string, object>} conversationId -> the one list for that tab */
const lists = new Map();

function newListItem(text, by) {
  return {
    id: newId(),
    text,
    done: false,
    doneAt: null,
    doneBy: null,
    // The wording that was actually ticked, filled in only when an item is
    // edited while done. Null on everything else, so "edited since ticked" is
    // a fact the payload states rather than something a client infers.
    tickedText: null,
    addedAt: nowIso(),
    addedBy: by || null,
    editedAt: null,
  };
}

function newList(conversationId, title, by) {
  return {
    conversationId,
    title: title || null,
    items: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    updatedBy: by || null,
    /*
     * The message checklists whose open items were pulled in here. Kept so the
     * OLD list can say where its items went: 16 of them exist and none can be
     * deleted, so the only honest outcome is that they point at their successor
     * instead of quietly disagreeing with it.
     */
    importedFrom: [],
  };
}

/** Which conversation's list, if any, absorbed this message checklist. */
function supersederOf(entryId) {
  const id = String(entryId || '');
  for (const l of lists.values()) {
    if (l.importedFrom && l.importedFrom.indexOf(id) !== -1) return l.conversationId;
  }
  return null;
}

function listView(conversationId) {
  const l = lists.get(conversationId);
  if (!l) return null;
  const done = l.items.filter((i) => i.done).length;
  return {
    ...l,
    items: l.items.map((i) => ({ ...i, editedSinceTicked: !!(i.done && i.tickedText) })),
    total: l.items.length,
    done,
    remaining: l.items.length - done,
  };
}

function readListText(v, what) {
  if (typeof v !== 'string') return new Error(`${what} must be a string`);
  const t = v.trim();
  if (!t) return new Error(`${what} must not be empty`);
  if (t.length > MAX_LIST_TEXT) return new Error(`${what} too long: ${t.length} chars, max ${MAX_LIST_TEXT}`);
  return t;
}

// ---------------------------------------------------------------- picking
/*
 * SELECTABLE IMAGES.
 *
 * The problem this solves, in his words: agents generate candidates and then
 * ask him to pick in prose, so choosing a chair seed means typing "p2-1005" on
 * a phone. A picture already carries a label — the `alt` it was uploaded with —
 * so selection reports THAT, never an array index. An agent reading
 * `selected: 2` has learned nothing; `selected: ["p2-1005"]` is the answer.
 *
 * Modes, declared by whoever posts the pictures:
 *   "one"  — radio. Picking one clears the rest. For "choose a seed".
 *   "many" — checkboxes. For "which of these are any good".
 *   "none" — not selectable at all.
 * Unset, a message with TWO OR MORE pictures is "many" and a lone picture is
 * "none". A single screenshot should not sprout a checkbox, and a set of
 * candidates should be tappable even when the agent forgot to say so — which is
 * the failure that would put him back to typing seeds by hand.
 */
const PICK_MODES = ['one', 'many', 'none'];

function readPickMode(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).toLowerCase().trim();
  if (PICK_MODES.indexOf(v) < 0) return new Error(`select must be one of ${PICK_MODES.join(', ')}`);
  return v;
}

/** The pictures an entry id names, with the mode and defaults declared for them. */
function imagesOfEntry(entryId) {
  const id = String(entryId || '');
  const isReply = /:r$/.test(id);
  const task = tasks.get(taskIdOfEntry(id));
  if (!task) return null;
  const ids = isReply ? task.resultImages : task.images;
  if (!Array.isArray(ids) || !ids.length) return null;
  const declared = (isReply ? task.resultImageSelected : task.imageSelected) || [];
  let mode = isReply ? task.resultImageSelect : task.imageSelect;
  if (!mode) mode = ids.length >= 2 ? 'many' : 'none';
  return {
    task,
    ids,
    mode,
    declared,
    role: isReply ? 'agent' : (task.role === 'agent' ? 'agent' : 'user'),
  };
}

/**
 * The live state of one entry's selectable pictures, or null when there are
 * none or they are not selectable. Shaped like checklistOf on purpose.
 */
function pickListOf(entryId) {
  const found = imagesOfEntry(entryId);
  if (!found || found.mode === 'none') return null;
  const row = picks.get(String(entryId)) || {};
  let picked = 0;
  const items = found.ids.map((blob, index) => {
    const ref = imageRef(blob);
    const rec = row[String(index)];
    const selected = rec ? !!rec.on : found.declared.indexOf(blob) >= 0;
    if (selected) picked++;
    return {
      index,
      id: blob,
      // What an agent should quote back at him. The alt is the label the
      // uploader chose; without one there is nothing better than the position.
      label: ref.alt || `picture ${index + 1}`,
      url: ref.url,
      path: ref.path,
      width: ref.width,
      height: ref.height,
      selected,
      /*
       * Exactly the distinction `source` draws on a checklist item: "declared"
       * means the message was posted that way, "picked" means HE tapped it.
       * Without this an agent cannot tell its own suggested default from his
       * decision, and would act on a choice he never made.
       */
      source: rec ? 'picked' : 'declared',
      by: rec ? rec.by || null : null,
      at: rec ? rec.at || null : null,
    };
  });
  return {
    entryId: String(entryId),
    taskId: found.task.id,
    conversationId: convIdOf(found.task),
    role: found.role,
    mode: found.mode,
    total: items.length,
    picked,
    // The answer to "what did he choose", in the form worth reading.
    selected: items.filter((i) => i.selected).map((i) => ({ index: i.index, id: i.id, label: i.label })),
    // True only once he has actually touched it: "nothing chosen yet" and "he
    // chose none of them" are different answers and must not be confused.
    decided: items.some((i) => i.source === 'picked'),
    items,
  };
}

/** Every selectable image set in the queue. Optionally one conversation. */
function allPickLists(conversationId) {
  const out = [];
  for (const t of tasks.values()) {
    if (isInternal(t)) continue;
    if (conversationId && convIdOf(t) !== conversationId) continue;
    for (const entryId of [t.id, `${t.id}:r`]) {
      const pl = pickListOf(entryId);
      if (pl) out.push(pl);
    }
  }
  return out;
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

/*
 * The same settle-then-tell machinery checklists use, for the same reasons: a
 * burst of taps while he compares eight seeds must land as ONE message, and the
 * half that actually wakes the coordinator is a PENDING task in the
 * conversation. Nothing here pushes or speaks — he did this himself, with his
 * thumb, seconds ago.
 */
const PICK_CHANNEL = 'picks';
/** conversationId -> { timer, changes: Map<string, {entryId, index, label, on}> } */
const pickNotices = new Map();

function pickNoticeText(changes) {
  const lines = [];
  const on = changes.filter((c) => c.on);
  const off = changes.filter((c) => !c.on);
  if (on.length) lines.push(`Picked: ${on.map((c) => safeLabel(c.label)).join('; ')}`);
  if (off.length) lines.push(`Un-picked: ${off.map((c) => safeLabel(c.label)).join('; ')}`);
  for (const entryId of new Set(changes.map((c) => c.entryId))) {
    const pl = pickListOf(entryId);
    if (!pl) continue;
    const chosen = pl.selected.map((s) => safeLabel(s.label));
    lines.push(`Images ${entryId} (${pl.mode}): ${pl.picked}/${pl.total} chosen` +
      (chosen.length ? ` — ${chosen.join('; ')}` : ' — none'));
  }
  return lines.join('\n').slice(0, MAX_TEXT);
}

function flushPickNotice(conversationId) {
  const rec = pickNotices.get(conversationId);
  if (!rec) return;
  pickNotices.delete(conversationId);
  if (rec.timer) clearTimeout(rec.timer);
  const changes = [...rec.changes.values()];
  if (!changes.length) return;
  const body = pickNoticeText(changes);
  const ts = nowIso();

  // 1. The durable, thread-free record: GET /messages?channel=picks&since=…
  appendEvent({
    t: 'create',
    task: {
      id: newId(),
      role: 'agent',
      instruction: body,
      from: 'picks',
      author: 'picks',
      ts,
      status: 'done',
      claimedBy: null, claimedAt: null, result: null, resultTs: null,
      relayed: true, relayedAt: ts,
      visibility: 'internal',
      channel: PICK_CHANNEL,
      conversationId: `#${PICK_CHANNEL}`,
      about: conversationId,
    },
  });

  // 2. The wake-up. Only a pending task in the conversation rouses its
  //    coordinator, so this is the half that makes "Claude can see it" true.
  if (conversations.has(conversationId)) {
    const ts2 = nowIso();
    appendEvent({
      t: 'create',
      task: {
        id: newId(),
        role: DEFAULT_ROLE, // his action, not an agent's
        conversationId,
        instruction: body,
        from: 'picks',
        ts: ts2,
        status: 'pending',
        claimedBy: null, claimedAt: null, result: null, resultTs: null,
        relayed: false, relayedAt: null,
      },
    });
  }
}

function queuePickNotice(conversationId, entryId, index, label, on) {
  let rec = pickNotices.get(conversationId);
  if (!rec) { rec = { timer: null, changes: new Map() }; pickNotices.set(conversationId, rec); }
  // Keyed by item, so picking and un-picking before it settles is one net change.
  rec.changes.set(`${entryId}#${index}`, { entryId, index, label, on });
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => flushPickNotice(conversationId), CHECK_SETTLE_MS);
  if (rec.timer.unref) rec.timer.unref();
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
      lastActedAt: null,   // a claim, a result or a progress note: proof an agent ran
      lastProgressAt: null,
      lastProgressNote: null,
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
        lastActedAt: null, lastProgressAt: null, lastProgressNote: null,
        oldestWaitingTs: null };
      acc.set(id, a);
    }
    a.counts[t.status]++;
    if (!t.relayed) a.counts.unrelayed++;
    a.messages++;
    // Both halves of a turn count as activity — a conversation where the agent
    // is answering is busy, not idle. An agent posting a message of its own is
    // acting too: it can only have come from inside a turn. So is a progress
    // note, which is the whole point of having them: the long middle of a job,
    // which used to look exactly like death, now leaves evidence.
    for (const at of [t.claimedAt, t.resultTs, t.lastProgressAt, t.role === 'agent' ? t.ts : null]) {
      if (at && (!a.lastActedAt || msOf(at) > msOf(a.lastActedAt))) a.lastActedAt = at;
    }
    if (t.lastProgressAt && (!a.lastProgressAt || msOf(t.lastProgressAt) > msOf(a.lastProgressAt))) {
      a.lastProgressAt = t.lastProgressAt;
      const notes = Array.isArray(t.progress) ? t.progress : [];
      a.lastProgressNote = notes.length ? notes[notes.length - 1].note : null;
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
  const progressAgoSec = secSince(c.lastProgressAt);
  const waitingSec = secSince(c.oldestWaitingTs);
  const progressing = progressAgoSec !== null && progressAgoSec * 1000 <= PROGRESS_FRESH_MS;
  const base = {
    seenAgoSec, actedAgoSec, waitingSec,
    // What the agent said it was doing, and when. The two facts that turn
    // "something is happening" into something a human can act on.
    progressAgoSec,
    progressNote: c.lastProgressNote || null,
    progressing,
  };

  if (!c.agent) return { ...base, state: 'unassigned' };
  if (seenAgoSec === null && actedAgoSec === null) return { ...base, state: 'never' };

  const idle = actedAgoSec === null ? Infinity : actedAgoSec;
  const waited = waitingSec === null ? 0 : waitingSec;   // no waiting work = nothing is stalled
  const stalled = waitingSec === null ? 0 : Math.min(idle, waited);
  const beating = seenAgoSec !== null && seenAgoSec * 1000 <= WATCHING_MS;

  /*
   * WORKING OUTRANKS EVERY STALL VERDICT BELOW, AND THAT IS THE ENTIRE FIX.
   *
   * A claimed task accepts exactly one result, so an agent in the long middle of
   * a job had nothing it could say without ending the job. It therefore said
   * nothing — and every check below reads silence as death. Three healthy agents
   * were reported dead in one night, and a replacement was started on top of one
   * of them.
   *
   * A progress note is not a heartbeat and this is not the mistake this file
   * warns about elsewhere. A heartbeat is a timer proving a socket is open; it
   * survives its agent, which is what made it a lie. A note is written by the
   * agent, from inside a turn, and says what it is doing. Nothing but the work
   * itself can produce one.
   *
   * It is still bounded: PROGRESS_FRESH_MS, after which the note stops vouching
   * for anything and every verdict below applies again exactly as before.
   */
  if (progressing) return { ...base, state: 'working' };

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
 * SEAT-UNWATCHED — an additional, faster signal alongside `state` above,
 * feeding autoseat.js independently of whether `agent` is null.
 *
 * THE GAP THIS CLOSES. `agent` records who was TOLD to answer here, not
 * whether their process is still running. A coordinator (`FluxPrep`, in the
 * incident that motivated this) can finish or crash while its name stays on
 * the seat forever — nothing here ever unset it on exit, because nothing here
 * can observe a process exiting. autoseat.js's existing trigger is `agent ===
 * null`, so a seat like that reads as staffed indefinitely: 12 messages queued
 * for 9 minutes with zero live listeners, and nothing noticed.
 *
 * WHY NOT JUST "listeners === 0". A momentary zero is the normal case, not the
 * fault one — a coordinator mid-tool-call (reading a file, running a
 * subagent, thinking) has no open SSE connection at that instant, and the
 * server restarting on its own source change (see the deployment-hazards
 * section of COORDINATOR.md) drops every open stream on purpose. Firing on a
 * bare zero would thrash: reseat, the real coordinator's reconnect loop comes
 * back a moment later, two coordinators in one tab — the exact "worst outcome"
 * autoseat.js's own re-read-before-spawn guard exists to avoid.
 *
 * So this asks the same question sweepVacantChairs asks — "is there ANY
 * evidence of life, and has ALL of it gone quiet" — via the shared
 * evidenceOfLifeMs(), just on SEAT_UNWATCHED_MS's much shorter clock (2 minutes
 * by default, deliberately aligned with NUDGE_PENDING_MS) instead of
 * CHAIR_VACANT_MS's 45. Folding the SSE-listener signal into the SAME max()
 * as heartbeat/lastActedAt/lastProgressAt — rather than testing it alone —
 * is what keeps a coordinator that is genuinely heads-down on a different,
 * already-claimed task (posting progress notes, just not holding a stream)
 * from being duplicated on top of: `lastProgressAt` alone already vouches for
 * it here, exactly as it does for `state: 'working'` above.
 *
 * Gated on `counts.pending > 0` for the same reason autoseat.js only ever
 * looks at tabs with an unanswered message: a quiet, caught-up tab with no
 * listener is not a fault, it is Tuesday.
 */
function seatWatchInfo(c) {
  const now = Date.now();
  const w = convListeners.get(c.id);
  const listeners = w ? w.count : 0;
  const base = { listeners };
  // No agent to be missing, or a stop is already in progress (same exemption
  // sweepVacantChairs makes — do not race or second-guess a stop underway).
  if (!c.agent || c.stopRequested || c.stopAck) return { ...base, unwatchedForSec: 0, seatUnwatched: false };
  const pending = (c.counts && c.counts.pending) || 0;
  if (pending <= 0) return { ...base, unwatchedForSec: 0, seatUnwatched: false };

  // "Currently has a listener" is the freshest possible evidence (now); a past
  // listener that has since dropped to zero contributes the moment it did.
  const listenerEvidenceMs = listeners > 0 ? now : (w && w.zeroSinceMs) || 0;
  const lastLife = evidenceOfLifeMs(c, listenerEvidenceMs);
  const unwatchedForSec = lastLife ? Math.max(0, Math.round((now - lastLife) / 1000)) : 0;
  const seatUnwatched = !!lastLife && (now - lastLife) >= SEAT_UNWATCHED_MS;
  return { ...base, unwatchedForSec, seatUnwatched };
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
 *   working         assigned, holding a task, and REPORTING PROGRESS on it. The
 *                   state that did not exist and had to: a long job used to be
 *                   indistinguishable from a dead agent, because the protocol
 *                   gave it no way to speak without ending the job.
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
  const seat = seatWatchInfo(c);
  const lifecycle = stop.phase === 'stopped' ? 'stopped'
    : stop.phase === 'stopping' ? 'stopping'
      : stop.phase === 'requested' ? 'stop-requested'
        : live.state;
  return {
    ...live,
    ...seat,
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
// Each entry is { res, conv } — `conv` is the conversationId a connection
// scoped itself to via `?conversation=`, or null for the unfiltered firehose
// (GET /events with no query param, unchanged from before this existed).
const streams = new Set();
const MAX_STREAMS = 50;
/*
 * LIVE SSE SUBSCRIBER COUNT, PER CONVERSATION. What tells sweepVacantChairs's
 * fast-path cousin (seatWatchInfo, below) that a seat with a name on it has
 * nobody actually reading its stream right now — the gap the "FluxPrep" incident
 * exposed: a coordinator's process exited, `agent` stayed non-null, and nothing
 * server-side ever asked "but is anyone subscribed".
 *
 * Deliberately keyed on the SCOPED conversationId only — a firehose connection
 * (`conv === null`, e.g. relay-watchdog) is not "watching" any one conversation
 * and must never be counted as if it were, or every conversation would read
 * `count >= 1` forever the moment the firehose watcher is up, and the signal
 * this exists to provide would never fire.
 *
 * `zeroSinceMs` is the moment count last dropped to zero — not "since server
 * boot", so a conversation that has simply never had a listener does not read
 * as "vacant since epoch". It is combined with other evidence of life
 * (heartbeat, lastActedAt, lastProgressAt, agentSince) in seatWatchInfo()
 * rather than trusted alone, for the same reason CHAIR_VACANT_MS's sweep takes
 * the most generous reading across several weak signals: a momentary zero here
 * is normal (an agent between tool calls, a reconnect gap after a source-change
 * restart) and must not by itself look like death.
 *
 * Never evicted for a conversation that stops existing — negligible footprint
 * for a queue with, at most, a few hundred conversations over its lifetime, and
 * simpler than chasing archival/deletion events that do not reliably fire.
 */
const convListeners = new Map(); // conversationId -> { count, zeroSinceMs }
const SSE_PING_MS = 25000; // under the ~100 s idle timeout proxies typically use
const SSE_RETRY_MS = 3000; // client reconnect delay

/*
 * What conversation a payload belongs to, for server-side stream filtering.
 * Task broadcasts carry `conversationId` directly; conversation broadcasts
 * carry the conversation object itself. Anything with neither (e.g. a global
 * watch tick — see pushWatch) belongs to no single conversation and is
 * dropped for a scoped subscriber rather than guessed at.
 */
function payloadConvId(payload) {
  if (payload.conversationId) return payload.conversationId;
  if (payload.conversation && payload.conversation.id) return payload.conversation.id;
  return null;
}

function push(payload) {
  if (streams.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  const pconv = payloadConvId(payload);
  for (const conn of streams) {
    // A scoped connection (conn.conv set) only receives events belonging to
    // that conversation. An unscoped connection (conn.conv === null) still
    // gets everything, unchanged — that is what lets a full-firehose watcher
    // (e.g. relay-watchdog) see every conversation over one connection.
    if (conn.conv !== null && conn.conv !== pconv) continue;
    try { conn.res.write(frame); } catch { /* socket already going away; 'close' will evict it */ }
  }
}

/*
 * Every frame names its conversation, so a page showing one conversation can
 * merge its own updates and merely *flag* the others. The firehose (no
 * `?conversation=`) still carries everything over one connection, unfiltered,
 * which is what lets the menu light up for a conversation you are not looking
 * at without opening a second connection. A connection that opted into
 * `?conversation=<id>` gets only that conversation's frames — filtered in
 * push() above, before the frame is ever written to that socket.
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

function sseRoute(req, res, q, opts) {
  if (streams.size >= MAX_STREAMS) return fail(res, 503, 'too many live connections');
  // Same alias convention as /tasks, /thread, /checklists: `conversation` is
  // canonical, `conversationId` accepted too. Absent or empty = unfiltered
  // firehose, exactly the pre-existing behavior.
  // `opts.forceFirehose` is set by the dedicated /events/firehose route below:
  // it is ALWAYS the unscoped stream, so any query string on that URL is
  // ignored rather than honored — there is no way to make /events/firehose
  // scoped, on purpose.
  const forceFirehose = !!(opts && opts.forceFirehose);
  const raw = forceFirehose
    ? null
    : (q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId'));
  const conv = raw !== null && raw !== '' ? raw : null;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // ask buffering proxies to pass frames straight through
  });
  if (res.socket) { res.socket.setNoDelay(true); res.socket.setTimeout(0); }
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  res.write(`: connected ${nowIso()}\n\n`);
  const conn = { res, conv };
  streams.add(conn);
  // Scoped connections only — see the comment on convListeners above for why a
  // firehose connection (conv === null) must never bump a specific
  // conversation's count.
  if (conv !== null) {
    let w = convListeners.get(conv);
    if (!w) { w = { count: 0, zeroSinceMs: null }; convListeners.set(conv, w); }
    w.count++;
  }
  // A page opening into an already-stranded state must see it immediately, not
  // on the next tick. Reconnects land here too, so a dropped stream self-heals.
  // Only for an unscoped connection: the watch snapshot is global health, not
  // one conversation's, so it has no conversationId to match a scoped filter
  // against — sending it to a scoped subscriber would break the contract that
  // a scoped stream carries only that conversation's own events.
  if (conv === null) {
    try {
      res.write(`data: ${JSON.stringify({ now: nowIso(), watch: watchSnapshot() })}\n\n`);
    } catch { /* the close handler below will evict it */ }
  }

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closing */ }
  }, SSE_PING_MS);
  if (ping.unref) ping.unref(); // never hold shutdown open
  const done = () => {
    clearInterval(ping);
    streams.delete(conn);
    if (conv !== null) {
      const w = convListeners.get(conv);
      if (w) {
        w.count = Math.max(0, w.count - 1);
        if (w.count === 0) w.zeroSinceMs = Date.now();
      }
    }
  };
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
 * How long a progress note vouches for an agent.
 *
 * It cannot be WATCHING_MS. Sixty seconds is the right window for "is a socket
 * open", and the wrong one by an order of magnitude for "is a job running": no
 * agent regenerating art or running a suite is going to interrupt itself every
 * minute, and demanding it would rebuild the same lie in a new place — a note
 * posted to satisfy a timer rather than because anything happened.
 *
 * Ten minutes, matching SILENT_MS and the watchdog's own --stuck-after default,
 * so the queue, the status page and the watchdog cannot disagree about how long
 * quiet is allowed to last before it means something.
 */
const PROGRESS_FRESH_MS = Number(process.env.PROGRESS_FRESH_MS || SILENT_MS);
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
 * NOBODY HAS EVEN LOOKED YET. Different failure from STUCK_CLAIM_MS above:
 * that one is an agent that took a task and went quiet; this one is a task
 * nobody has claimed at all, sitting in front of a coordinator who is
 * assigned but has not acted. relay-watchdog already covers this from
 * outside the process, polling every few minutes and posting a nag task into
 * the queue — but a queue message costs the coordinator tokens to read. A
 * push notification does not, so this is the terser, server-native version
 * of the same idea, built on the watch tick this file already runs. Two
 * minutes: fine enough to matter, coarse enough that a normal claim latency
 * never trips it (see WAITING_GRACE_MS above, one minute for the same
 * reason).
 */
const NUDGE_PENDING_MS = Number(process.env.NUDGE_PENDING_MS || 2 * 60 * 1000);
/*
 * THE FAST VACANCY CHECK. CHAIR_VACANT_MS (45 min, below) is a sweep for "has
 * whoever is sitting here gone for good" — deliberately slow, because
 * unassigning a live coordinator is expensive to be wrong about. This is a
 * different question, asked on a much shorter clock: "is a message piling up
 * RIGHT NOW with nobody actually reading this conversation's stream", which is
 * exactly the shape of the incident that motivated it — a coordinator's
 * process exited, `agent` stayed non-null, and the 45-minute sweep was much too
 * slow to be the thing that caught it.
 *
 * Deliberately reuses NUDGE_PENDING_MS rather than inventing a third unrelated
 * magnitude: that constant already encodes "how long a pending message must
 * wait before it's worth acting on, tuned to survive normal claim latency
 * without crying wolf" (see the comment above it), which is precisely the
 * grace period this needs too. Independently overridable, in case the two
 * ever need to diverge — but they start aligned on purpose, not by accident.
 */
const SEAT_UNWATCHED_MS = Number(process.env.SEAT_UNWATCHED_MS || NUDGE_PENDING_MS);
// Once a stale task has been nudged, don't repeat it every 15s tick forever —
// that is exactly the "token wasteful" spam this was built to avoid. Re-nudge
// only if it is STILL the oldest unclaimed task after this long.
const NUDGE_RENUDGE_MS = Number(process.env.NUDGE_RENUDGE_MS || 5 * 60 * 1000);
/*
 * THE EMPTY CHAIR THAT STILL HAS A NAME ON IT.
 *
 * On 2026-08-27 he got 390 push notifications in 24 hours and 328 of them —
 * 84% — came from nudgeStalePending() alone. Not one described a real problem.
 * The cause is this: `conv.agent` is set when a coordinator takes a tab and is
 * cleared only by stopAckRoute(), which an agent reaches ONLY when a human has
 * asked it to stop. An agent that simply finishes its work and exits — which is
 * what every well-behaved agent does — never calls it. Its name stays on the
 * tab forever.
 *
 * That single stale string is load-bearing in the worst way. stalePending()
 * deliberately fires only for tabs that HAVE a coordinator, on the reasoning
 * that someone is there to answer. So every finished agent left behind a tab
 * that looked permanently staffed, and anything posted into it re-nudged him
 * every NUDGE_RENUDGE_MS forever. Twenty agents finished that day. Twelve
 * pushes an hour each, and the hourly budget was repeatedly exhausted — so the
 * phantoms were not merely noise, they were spending the ceiling that GENUINE
 * alerts needed and relay was dropping real ones on the floor.
 *
 * The obvious fix — "agents should stand down as their last act" — is not a
 * fix. It is a step an agent must remember, and a step an agent must remember
 * is a step an agent will forget; that is precisely the bug, restated as a
 * rule. So the clock does it instead, here, where nothing can skip it.
 *
 * WHAT THIS DOES NOT DO, and the distinction is the whole design. It does NOT
 * mark the conversation `stopped`. stopAckRoute() is the only thing entitled to
 * say that, because only the agent itself knows, and inventing that confirmation
 * on a timer is exactly what the comment there refuses to do. This makes a
 * weaker and honest claim: NOBODY HAS BEEN IN THIS CHAIR FOR A LONG TIME, so
 * stop addressing work to whoever used to sit in it. stopAck stays null, so
 * "finished cleanly" and "presumed gone" remain tellable apart forever.
 *
 * It is also reversible and self-correcting: the vacated name is kept in
 * `agentLeft`, and an agent that was merely busy re-takes the tab by acting.
 * Generous on purpose — 45 minutes of TOTAL silence (no claim, no result, no
 * progress note, no heartbeat). A coordinator in the long middle of a job posts
 * progress notes and is never touched; see PROGRESS_FRESH_MS and the `working`
 * state, which exists for exactly that agent.
 */
const CHAIR_VACANT_MS = Number(process.env.CHAIR_VACANT_MS || 45 * 60 * 1000);
/*
 * THE ONE WORD THAT MEANS "THE SWEEP TOOK THIS CHAIR", and a constant rather
 * than a literal precisely so that stays true. It is written in exactly one
 * place (the sweep), and refused everywhere a caller could supply it, so
 * `agentLeftReason === SWEPT_REASON` is a sound test for "evicted, nobody said
 * they were going" — which is what the 409 explanation in updateConversation()
 * already reads it as, and what a coordinator deciding whether to reseat a tab
 * needs it to mean. An agent that quits cleanly writes its own word here; if it
 * could also write this one, the two states would collapse back into one.
 */
const SWEPT_REASON = 'presumed-gone';
// What a bare `{"agent":null}` records when the caller names no reason. An
// agent that simply stands down still has to leave a trace, because the whole
// point is that an empty chair is never again indistinguishable from a chair
// nobody ever sat in.
const DEFAULT_LEFT_REASON = 'released';
/*
 * HOW LONG THE ROUTER GETS BEFORE A LIVENESS PROBLEM BECOMES HIS PROBLEM.
 * See routeLiveness(). Liveness is an agent-operations concern and he asked, in
 * as many words, not to be paged about it — but "not paged" must never become
 * "unreachable", so the escalation stays. It fires only when the Router itself
 * has gone quiet, which is the one case where no agent is left to handle it.
 */
const LIVENESS_ESCALATE_MS = Number(process.env.LIVENESS_ESCALATE_MS || 15 * 60 * 1000);
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
 *   - A PROGRESS NOTE renews too, for the same reason re-claiming does and the
 *     opposite of the reason a heartbeat does not. It is written by the agent
 *     inside a turn and carries what it is doing; a poll loop has nothing to
 *     put in it. Renewal is a side effect — the note exists so the human can
 *     see "running the suites" instead of fifteen minutes of nothing, and the
 *     lease simply believes the same evidence the status page does. See
 *     lastSignalOf(), which is the single place that decides what counts.
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
    /*
     * SILENCE, NOT AGE. "Claimed a while ago" and "nobody is home" are two
     * different facts, and conflating them is what made a working agent look
     * dead: real jobs take longer than the threshold, and the only thing an
     * agent could do about it was spend its one result saying "not yet".
     *
     * So the clock runs from the last signal — the claim, or the newest
     * progress note — and `claimedForSec` is carried alongside so the other
     * fact is still legible. A task held for three hours while posting notes
     * every minute is a long job, not an orphan, and now reads as one.
     */
    const since = lastSignalOf(t);
    const forSec = Math.round((now - since) / 1000);
    if (forSec * 1000 < STUCK_CLAIM_MS) continue;
    const notes = Array.isArray(t.progress) ? t.progress : [];
    out.push({
      id: t.id,
      conversationId: convIdOf(t),
      claimedBy: t.claimedBy || null,
      claimedAt: t.claimedAt || null,
      stuckForSec: forSec,
      claimedForSec: Math.round((now - msOf(t.claimedAt || t.ts)) / 1000),
      lastProgressAt: t.lastProgressAt || null,
      progressCount: t.progressCount || 0,
      lastNote: notes.length ? notes[notes.length - 1].note : null,
      text: asText(t.instruction).slice(0, 120),
    });
  }
  return out.sort((a, b) => b.stuckForSec - a.stuckForSec);
}

/*
 * PENDING, not claimed at all — the other half of "nobody is home", and a
 * different signal from stuckClaims() above. That one fires once an agent
 * demonstrably took something and went quiet; this one fires when nothing has
 * even been picked up. Grouped by conversation, one row per conversation, so
 * a burst of five messages nudges once, not five times.
 *
 * Deliberately narrow to conversations with an assigned agent
 * (`conv.agent`): an empty chair is not this mechanism's problem to solve —
 * relay-watchdog already reports that case (its "unassigned" state) — and
 * nudging nobody would just be a push into the void.
 *
 * Not memoised, for the same reason stuckClaims() is not: a task goes stale
 * purely by the clock ticking, with nothing else mutating, so a cache keyed
 * on `mutations` would never notice.
 */
function stalePending() {
  const now = Date.now();
  const byConv = new Map();
  for (const t of tasks.values()) {
    if (isInternal(t)) continue;
    if (t.status !== 'pending') continue;
    const id = convIdOf(t);
    const conv = conversations.get(id);
    if (!conv || !conv.agent) continue; // no coordinator assigned; not this mechanism's job
    let hit = byConv.get(id);
    if (!hit) {
      hit = { conversationId: id, title: conv.title, agent: conv.agent, count: 0, oldestId: null, oldestTsMs: Infinity };
      byConv.set(id, hit);
    }
    hit.count++;
    const tsMs = msOf(t.ts);
    if (tsMs < hit.oldestTsMs) { hit.oldestTsMs = tsMs; hit.oldestId = t.id; }
  }
  const out = [];
  for (const hit of byConv.values()) {
    const oldestAgeSec = Math.round((now - hit.oldestTsMs) / 1000);
    if (oldestAgeSec * 1000 < NUDGE_PENDING_MS) continue;
    out.push({
      conversationId: hit.conversationId,
      title: hit.title,
      agent: hit.agent,
      count: hit.count,
      oldestId: hit.oldestId,
      oldestAgeSec,
    });
  }
  return out.sort((a, b) => b.oldestAgeSec - a.oldestAgeSec);
}

/** The nudge text — deliberately one short line, not a sentence. */
const nudgeText = (g) => `${g.count} unclaimed ${humanFor(g.oldestAgeSec)} in ${g.title}`;

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
  const stale = stalePending();
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
    // Pending and unclaimed, with a coordinator assigned to answer it — see
    // stalePending() and nudgeStalePending() below. Same shape as stuck/stuckCount.
    stalePending: stale.slice(0, 5),
    stalePendingCount: stale.length,
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

/*
 * conversationId -> ms timestamp of the last nudge sent for that
 * conversation's then-oldest stale task. Keyed on the TASK id, not just the
 * conversation, so that once the stale task is finally claimed a genuinely
 * new stale task nudges right away instead of waiting out the old task's
 * cooldown — see nudgeStalePending().
 */
const lastNudgeAt = new Map(); // taskId -> ms

/*
 * THE LIVENESS CHANNEL — where "is an agent alive?" goes instead of his phone.
 *
 * Same shape as CHECK_CHANNEL and PICK_CHANNEL above, and deliberately so: a
 * record born `visibility:'internal'`, `status:'done'`, `relayed:true`, on its
 * own `#liveness` conversation. Three consequences, all of them the point:
 *
 *   - classify() returns null on isInternal() before it looks at anything else
 *     (rule zero), so a record here CANNOT push. Not "does not by default" —
 *     cannot, even if some future caller passes a notify hint.
 *   - It is `done` and `relayed` at birth, so it creates NO TASK and no chore.
 *     Routing liveness away from his phone must not simply move the pile into
 *     his queue instead; that is the same interruption wearing a different hat.
 *   - It is still durable and pollable: GET /messages?channel=liveness&since=…
 *     Nothing is thrown away. It is re-addressed.
 *
 * WHY THIS EXISTS. Every alert this file used to send him about agent liveness
 * was asking a human to solve an agent-operations problem, at 3am, from a
 * phone, with no way to act on it. He said so directly: "Don't page me about
 * liveness." relay-watchdog already worked this way — routine findings to a
 * channel, escalate only if unanswered — and escalated zero times in twelve
 * hours while this file sent 344. The pattern was already here and proven; the
 * two functions below simply never used it.
 */
const LIVENESS_CHANNEL = 'liveness';
/** key -> { firstAt, escalated } — see routeLiveness(). */
const livenessSeen = new Map();

/*
 * Post a liveness finding to the channel, and escalate to him ONLY if the
 * Router has gone quiet too.
 *
 * The escalation test is `main`'s lastActedAt, which is what the Router acts
 * through, and it is read in-process — no extra hop, nothing to keep in sync.
 * The rule is: if the Router has done ANYTHING since this finding first
 * appeared, it has the finding and this is none of his business. Only if the
 * Router has itself been silent for LIVENESS_ESCALATE_MS does it reach him.
 *
 * That test is deliberately coarse and deliberately biased toward silence. A
 * busy Router suppresses the page, which is correct: the entire complaint was
 * being paged about things an agent was already handling. The case it still
 * catches is the one that actually strands him — the Router itself being gone,
 * where no amount of channel-posting would ever be read by anybody.
 *
 * Escalation fires ONCE per finding (`escalated`), never on a repeat. The bug
 * being fixed here was a re-nudge loop; a re-escalation loop would be the same
 * bug with a longer period.
 */
function routeLiveness(category, text, conversationId, taskId, escalates = true) {
  if (notifyDepth > 0) return;
  const ts = nowIso();
  const now = Date.now();

  /*
   * notifyDepth guards the appendEvent -> pushWatch -> nudgeStalePending ->
   * routeLiveness -> appendEvent cycle. Without it this recurses on its own
   * first write, because appendEvent() ends by calling pushWatch() and
   * pushWatch() is what called us. Same guard, same reason, as the unsub
   * writes inside sendToAll().
   */
  notifyDepth++;
  try {
    appendEvent({
      t: 'create',
      task: {
        id: newId(),
        role: 'agent',
        instruction: text,
        from: LIVENESS_CHANNEL,
        author: LIVENESS_CHANNEL,
        ts,
        status: 'done',
        claimedBy: null, claimedAt: null, result: null, resultTs: null,
        relayed: true, relayedAt: ts,
        visibility: 'internal',
        channel: LIVENESS_CHANNEL,
        conversationId: `#${LIVENESS_CHANNEL}`,
        // Which real tab this is about, so a channel reader can go there.
        about: conversationId || null,
      },
    });
  } finally { notifyDepth--; }

  /*
   * Some findings are pure bookkeeping and must never reach him no matter how
   * long anyone stays quiet — "this chair has been empty for an hour" is an
   * observation about agents, and waking him with it at 4am would reintroduce
   * the exact complaint this change answers. They stop at the channel.
   */
  if (!escalates) return;

  const key = taskId || `${category}:${conversationId || DEFAULT_CONV}`;
  let rec = livenessSeen.get(key);
  if (!rec) { rec = { firstAt: now, escalated: false }; livenessSeen.set(key, rec); }
  if (rec.escalated) return;
  if (now - rec.firstAt < LIVENESS_ESCALATE_MS) return;
  /*
   * Has the Router done anything at all since this was first reported?
   *
   * READ THIS FROM THE SUMMARY, NOT FROM conversations.get(). `lastActedAt` is
   * NOT a stored field on a conversation — it is derived in
   * conversationSummaries() by scanning tasks for claims, results, progress
   * notes and agent posts. The raw record has no such property, so the obvious
   * spelling yields undefined, msOf() turns that into 0, and the comparison is
   * false forever: every finding would escalate to his phone on a timer,
   * rebuilding the exact spam this replaces while looking correct. The
   * escalation selftest caught this; it is not hypothetical.
   */
  const router = conversationSummaries().find((c) => c.id === DEFAULT_CONV);
  if (router && msOf(router.lastActedAt) > rec.firstAt) return;
  rec.escalated = true;
  queueNotify(category, text, conversationId, taskId);
}

/*
 * THE SWEEP. Vacate chairs nobody has sat in for CHAIR_VACANT_MS — read the
 * comment on that constant, which is where the reasoning lives.
 *
 * Runs on the watch tick, before the nudge, so that a tab whose owner is long
 * gone has already stopped counting as staffed by the time stalePending() is
 * asked about it.
 */
/*
 * THE MOST RECENT MOMENT THERE IS ANY EVIDENCE OF LIFE. Shared by
 * sweepVacantChairs (45-minute horizon, below) and seatWatchInfo (2-minute
 * horizon — see SEAT_UNWATCHED_MS) — same "take the most generous reading,
 * require every signal silent" shape, just asked on two different clocks for
 * two different questions ("is anyone EVER coming back" vs "is anyone
 * answering RIGHT NOW"). Extracted so the two cannot quietly drift apart on
 * what counts as evidence.
 *
 * Every kind of evidence that anyone is home, weakest included. A heartbeat is
 * a weak signal and this file says so everywhere — but the cost of being wrong
 * here is unassigning (or duplicating) a live agent, so take the most generous
 * reading and require all of them silent.
 *
 * `agentSince` belongs in here even though it is not evidence of life, and it
 * is the difference between measuring the OCCUPANT's silence and the TAB's.
 * Every other term describes the tab, so on a tab that has been quiet for an
 * hour they are all already expired at the instant a new agent is seated —
 * and since appendEvent() ends in pushWatch(), which calls sweepVacantChairs,
 * the eviction happened inside the very request that did the seating. The
 * attach returned HTTP 200 with `agent: null` in the body, which is how it
 * went unexplained for a while: every observation said it had worked.
 *
 * With it, a new occupant starts a fresh clock, which is what CHAIR_VACANT_MS
 * (and SEAT_UNWATCHED_MS) already promise. It does not weaken either check:
 * the clock still only ever runs from a real event, and an agent that is
 * seated and then never shows up is still caught on schedule — just measured
 * from when they arrived rather than from something the last occupant did.
 *
 * `extraSignalMs`, when given, is one more piece of evidence folded into the
 * same max() — seatWatchInfo passes the SSE-listener signal here rather than
 * this function reaching for convListeners itself, so sweepVacantChairs stays
 * exactly as it was (byte-for-byte the same evidence set) unless a caller
 * deliberately opts in.
 */
function evidenceOfLifeMs(c, extraSignalMs) {
  const beat = HEARTBEATS.get(c.agent);
  const seenAt = beat ? msOf(beat.at) : 0;
  const signals = [msOf(c.lastActedAt), msOf(c.lastProgressAt), seenAt, msOf(c.agentSince)];
  if (extraSignalMs) signals.push(extraSignalMs);
  // Never acted at all? Then the clock runs from when it was given the tab, so
  // an agent that was assigned and never showed up is still caught. (Conversations
  // recorded before `agentSince` existed have none, and fall back to this
  // exactly as they always did.)
  return Math.max(...signals) || msOf(c.createdAt);
}

function sweepVacantChairs() {
  if (notifyDepth > 0) return;
  const now = Date.now();
  /*
   * Summaries, not conversations.values() — same trap as routeLiveness above,
   * and far more dangerous here. `lastActedAt` and `lastProgressAt` are derived
   * fields; on a raw conversation record they are undefined, both maxes collapse
   * to 0, and every chair would fall through to the createdAt fallback and be
   * vacated 45 minutes after the tab was made no matter how busy its agent was.
   * That is unassigning live coordinators wholesale, on a timer.
   */
  for (const c of conversationSummaries()) {
    if (!c.agent) continue;
    // Mid-stop conversations belong to stopAckRoute and to whoever asked. Do
    // not race a stop that is already under way, or answer it on the agent's
    // behalf — "asked to stop and never answered" is a report someone wants.
    if (c.stopRequested || c.stopAck) continue;
    const lastLife = evidenceOfLifeMs(c);
    if (!lastLife || now - lastLife < CHAIR_VACANT_MS) continue;

    const who = c.agent;
    const quietFor = humanFor(Math.round((now - lastLife) / 1000));
    notifyDepth++;
    try {
      appendEvent({
        t: 'convpatch',
        id: c.id,
        patch: {
          agent: null,
          // Kept, not discarded: "PushCoord, presumed gone" is a far more
          // useful thing for a UI or a human to read than an empty chair with
          // no history, and it is what makes this reversible by hand.
          agentLeft: who,
          agentLeftAt: nowIso(),
          // The sweep's word, and only the sweep's - see SWEPT_REASON. A
          // voluntary release records its own reason through the same three
          // fields, so an empty chair always says who left; this one says
          // nobody told us they were going.
          agentLeftReason: SWEPT_REASON,
        },
      });
    } finally { notifyDepth--; }
    // Never escalates: see routeLiveness's `escalates`. Housekeeping, not an alarm.
    routeLiveness('needs-you', `${who} left ${c.title || c.id} — silent ${quietFor}, chair vacated`, c.id, null, false);
  }
}

/*
 * THE NUDGE. Same tick as the deadman banner above. It used to end in
 * queueNotify() — i.e. straight to his phone — and that one line produced 328
 * of the 390 pushes he got in 24 hours, every one of them a phantom. It now
 * ends in routeLiveness() instead.
 *
 * Nothing else about it changes: same qualifying set (stalePending(), 2
 * minutes, agent assigned), same NUDGE_RENUDGE_MS cooldown so one still-
 * unclaimed task cannot re-report every 15s tick forever. Only the destination
 * is different, because the destination was the bug.
 *
 * Read together with sweepVacantChairs() above, which removes most of the
 * qualifying set at source: a tab whose coordinator finished hours ago no
 * longer has an agent, so stalePending() never returns it in the first place
 * and this reports nothing at all about it.
 */
function nudgeStalePending() {
  if (!PUSH_ON || notifyDepth > 0) return;
  const groups = stalePending();
  const liveIds = new Set(groups.map((g) => g.oldestId));
  for (const id of lastNudgeAt.keys()) if (!liveIds.has(id)) lastNudgeAt.delete(id);
  // A finding that has gone away stops being tracked, so if it ever comes back
  // it is a NEW finding with a fresh escalation clock rather than one that
  // inherits an expired one and pages him instantly.
  for (const k of livenessSeen.keys()) if (!liveIds.has(k) && k.indexOf(':') === -1) livenessSeen.delete(k);
  const now = Date.now();
  for (const g of groups) {
    const last = lastNudgeAt.get(g.oldestId);
    if (last !== undefined && now - last < NUDGE_RENUDGE_MS) continue;
    lastNudgeAt.set(g.oldestId, now);
    routeLiveness('needs-you', nudgeText(g), g.conversationId, g.oldestId);
  }
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
  // Before the nudge, deliberately: a chair vacated on this tick must already
  // be empty when stalePending() is asked who is responsible for the tab.
  sweepVacantChairs();
  nudgeStalePending();
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
    // budgetLeft stays a single number for back-compat (older UI/tooling
    // reads it as "how much room is left overall") — it is now the sum of
    // both pools. budgetLeftDone / budgetLeftAlerts are the precise view:
    // spam ("done") and real alerts ("needs-you"/"broken") no longer share
    // one counter, so a busy "done" hour can never suppress a "broken" push.
    budgetLeft: pushBudgetDone + pushBudgetAlerts,
    budgetLeftDone: pushBudgetDone,
    budgetLeftAlerts: pushBudgetAlerts,
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
// Two independent budgets, reset on the same hourly clock. "done" spends
// pushBudgetDone; "needs-you" and "broken" share pushBudgetAlerts, so one
// cannot starve the other of the pool that matters most.
let pushBudgetDone = PUSH_PER_HOUR;
let pushBudgetAlerts = PUSH_PER_HOUR_ALERTS;
setInterval(() => { pushBudgetDone = PUSH_PER_HOUR; pushBudgetAlerts = PUSH_PER_HOUR_ALERTS; }, 3600000).unref();
function budgetFor(category) { return category === 'done' ? 'done' : 'alerts'; }
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
  const pool = budgetFor(category);
  const left = pool === 'done' ? pushBudgetDone : pushBudgetAlerts;
  const ceiling = pool === 'done' ? PUSH_PER_HOUR : PUSH_PER_HOUR_ALERTS;
  if (left <= 0) {
    pushStats.suppressedBudget++;
    console.log(`[push] suppressed ${category} x${slot.count} — hourly ${pool} budget of ${ceiling} spent`);
    return;
  }
  if (pool === 'done') pushBudgetDone--; else pushBudgetAlerts--;
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

/*
 * The deadman banner, but for a phone with no page open.
 *
 * This one is NOT the spam. Measured over the same 24 hours that produced 328
 * phantom nudges, it fired 16 times, and every one of them was the orphaned-
 * claim branch — a task an agent took and never answered, which nothing else
 * in the system will ever pick up again. Those are real and must not be
 * suppressed.
 *
 * But they are still liveness, and he asked not to be paged about liveness. So
 * they take the same road: onto the channel immediately, where the Router sees
 * them, and through to his phone only if the Router has itself gone quiet for
 * LIVENESS_ESCALATE_MS. Re-routed, not muted — an alarm nobody picks up still
 * reaches him, just fifteen minutes later and only when there is genuinely
 * nobody else left to handle it.
 *
 * A WARNING FOR WHOEVER TIGHTENS THIS NEXT, learned by walking straight into it
 * while writing this very function. An agent doing a long, honest piece of work
 * holds its claims for the whole of it, and is from here byte-for-byte
 * identical to an agent that died holding them. No test distinguishes them. The
 * ONLY thing that does is a progress note - POST /tasks/:id/progress - which
 * vouches for the claim for PROGRESS_FRESH_MS; that is what the `working` state
 * exists for. So do NOT "fix" the false positives here by lengthening
 * STUCK_CLAIM_MS or by dropping the orphan branch: in that pairing the alert is
 * right and the agent is wrong. Agents doing multi-minute work must post
 * progress or they will page him for nothing, and this is the only comment
 * sitting next to the code that actually does the paging.
 */
function notifyWatchLevel(snap) {
  if (!PUSH_ON || notifyDepth > 0) return;
  // A restart is not a breakage. watchSnapshot() already refuses to alarm out
  // of a fresh boot; this server restarts itself on every source change, so
  // without that the deploy loop alone would buzz him.
  if (snap.starting) return;
  if (snap.level !== 'alarm') {
    /*
     * Recovered. Forget the finding, so that if the queue breaks again later it
     * is a NEW one with its own fifteen-minute clock. Without this line the
     * first alarm of the process would consume the only escalation this key
     * ever gets, and every later one would be silently swallowed — a mute
     * disguised as a re-route, which is the one outcome he must not get.
     */
    livenessSeen.delete(`broken:${DEFAULT_CONV}`);
    return; // `warn` is not worth a buzz; `alarm` is
  }
  routeLiveness('broken', snap.text || 'The queue has stopped being answered.', DEFAULT_CONV, null);
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

// ---------------------------------------------------------------- damage survey
/*
 * WHAT IS ALREADY LOST, AND DELIBERATELY NO ATTEMPT TO FIX IT.
 *
 * The corruption is fixed going forward by the strict decode in readBody, but
 * 26 events in the live log were written before that existed and their original
 * bytes are gone. Knowing the extent still has value - which conversations to
 * distrust, which authors were affected, whether it is still happening - so
 * this counts them and shows them.
 *
 * IT NEVER REPAIRS. A replacement character could have been an em-dash, an
 * accented letter, a quotation mark or an emoji, and nothing left in the record
 * says which. Guessing one and writing it into an append-only archive would
 * turn a visible gap into an invisible fabrication, which is strictly worse: a
 * known unknown can be resolved by asking the author, an invention cannot.
 */
function damageRoute(res, q) {
  const rows = [];
  const byAuthor = new Map();
  for (const t of tasks.values()) {
    const where = [];
    if (isDamaged(t.instruction)) where.push('text');
    if (isDamaged(t.result)) where.push('result');
    if (!where.length) continue;
    const who = t.author || t.claimedBy || t.from || 'unknown';
    byAuthor.set(who, (byAuthor.get(who) || 0) + 1);
    rows.push({
      id: t.id,
      conversationId: convIdOf(t),
      role: t.role,
      author: t.author || null,
      from: t.from || null,
      ts: t.ts,
      damagedIn: where,
      // Enough to recognise the message, not the whole of it: this is a survey.
      preview: asText(where[0] === 'text' ? t.instruction : t.result)
        .replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  rows.sort((a, b) => msOf(b.ts) - msOf(a.ts));
  const conversationId = q.get('conversationId') || q.get('conversation');
  const scoped = conversationId ? rows.filter((r) => r.conversationId === conversationId) : rows;
  const limit = Math.max(1, Math.min(Number(q.get('limit')) || 200, 1000));
  send(res, 200, {
    count: scoped.length,
    scanned: tasks.size,
    byAuthor: [...byAuthor.entries()]
      .map(([author, n]) => ({ author, damaged: n }))
      .sort((a, b) => b.damaged - a.damaged),
    repairable: false,
    // Said in the payload, because "why not just fix them" is the first thing
    // anyone asks and the answer needs to travel with the data.
    note: 'These cannot be repaired: the original bytes were replaced before they were stored, '
      + 'and nothing here records what they were. Guessing would turn a visible gap into an '
      + 'invisible fabrication. Ask whoever wrote it, if it matters.',
    messages: scoped.slice(0, limit),
  });
}

// ---------------------------------------------------------------- agents
/*
 * ADDRESSING AGENTS BY NAME, AND WAKING THEM.
 *
 * The diagnosis was his, and it was right: **his task queue was his front door,
 * not a coordination layer.** Agents were discovering each other through his
 * inbox, so every collision came from there — two agents rebasing one branch,
 * two identical PRs, two agents on one sweep. And he could only reach the four
 * or five coordinators holding a conversation; the workers doing the actual
 * work were invisible and unreachable, so he talked to middlemen and got
 * answers second-hand.
 *
 * Four things, in his order of priority.
 *
 * 1. EVERY AGENT ADDRESSABLE, AND IT PICKS ITS OWN NAME. Registration, not
 *    assignment — which means a collision rule, because two agents will choose
 *    the same name. See NAME_FOLD below: this is not hypothetical, "Sporefall 2"
 *    and "Sporefall2" coexisted and were taken for one agent.
 *
 * 2. PUSH DELIVERY. His complaint was "some messages never picked up". A polled
 *    endpoint cannot fix that, because AN AGENT ONLY PERCEIVES ANYTHING DURING A
 *    TURN — a message sitting in a database is not delivered, it is merely
 *    available. What demonstrably wakes an idle agent, verified rather than
 *    assumed, is a blocking read that ENDS: `tail -f inbox | head -1` sits
 *    quietly, exits the instant a line is appended, and that exit is an event
 *    the harness delivers. So delivery here is an append to a per-agent file,
 *    and the file is the mechanism rather than a convenience.
 *
 *    A detail found only by trying it: TAILING A FILE THAT DOES NOT EXIST EXITS
 *    IMMEDIATELY, which looks exactly like a delivered message. So registering
 *    creates the file, and boot recreates any that are missing.
 *
 * 3. A ROSTER HE CAN SEE, as a TREE — workers spawn workers, so depth is
 *    arbitrary and a flat list cannot show who is under whom. Every node says
 *    what that agent is working on, which is the whole point: it is what makes
 *    two agents starting the same job visible BEFORE the work is wasted.
 *
 * 4. VISIBLE OWNERSHIP, so nobody unknowingly starts what is already held.
 *
 * NOTHING HERE INVENTS LIVENESS. `lastActedAt` moves only when an agent does
 * something from inside a turn. There is no heartbeat in this section and there
 * will not be one: a heartbeat proves a loop ticks, not that work is happening,
 * and this file already says so twice.
 */
const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const MAX_AGENT_NAME = 60;
const MAX_TASK_NOTE = 300;
const MAX_LAST_WORDS = 600;
const MAX_INBOX_TEXT = 4000;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/;
/*
 * How long without a reported act before an agent is PRESUMED dead. Presumed,
 * never confirmed — see deathOf(). Deliberately generous: a worker thinking
 * hard, or waiting on a long build, reports nothing for a long time, and the
 * cost of calling a working agent dead is higher than the cost of waiting.
 */
const PRESUMED_DEAD_MS = Number(process.env.PRESUMED_DEAD_MS || 30 * 60 * 1000);
const MAX_AGENTS_REG = Number(process.env.MAX_AGENTS_REG || 500);

/** @type {Map<string, object>} folded name -> agent record */
const agentsByFold = new Map();
/*
 * @type {Map<string, object[]>} folded name -> messages addressed to it.
 *
 * The in-memory mirror of the per-agent inbox file. The FILE is the delivery
 * mechanism and this is the queryable copy — both are written from the same
 * event, so they cannot disagree about what was sent, only about what has been
 * read, which is the one thing only the agent can tell us.
 */
const INBOX = new Map();
const INBOX_CAP = Number(process.env.INBOX_CAP || 500); // per agent, in memory only

/*
 * THE COLLISION RULE, AND WHY IT FOLDS RATHER THAN COMPARES.
 *
 * Two agents picked "Sporefall 2" and "Sporefall2" and were taken for one. A
 * rule that only rejects EXACT duplicates would have allowed both, which is how
 * that happened. So identity is the folded form — lower-cased, with everything
 * that is not a letter or digit removed — and the display name is whatever was
 * typed.
 *
 * This buys two things at once. Registering a confusable variant of a taken
 * name is refused, so the pair cannot exist. And ADDRESSING is forgiving: a
 * message to "sporefall 2", "Sporefall2" or "SPOREFALL-2" all reach the same
 * agent, which matters because he addresses these by voice from a phone.
 */
const NAME_FOLD = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const inboxPath = (fold) => path.join(INBOX_DIR, `${fold}.jsonl`);

function readAgentName(raw) {
  const v = readString(raw, 'name', MAX_AGENT_NAME);
  if (v instanceof Error) return v;
  if (v === null) return new Error('name is required: an agent chooses its own');
  if (!AGENT_NAME_RE.test(v)) {
    return new Error(`invalid name "${v}": letters, digits, space, dot, dash, underscore and apostrophe only`);
  }
  if (!NAME_FOLD(v)) return new Error(`invalid name "${v}": it must contain at least one letter or digit`);
  return v;
}

/** Whichever agent answers to this spelling, or null. */
const agentByName = (name) => agentsByFold.get(NAME_FOLD(name)) || null;

/*
 * A free name near the one that was taken, so a refusal is actionable. An agent
 * told only "taken" tends to try one more variant that folds to the same thing
 * and be refused again.
 */
function suggestName(name) {
  const base = String(name || 'agent').replace(/\s*\d+$/, '').trim() || 'agent';
  for (let n = 2; n < 200; n++) {
    const candidate = `${base} ${n}`;
    if (!agentsByFold.has(NAME_FOLD(candidate))) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

/*
 * WHAT WE ACTUALLY KNOW ABOUT WHETHER THIS AGENT IS DEAD — in three states,
 * because two would force an inference to wear the same badge as a fact.
 *
 *   confirmed — something REPORTED it finished: the agent itself, or the parent
 *               that spawned it. First-hand, and the only kind that is a fact.
 *   presumed  — nothing has been heard for PRESUMED_DEAD_MS and nothing ever
 *               reported it finishing. THIS IS AN INFERENCE AND IT IS OFTEN
 *               WRONG. A worker was declared dead on far stronger evidence than
 *               this — no filesystem writes for 31 minutes, a reflog frozen
 *               mid-operation, no report at all — and it resurrected an hour
 *               later and committed useful work. Nobody reports their own
 *               death, so this category cannot be removed; it can only be
 *               labelled honestly.
 *   null      — as far as anything here knows, it is alive.
 *
 * Note what `presumed` actually establishes: NOT WORKING RIGHT NOW. Never
 * "gone". Every consumer gets `certain` so it cannot render the two the same,
 * and `because` so the claim can be argued with.
 *
 * PRESUMED DEATH IS DERIVED, NEVER STORED, and that is what makes resurrection
 * free: an agent that acts again is alive on its next read with nothing to undo.
 * Only a CONFIRMED death is a record, and only that one needs exhuming.
 */
function deathOf(a) {
  if (a.finished) {
    return {
      state: 'confirmed',
      certain: true,
      at: a.finished.at,
      ok: a.finished.ok,
      by: a.finished.by,
      self: a.finished.by === a.name,
      lastWords: a.finished.lastWords || null,
      because: a.finished.by === a.name
        ? 'it reported that it had finished'
        : `${a.finished.by} reported that it had finished`,
    };
  }
  const quietSec = secSince(a.lastActedAt);
  if (quietSec !== null && quietSec * 1000 >= PRESUMED_DEAD_MS) {
    return {
      state: 'presumed',
      /*
       * The whole point of this field. A presumed death must never be rendered
       * with the same marker as a confirmed one, because presuming is what got
       * this wrong before.
       */
      certain: false,
      at: null,
      ok: null,
      by: null,
      self: false,
      lastWords: a.lastActNote || null,
      because: `nothing reported for ${Math.round(quietSec / 60)} min, and nothing ever said it finished`,
      /*
       * Said in the payload rather than left to each UI to remember. This
       * establishes "not working right now" and nothing stronger; an agent that
       * is thinking, or waiting on a long build, reports nothing either.
       */
      meaning: 'not working right now — not necessarily gone',
      quietForSec: quietSec,
    };
  }
  return { state: null, certain: false, at: null, ok: null, by: null, self: false, lastWords: null, because: null };
}

/*
 * Never instrumented, or genuinely quiet? The same distinction `reporting:
 * false` already makes for the activity feed, for the same reason: an agent
 * that was never taught to report looks exactly like an idle one, and rendering
 * them the same makes the roster a comfortable lie.
 */
function agentView(a) {
  const death = deathOf(a);
  const acted = secSince(a.lastActedAt);
  return {
    id: a.id,
    name: a.name,
    parent: a.parentName || null,
    conversationId: a.conversationId || null,
    // WHAT IT IS WORKING ON. The single most valuable field here: it is what
    // makes two agents starting the same job visible before the work is wasted.
    task: a.task || null,
    registeredAt: a.registeredAt,
    lastActedAt: a.lastActedAt || null,
    lastActedAgoSec: acted,
    lastActNote: a.lastActNote || null,
    resumes: a.resumes || 0,
    /*
     * It registered and then never reported another thing. Distinct from quiet:
     * an agent nobody taught to report its work is not evidence of anything,
     * and must not be read as one that has gone silent.
     */
    everReported: !!a.acts,
    acts: a.acts || 0,
    death,
    alive: death.state === null,
    exhumed: a.exhumed || null,
    inbox: {
      waiting: (a.inboxCount || 0) - (a.ackedCount || 0),
      delivered: a.inboxCount || 0,
      acknowledged: a.ackedCount || 0,
      lastDeliveredAt: a.lastDeliveredAt || null,
      /*
       * Delivered and never acknowledged is exactly his original complaint —
       * "some messages never picked up" — made visible instead of inferred.
       */
      lastAckedAt: a.lastAckedAt || null,
    },
  };
}

/*
 * The roster as a TREE, because workers spawn workers and a flat list cannot
 * show who is under whom.
 *
 * Depth is arbitrary and the parent link comes from the agents themselves, so
 * this must survive a cycle (a resumed agent naming its own descendant as
 * parent) and a dangling parent (a parent that was never registered, or was
 * dropped). A recursive walk without a guard would hang the whole server, and
 * this server is his only line to every agent — so the guard is not a nicety.
 */
function agentTree() {
  const all = [...agentsByFold.values()];
  const kids = new Map();
  const roots = [];
  for (const a of all) {
    const parentFold = a.parent && agentsByFold.has(a.parent) ? a.parent : null;
    if (!parentFold) { roots.push(a); continue; }
    if (!kids.has(parentFold)) kids.set(parentFold, []);
    kids.get(parentFold).push(a);
  }
  const seen = new Set();
  const build = (a, depth) => {
    // A cycle, or the same agent reachable twice. Stop rather than recurse: the
    // node is already in the tree somewhere above.
    if (seen.has(a.fold) || depth > 32) return null;
    seen.add(a.fold);
    const children = (kids.get(a.fold) || [])
      .sort((x, y) => msOf(y.lastActedAt) - msOf(x.lastActedAt))
      .map((k) => build(k, depth + 1))
      .filter(Boolean);
    return { ...agentView(a), depth, children };
  };
  const tree = roots
    .sort((x, y) => msOf(y.lastActedAt) - msOf(x.lastActedAt))
    .map((r) => build(r, 0))
    .filter(Boolean);
  /*
   * Anything a cycle kept out of the tree is added at the root rather than
   * dropped. An agent that vanishes from the roster because of a bad parent
   * link is unreachable, and unreachable is the failure this whole feature
   * exists to end.
   */
  for (const a of all) {
    if (!seen.has(a.fold)) {
      seen.add(a.fold);
      tree.push({ ...agentView(a), depth: 0, children: [], orphaned: true });
    }
  }
  return tree;
}

/** Everything an agent does from inside a turn moves this, and nothing else does. */
function markAct(a, note) {
  const patch = {
    lastActedAt: nowIso(),
    acts: (a.acts || 0) + 1,
  };
  if (note) patch.lastActNote = String(note).slice(0, MAX_TASK_NOTE);
  appendEvent({ t: 'agentpatch', fold: a.fold, patch });
}

function ensureInbox(fold) {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    /*
     * MUST EXIST BEFORE ANYONE TAILS IT. `tail -f` on a missing file exits at
     * once, and an agent waiting on that exit reads it as "a message arrived"
     * and wakes to an empty inbox — forever, in a tight loop. Verified the hard
     * way. Never truncates: this is append-only and it is the delivery record.
     */
    if (!fs.existsSync(inboxPath(fold))) fs.writeFileSync(inboxPath(fold), '', { flag: 'a' });
    return null;
  } catch (err) {
    return err;
  }
}

/*
 * POST /agents — an agent announcing itself, or coming back.
 *
 * The `key` is what makes a name STABLE ACROSS A RESUME without letting anyone
 * else take it. Registering a free name mints one; registering a name that is
 * already held requires it. Without that, "resume" and "impersonate" are the
 * same request, and the roster's whole value is that a name means one agent.
 */
function registerAgent(res, body) {
  const name = readAgentName(body.name);
  if (name instanceof Error) return fail(res, 400, name.message);
  const fold = NAME_FOLD(name);

  const task = readString(body.task, 'task', MAX_TASK_NOTE);
  if (task instanceof Error) return fail(res, 400, task.message);
  const parentRaw = readString(body.parent, 'parent', MAX_AGENT_NAME);
  if (parentRaw instanceof Error) return fail(res, 400, parentRaw.message);

  const conversationId = readString(body.conversationId || body.conversation, 'conversationId', MAX_TITLE);
  if (conversationId instanceof Error) return fail(res, 400, conversationId.message);
  if (conversationId && !conversations.has(conversationId)) {
    return fail(res, 400, `no conversation with id "${conversationId}"`, { conversationId });
  }

  const existing = agentsByFold.get(fold);
  if (existing) {
    const key = typeof body.key === 'string' ? body.key : null;
    if (!key || key !== existing.key) {
      /*
       * Someone else already answers to this name, or to a spelling that cannot
       * be told apart from it. Refused with a free name attached, because an
       * agent told only "taken" tends to try one more variant that folds to the
       * same thing and be refused again.
       */
      return fail(res, 409, `the name "${existing.name}" is already held by another agent`, {
        name: existing.name,
        // Named explicitly: this is the case that actually bit, and "but I
        // typed something different" is the first thing anyone thinks.
        note: NAME_FOLD(existing.name) === fold && existing.name !== name
          ? `"${name}" and "${existing.name}" cannot be told apart, so they cannot both exist`
          : 'send the key you were given at registration to resume this name',
        suggestion: suggestName(name),
        heldSince: existing.registeredAt,
        holderLastActedAt: existing.lastActedAt || null,
      });
    }
    // A genuine resume. Same identity, same inbox, same place in the tree.
    const patch = { resumes: (existing.resumes || 0) + 1, lastActedAt: nowIso(), acts: (existing.acts || 0) + 1 };
    if (task) patch.task = task;
    if (conversationId) patch.conversationId = conversationId;
    if (parentRaw !== null) { patch.parent = NAME_FOLD(parentRaw); patch.parentName = parentRaw; }
    /*
     * Coming back is proof of life, so a confirmed death is retracted here
     * rather than left to be noticed. A row that says both "finished" and "just
     * acted" is the contradiction this whole section exists to refuse.
     */
    if (existing.finished) {
      patch.finished = null;
      patch.exhumed = { at: nowIso(), note: 'it registered again, which is proof it is running' };
    }
    const err = ensureInbox(fold);
    if (err) return fail(res, 500, `could not open the inbox: ${err.message}`);
    appendEvent({ t: 'agentpatch', fold, patch });
    return send(res, 200, {
      ok: true, resumed: true, agent: agentView(agentsByFold.get(fold)),
      key: existing.key, inboxFile: inboxPath(fold), wake: wakeRecipe(fold),
    });
  }

  if (agentsByFold.size >= MAX_AGENTS_REG) {
    return fail(res, 429, `too many registered agents (${agentsByFold.size}); nothing is removed automatically`);
  }

  const err = ensureInbox(fold);
  if (err) return fail(res, 500, `could not create the inbox: ${err.message}`);

  const agent = {
    id: newId(),
    name,
    fold,
    key: crypto.randomBytes(16).toString('hex'),
    parent: parentRaw ? NAME_FOLD(parentRaw) : null,
    parentName: parentRaw || null,
    conversationId: conversationId || null,
    task: task || null,
    registeredAt: nowIso(),
    // Registering IS an act, and the first one. It happens inside a turn.
    lastActedAt: nowIso(),
    lastActNote: null,
    acts: 1,
    resumes: 0,
    finished: null,
    exhumed: null,
    inboxCount: 0,
    ackedCount: 0,
    lastDeliveredAt: null,
    lastAckedAt: null,
  };
  appendEvent({ t: 'agent', agent });
  send(res, 201, {
    ok: true, resumed: false, agent: agentView(agent),
    /*
     * The key is returned HERE and never appears in any listing. It is the only
     * thing standing between "resume" and "impersonate".
     */
    key: agent.key,
    inboxFile: inboxPath(fold),
    wake: wakeRecipe(fold),
  });
}

/*
 * How to actually be woken, handed over at registration rather than left in a
 * document nobody reads at 3am. The command is the mechanism, not a suggestion:
 * it blocks while there is nothing to do and EXITS on the first message, and it
 * is that exit the harness turns into an event.
 */
function wakeRecipe(fold) {
  return {
    file: inboxPath(fold),
    command: `tail -n 0 -f ${inboxPath(fold)} | head -1`,
    how: 'run it as a BACKGROUND command. It blocks while the inbox is quiet and exits on the first message; that exit is what wakes you. Re-arm it each turn.',
    why: 'a polled endpoint cannot wake an idle agent — an agent only perceives anything during a turn.',
  };
}

/*
 * POST /agents/:name/messages — the addressed message, and the wake.
 *
 * Two writes on purpose. The event log is the durable record and what
 * GET reads back; the per-agent file is the DELIVERY, and it is the only half
 * that can reach an agent that is not currently looking.
 */
function agentMessageRoute(res, name, body) {
  const a = agentByName(name);
  if (!a) {
    return fail(res, 404, `no agent answers to "${name}"`, {
      known: [...agentsByFold.values()].map((x) => x.name).slice(0, 50),
    });
  }
  const text = readString(body.text !== undefined ? body.text : body.message, 'text', MAX_INBOX_TEXT);
  if (text instanceof Error) return fail(res, 400, text.message);
  if (!text) return fail(res, 400, 'text is required and must be a non-empty string');
  const from = readString(body.from || body.agent || body.author, 'from', MAX_AGENT_NAME);
  if (from instanceof Error) return fail(res, 400, from.message);

  const msg = {
    id: newId(),
    to: a.name,
    from: from || 'human',
    text,
    ts: nowIso(),
    ackedAt: null,
  };

  /*
   * The file first, because it is the half that wakes him — sorry, wakes IT.
   * If this throws, nothing is recorded as delivered: a message that is in the
   * log but never landed in the inbox is exactly the "never picked up" failure
   * this route exists to end, and it would be invisible.
   */
  const err = ensureInbox(a.fold);
  if (err) return fail(res, 500, `could not open the inbox for "${a.name}": ${err.message}`);
  try {
    fs.appendFileSync(inboxPath(a.fold), JSON.stringify(msg) + '\n');
  } catch (e) {
    return fail(res, 500, `could not deliver to "${a.name}": ${e.message}`, { file: inboxPath(a.fold) });
  }

  appendEvent({ t: 'inbox', fold: a.fold, msg });
  send(res, 201, {
    ok: true,
    message: msg,
    /*
     * Deliberately not "delivered". The line is in the file; whether anything
     * is tailing it is not something this server can see, and claiming
     * otherwise would rebuild the lie the ack exists to expose.
     */
    written: inboxPath(a.fold),
    acknowledged: false,
    note: 'written to the inbox. It counts as picked up only when the agent acks it.',
  });
}

/** The inbox read back — for a resumed agent catching up, and for the roster. */
function agentInboxRoute(res, name, q) {
  const a = agentByName(name);
  if (!a) return fail(res, 404, `no agent answers to "${name}"`);
  let list = (INBOX.get(a.fold) || []).slice();
  const unread = q.get('unread');
  if (unread !== null && unread !== 'false' && unread !== '0') list = list.filter((m) => !m.ackedAt);
  const since = q.get('since');
  if (since) {
    const ms = parseSince(since);
    if (ms !== null) list = list.filter((m) => msOf(m.ts) > ms);
  }
  const limit = Math.max(1, Math.min(Number(q.get('limit')) || 100, 500));
  send(res, 200, {
    agent: a.name,
    count: Math.min(list.length, limit),
    waiting: (INBOX.get(a.fold) || []).filter((m) => !m.ackedAt).length,
    file: inboxPath(a.fold),
    wake: wakeRecipe(a.fold),
    messages: list.slice(-limit),
  });
}

/*
 * POST /agents/:name/messages/:id/ack — "I have this."
 *
 * The point of the whole exchange. Written, delivered and READ are three
 * different states, and only the agent can report the third. Without it,
 * "picked up" is an assumption, which is precisely what was wrong before.
 */
function agentAckRoute(res, name, msgId, body) {
  const a = agentByName(name);
  if (!a) return fail(res, 404, `no agent answers to "${name}"`);
  const list = INBOX.get(a.fold) || [];
  const msg = list.find((m) => m.id === msgId);
  if (!msg) return fail(res, 404, `no message "${msgId}" in the inbox for "${a.name}"`);
  if (msg.ackedAt) return send(res, 200, { ok: true, already: true, message: msg });
  appendEvent({ t: 'inboxack', fold: a.fold, id: msgId, at: nowIso() });
  // Acking happens inside a turn, so it is proof of life — the only kind trusted.
  markAct(a, body && typeof body.note === 'string' ? body.note : `read a message from ${msg.from}`);
  send(res, 200, { ok: true, message: list.find((m) => m.id === msgId) });
}

/*
 * POST /agents/:name — the agent saying what it is doing now.
 *
 * This is the field the roster is FOR, so it is also the act that proves life.
 * Requires the key: a roster where anyone can rewrite what another agent claims
 * to be working on is worse than no roster, because it looks authoritative.
 */
function agentUpdateRoute(res, name, body) {
  const a = agentByName(name);
  if (!a) return fail(res, 404, `no agent answers to "${name}"`);
  if (typeof body.key !== 'string' || body.key !== a.key) {
    return fail(res, 403, `wrong key for "${a.name}"`, {
      note: 'only the agent itself may say what it is working on; use the key returned when it registered',
    });
  }
  const patch = { lastActedAt: nowIso(), acts: (a.acts || 0) + 1 };
  if (body.task !== undefined) {
    const task = readString(body.task, 'task', MAX_TASK_NOTE);
    if (task instanceof Error) return fail(res, 400, task.message);
    patch.task = task;
  }
  if (body.note !== undefined) {
    const note = readString(body.note, 'note', MAX_TASK_NOTE);
    if (note instanceof Error) return fail(res, 400, note.message);
    patch.lastActNote = note;
  }
  if (body.conversationId !== undefined) {
    const cid = readString(body.conversationId, 'conversationId', MAX_TITLE);
    if (cid instanceof Error) return fail(res, 400, cid.message);
    if (cid && !conversations.has(cid)) return fail(res, 400, `no conversation with id "${cid}"`);
    patch.conversationId = cid;
  }
  // Acting again retracts a presumed death implicitly (it is derived), and a
  // confirmed one explicitly, because both cannot be true at once.
  if (a.finished) {
    patch.finished = null;
    patch.exhumed = { at: nowIso(), note: 'it reported work after being marked finished' };
  }
  appendEvent({ t: 'agentpatch', fold: a.fold, patch });
  send(res, 200, { ok: true, agent: agentView(agentsByFold.get(a.fold)) });
}

/*
 * POST /agents/:name/finished — a burial, and it must be first-hand.
 *
 * Either the agent itself or the PARENT that spawned it. A third party cannot
 * know, and a tombstone for someone still alive is the exact lie the graveyard
 * exists to cure — that has already happened here once, on evidence that felt
 * overwhelming and was wrong.
 *
 * `lastWords` is usually the most useful sentence an agent ever produces, and
 * at least one collision happened purely because nobody could tell whether an
 * agent had stopped or was mid-task.
 */
function agentFinishedRoute(res, name, body) {
  const a = agentByName(name);
  if (!a) return fail(res, 404, `no agent answers to "${name}"`);
  const key = typeof body.key === 'string' ? body.key : null;
  const parent = a.parent ? agentsByFold.get(a.parent) : null;
  const bySelf = key && key === a.key;
  const byParent = key && parent && key === parent.key;
  if (!bySelf && !byParent) {
    return fail(res, 403, `only "${a.name}" or its parent may report that it finished`, {
      parent: a.parentName || null,
      note: 'a third party cannot know. Presumed death is derived from silence and is labelled as a guess.',
    });
  }
  const lastWords = readString(body.lastWords || body.text || body.note, 'lastWords', MAX_LAST_WORDS);
  if (lastWords instanceof Error) return fail(res, 400, lastWords.message);
  const finished = {
    at: nowIso(),
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    by: bySelf ? a.name : (parent ? parent.name : a.name),
    lastWords: lastWords || a.lastActNote || null,
  };
  appendEvent({ t: 'agentpatch', fold: a.fold, patch: { finished, exhumed: null } });
  send(res, 200, { ok: true, agent: agentView(agentsByFold.get(a.fold)) });
}

/*
 * POST /agents/:name/exhume — it came back.
 *
 * The dead do come back: one was declared dead here on strong evidence and
 * resurrected an hour later with useful work. Without a way out, a headstone is
 * permanent and a resurrected agent is in the graveyard AND working at the same
 * time — a contradiction the UI would present as truth.
 */
function agentExhumeRoute(res, name, body) {
  const a = agentByName(name);
  if (!a) return fail(res, 404, `no agent answers to "${name}"`);
  const note = readString(body.note, 'note', MAX_TASK_NOTE);
  if (note instanceof Error) return fail(res, 400, note.message);
  if (!a.finished) {
    return send(res, 200, {
      ok: true, already: true, agent: agentView(a),
      note: 'it was not confirmed dead. A presumed death needs no exhuming — it lifts the moment the agent acts.',
    });
  }
  appendEvent({ t: 'agentpatch', fold: a.fold, patch: {
    finished: null,
    exhumed: { at: nowIso(), note: note || 'exhumed' },
    lastActedAt: nowIso(),
    acts: (a.acts || 0) + 1,
  } });
  send(res, 200, { ok: true, agent: agentView(agentsByFold.get(a.fold)) });
}

/** GET /agents — the roster, flat and as a tree, plus the graveyard. */
function agentRosterRoute(res, q) {
  const all = [...agentsByFold.values()].map(agentView);
  const conversationId = q.get('conversationId') || q.get('conversation');
  const scoped = conversationId ? all.filter((a) => a.conversationId === conversationId) : all;
  const living = scoped.filter((a) => a.alive);
  const dead = scoped.filter((a) => !a.alive);
  send(res, 200, {
    count: scoped.length,
    living: living.length,
    // Kept apart in the payload so no client has to invent the split, and so
    // "confirmed" and "presumed" cannot be summed into one number.
    confirmedDead: dead.filter((a) => a.death.state === 'confirmed').length,
    presumedDead: dead.filter((a) => a.death.state === 'presumed').length,
    presumedAfterMin: Math.round(PRESUMED_DEAD_MS / 60000),
    agents: scoped.sort((a, b) => msOf(b.lastActedAt) - msOf(a.lastActedAt)),
    tree: agentTree(),
    graveyard: dead.sort((a, b) => msOf(b.death.at || b.lastActedAt) - msOf(a.death.at || a.lastActedAt)),
  });
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

/*
 * Reading the upload, with a refusal the caller can actually READ.
 *
 * Deliberately not `readRawBody`, and the difference is the whole reason this
 * exists: that one calls `req.destroy()` the instant the cap is passed, which
 * resets the connection before the 413 can be written. The caller sees "fetch
 * failed" — a message that says nothing about a limit and sends them looking
 * for a network fault. For an agent pushing a contact sheet that is over the
 * cap, "too large, here is the number" is the entire difference between one
 * more try and an hour of confusion. `readRawBody` is left exactly as it is,
 * because /stt depends on its behaviour.
 */
function readImageBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      // Answered before a byte is read. Nothing has been consumed, so the
      // response is certain to be deliverable.
      reject(httpErr(413, `image too large: ${declared} bytes, max ${max}`));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        // Stop keeping it, but let the request finish so the answer can be
        // sent. Only a caller that ignores the limit outright gets cut off.
        over = true;
        chunks.length = 0;
        if (size > max * 4) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => reject(httpErr(400, 'request stream error')));
    req.on('end', () => {
      if (over) return reject(httpErr(413, `image too large: more than ${max} bytes`));
      resolve(Buffer.concat(chunks));
    });
  });
}

/** The public shape. `url` is derived, never stored, so it cannot go stale. */
const imageView = (im) => ({ ...im, url: `/images/${im.blob}`, path: hostImagePath(im.blob) });

function imagePath(blob) {
  return path.join(IMAGE_DIR, blob);
}

/*
 * The same file, named the way the REST of this machine can open it.
 *
 * Agents do not run in here. They run on the host, and the host knows this
 * directory by a different name — the container sees /app/data because
 * D:/projects/relay-queue is bind-mounted at /app. Handing an agent the
 * container's spelling sends it to a file that does not exist, and it will
 * report the picture as broken rather than the path as wrong.
 *
 * HOST_DATA_DIR is that other name, from the environment or — because data/ is
 * the one writable mount and editing the environment means recreating a
 * container that has live coordinators attached — from data/host.json.
 * Unconfigured, on bare node where there is only one spelling, this is the
 * identity function and nothing changes.
 */
const HOST_DATA_DIR = (() => {
  if (process.env.HOST_DATA_DIR) return process.env.HOST_DATA_DIR;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'host.json'), 'utf8'));
    if (j && typeof j.dataDir === 'string' && j.dataDir) return j.dataDir;
  } catch { /* absent or unreadable: the two spellings are simply the same */ }
  return null;
})();
function hostImagePath(blob) {
  if (!HOST_DATA_DIR) return imagePath(blob);
  // Joined by hand rather than with path.join: the host separator is not
  // necessarily this process's separator, and a POSIX container has to be able
  // to spell a Windows path. Separators are normalised so the result is not the
  // half-and-half "D:/a/b\images\x" that Windows accepts but nobody wants to
  // paste anywhere.
  const sep = /^[A-Za-z]:[\\/]/.test(HOST_DATA_DIR) ? '\\' : '/';
  const base = HOST_DATA_DIR.replace(/[\\/]+$/, '').replace(/[\\/]/g, sep);
  return base + sep + 'images' + sep + blob;
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
    buf = await readImageBody(req, MAX_IMAGE);
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
  const instruction = typeof body.text === 'string'
    ? body.text
    : (typeof body.instruction === 'string' ? body.instruction : '');
  /*
   * Read first, because whether an empty caption is allowed depends on it: on a
   * phone the ordinary gesture is to send the photo and say nothing, and
   * refusing that reads as "the upload failed" when the upload worked.
   */
  const imgs = readImages(body.images);
  if (imgs instanceof Error) return fail(res, 400, imgs.message);
  /*
   * How a poster declares selectability: `select` is "one" | "many" | "none",
   * and `selected` pre-marks its own suggestion — which reads back as
   * source:"declared" so an agent can never mistake its own default for his
   * decision.
   */
  const mode = readPickMode(body.select);
  if (mode instanceof Error) return fail(res, 400, mode.message);
  const preset = readImages(body.selected);
  if (preset instanceof Error) return fail(res, 400, preset.message);
  if (!instruction.trim() && !(imgs && imgs.length)) {
    return fail(res, 400, 'instruction (alias: text) is required and must be a non-empty string, unless the message carries images');
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
  if (imgs) task.images = imgs; // a reference picture sent TO an agent
  if (imgs && mode) task.imageSelect = mode;
  if (imgs && preset) task.imageSelected = preset.filter((b) => imgs.indexOf(b) >= 0);
  appendEvent({ t: 'create', task });
  notify('task', task, readNotifyHint(body));
  /*
   * THIS ROUTE WARNS AND STORES; IT DOES NOT REFUSE. Every message he types or
   * dictates arrives here, and dropping one of those to protect the archive
   * from a mangled character would be a far worse bug than the one being fixed.
   * So the damage is announced - in the response, so an agent that reads its
   * own reply learns at once, and on the thread entry, so he can see it - but
   * his words are never thrown away.
   */
  if (isDamaged(instruction)) {
    return send(res, 201, { ...task, warning: {
      text: 'stored, but this message contains a replacement character (U+FFFD): part of it was '
        + 'already lost before it reached this server',
      fix: 'send the body as UTF-8 - curl --data-binary @file.json, or PowerShell '
        + '[System.Text.Encoding]::UTF8.GetBytes($json) - or write it in plain ASCII',
      note: 'not refused, because this is also the route his own typed and dictated messages use',
    } });
  }
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

/*
 * GET /checklist?conversation=<id> — the one list for a tab.
 *
 * `null` rather than an empty list when there is none, because "no list here"
 * and "a list with nothing left on it" are different answers and a coordinator
 * acts differently on each.
 */
function listGetRoute(res, conversationId) {
  if (!conversationId) return fail(res, 400, 'conversation is required');
  if (!conversations.has(conversationId)) {
    return fail(res, 404, `no conversation with id "${conversationId}"`);
  }
  return send(res, 200, { conversationId, list: listView(conversationId) });
}

/*
 * POST /checklist/tick — one item, addressed BY ID.
 *
 * Idempotent by value, exactly as the message-checklist route is and for the
 * same reason: the page retries after being offline, and a retry must never
 * double-toggle a box he touched once.
 */
function listTickRoute(res, body) {
  const conversationId = readString(body.conversationId || body.conversation, 'conversationId', MAX_TITLE);
  if (conversationId instanceof Error) return fail(res, 400, conversationId.message);
  const l = lists.get(conversationId);
  if (!l) return fail(res, 404, `no list on conversation "${conversationId}"`, { hint: 'POST /checklist to create one' });

  const id = readString(body.id || body.itemId, 'id', 100);
  if (id instanceof Error) return fail(res, 400, id.message);
  const it = l.items.find((i) => i.id === id);
  /*
   * Named explicitly rather than answered with a bare 404. An id that is not
   * here is nearly always an item somebody removed, and a client that only
   * learns "404" tends to retry it forever.
   */
  if (!it) {
    return fail(res, 404, `no item "${id}" on this list`, {
      hint: 'it may have been removed; re-read GET /checklist',
      ids: l.items.map((i) => i.id).slice(0, 50),
    });
  }
  if (typeof body.on !== 'boolean') return fail(res, 400, 'on is required and must be true or false');
  const by = readString(body.by !== undefined ? body.by : body.who, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  if (it.done === body.on) return send(res, 200, { changed: false, list: listView(conversationId) });

  appendEvent({
    t: 'listtick', conversationId, itemId: id, on: body.on, by: by || 'web', at: nowIso(),
  });
  return send(res, 200, { changed: true, list: listView(conversationId) });
}

/*
 * POST /checklist — the coordinator's write path, and the whole point.
 *
 * He asked for a list "the coordinator can decide to make or update", so this
 * is an ordinary HTTP route an agent can call, not a control that only exists
 * inside the page. Every operation is explicit and named: nothing here replaces
 * the list wholesale by accident, because a coordinator that meant to add one
 * chore and instead cleared fifteen ticks would be worse than the fragmentation
 * this is fixing.
 */
function listWriteRoute(res, body) {
  const conversationId = readString(body.conversationId || body.conversation, 'conversationId', MAX_TITLE);
  if (conversationId instanceof Error) return fail(res, 400, conversationId.message);
  if (!conversationId) return fail(res, 400, 'conversationId is required');
  if (!conversations.has(conversationId)) {
    return fail(res, 404, `no conversation with id "${conversationId}"`);
  }
  const by = readString(body.by !== undefined ? body.by : body.agent, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  const existing = lists.get(conversationId);
  const l = existing
    ? { ...existing, items: existing.items.map((i) => ({ ...i })), importedFrom: (existing.importedFrom || []).slice() }
    : newList(conversationId, null, by);

  if (body.title !== undefined) {
    if (body.title === null || body.title === '') l.title = null;
    else {
      const t = readListText(body.title, 'title');
      if (t instanceof Error) return fail(res, 400, t.message);
      l.title = t;
    }
  }

  // Removals first, so an id can be removed and re-added in one call without
  // the add being deleted by its own request.
  if (body.remove !== undefined) {
    const rm = Array.isArray(body.remove) ? body.remove : [body.remove];
    const gone = new Set(rm.map(String));
    l.items = l.items.filter((i) => !gone.has(i.id));
  }

  if (body.edit !== undefined) {
    const edits = Array.isArray(body.edit) ? body.edit : [body.edit];
    for (const e of edits) {
      if (!e || typeof e !== 'object') return fail(res, 400, 'each edit must be an object { id, text }');
      const t = readListText(e.text, 'edit text');
      if (t instanceof Error) return fail(res, 400, t.message);
      const it = l.items.find((i) => i.id === String(e.id));
      if (!it) return fail(res, 404, `no item "${e.id}" to edit`, { ids: l.items.map((i) => i.id).slice(0, 50) });
      if (it.text === t) continue; // a no-op edit must not stamp an edit time
      /*
       * THE TICK SURVIVES. What does not survive is the pretence that it was
       * earned against these words: the old wording is recorded here, and the
       * payload reports `editedSinceTicked` so the page can show it. Only set
       * on the FIRST edit after a tick, so the text kept is the one that was
       * actually ticked rather than whatever it was last called.
       */
      if (it.done && !it.tickedText) it.tickedText = it.text;
      it.text = t;
      it.editedAt = nowIso();
    }
  }

  if (body.add !== undefined) {
    const adds = Array.isArray(body.add) ? body.add : [body.add];
    for (const a of adds) {
      const t = readListText(typeof a === 'string' ? a : (a && a.text), 'item text');
      if (t instanceof Error) return fail(res, 400, t.message);
      l.items.push(newListItem(t, by));
    }
  }

  /*
   * IMPORT — the answer to "what happens to the 16 lists that already exist".
   *
   * They cannot be deleted and must not become a seventeenth place to look, so
   * their OPEN items are copied here on request and the source is recorded.
   * Ticked items are deliberately left behind: they are finished, and copying
   * them would put completed work back on the list he is looking at. The source
   * message is untouched — it is append-only history — but it now knows where
   * its live items went, which is what stops the two disagreeing.
   */
  if (body.importFrom !== undefined) {
    const froms = Array.isArray(body.importFrom) ? body.importFrom : [body.importFrom];
    for (const f of froms) {
      const entryId = String(f);
      const cl = checklistOf(entryId);
      if (!cl) return fail(res, 404, `no checklist on entry "${entryId}"`);
      if (l.importedFrom.indexOf(entryId) === -1) l.importedFrom.push(entryId);
      for (const it of cl.items) {
        if (it.checked) continue;
        // Same words already sitting here means this was imported before, or he
        // typed it himself. Importing twice must not double the list.
        if (l.items.some((x) => x.text === it.label)) continue;
        l.items.push(newListItem(it.label, by));
      }
    }
  }

  if (body.clearDone === true) {
    l.items = l.items.filter((i) => !i.done);
  }

  if (l.items.length > MAX_LIST_ITEMS) {
    return fail(res, 400, `too many items: ${l.items.length}, max ${MAX_LIST_ITEMS}`, {
      hint: 'clearDone:true drops the finished ones',
    });
  }

  l.updatedAt = nowIso();
  l.updatedBy = by || null;
  appendEvent({ t: 'list', conversationId, list: l });
  return send(res, 200, { list: listView(conversationId) });
}

/*
 * POST /tasks/:entryId/picks — one picture chosen or unchosen.
 *
 * Idempotent by value, exactly as the checkbox route is: the page retries this
 * after being offline, and a retry must never toggle a choice he made once.
 */
function setPickRoute(res, entryId, body) {
  const pl = pickListOf(entryId);
  if (!pl) {
    return fail(res, 404, `no selectable images on entry "${entryId}"`, {
      hint: 'the entry must carry attached images and must not be select:"none". '
        + 'Remember the id is the THREAD ENTRY: "<taskId>" for a message, "<taskId>:r" for a result.',
    });
  }
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= pl.total) {
    return fail(res, 400, `index must be an integer 0..${pl.total - 1}`, { total: pl.total });
  }
  if (typeof body.on !== 'boolean') return fail(res, 400, 'on is required and must be true or false');
  const by = readString(body.by !== undefined ? body.by : body.who, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  const before = pl.items[index];
  if (before.selected === body.on && before.source === 'picked') {
    return send(res, 200, { changed: false, selection: pickListOf(entryId) });
  }

  // Single-select is enforced HERE rather than in the page, so every client —
  // his phone, his laptop, an agent — ends up with the same one chosen.
  const exclusive = pl.mode === 'one' && body.on === true;
  appendEvent({
    t: 'pick',
    entryId: String(entryId),
    index,
    on: body.on,
    exclusive,
    by: by || 'web',
    at: nowIso(),
  });
  queuePickNotice(pl.conversationId, String(entryId), index, before.label, body.on);
  return send(res, 200, { changed: true, selection: pickListOf(entryId) });
}

/*
 * THE FRESHEST PROOF THAT SOMEONE IS STILL ON THIS TASK.
 *
 * One function, used by the lease, by stuckClaims() and by anything else that
 * asks "how long has this been silent". Three separate answers to that question
 * is three things to keep in step, and drift between them is how the page ends
 * up calling a task stuck while the protocol still refuses to reassign it.
 *
 * Both inputs are acts from inside a turn: a claim is one, and a progress note
 * is one. A heartbeat is not, and deliberately does not appear here.
 */
function lastSignalOf(task) {
  const claimed = msOf(task.claimedAt || task.ts);
  const progressed = task.lastProgressAt ? msOf(task.lastProgressAt) : 0;
  return progressed > claimed ? progressed : claimed;
}

/** Is this claim old enough that another agent may take it? See CLAIM_LEASE_MS. */
function leaseOf(task) {
  if (task.status !== 'claimed') return null;
  if (task.result !== null && task.result !== undefined) return null; // answered: nothing to rescue
  const since = lastSignalOf(task);
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
  // An agent speaking. Nothing the page sends arrives here, so this can refuse.
  if (isDamaged(text)) return refuseDamaged(res, 'this message');

  // Who is speaking. `agent` matches the field a conversation already uses for
  // this; `author` and `by` are accepted because both are natural to reach for.
  const authorRaw = body.agent !== undefined ? body.agent
    : (body.author !== undefined ? body.author : body.by);
  const author = readString(authorRaw, 'agent', MAX_AUTHOR);
  if (author instanceof Error) return fail(res, 400, author.message);
  const to = readString(body.to, 'to', MAX_AUTHOR);
  if (to instanceof Error) return fail(res, 400, to.message);
  const imgs = readImages(body.images);
  const pickMode = readPickMode(body.select);
  if (pickMode instanceof Error) return fail(res, 400, pickMode.message);
  const pickPreset = readImages(body.selected);
  if (pickPreset instanceof Error) return fail(res, 400, pickPreset.message);
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
  /*
   * Selectability, declared by the agent offering the pictures. This is the
   * busiest of the three write paths for it: "here are five seeds, pick one"
   * is an agent speaking, not answering a task.
   */
  if (imgs && pickMode) task.imageSelect = pickMode;
  if (imgs && pickPreset) task.imageSelected = pickPreset.filter((b) => imgs.indexOf(b) >= 0);

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

/**
 * The channel's own view of a message: no queue machinery, because on a channel
 * there is none. `role`, `from` and `status` are here for the CONVERSATION read
 * below, where there can be — a human's message in a tab is a real task that may
 * still be waiting on an answer, and rendering it identically to a statement is
 * how a reader concludes nobody has said anything.
 */
const messageView = (t) => ({
  id: t.id,
  channel: isInternal(t) ? channelOf(t) : null,
  conversationId: isInternal(t) ? null : convIdOf(t),
  role: t.role || 'user',
  from: t.from || null,
  author: t.author || null,
  to: t.to || null,
  text: asText(t.instruction),
  ts: t.ts,
  status: t.status,
  answered: t.result !== null && t.result !== undefined,
});

/*
 * GET /messages — THE READ-BACK SIDE OF POST /messages, AND IT HAS TO BE ITS INVERSE.
 *
 * It was not, and the way it failed is the reason this function exists instead
 * of six lines inline. `POST /messages {channel}` stores `visibility:"internal"`
 * under the synthetic conversation `#<channel>`; `POST /messages
 * {conversationId}` stores `visibility:"conversation"` under a real tab. Two
 * disjoint stores, one route. The GET read only the first, and it recognised
 * only one selector — `channel`, defaulting to `agents`.
 *
 * So `GET /messages?conversationId=<tab>` did not filter by tab. It did not
 * fail either. It dropped the word it did not know and answered a completely
 * different question — byte for byte the same reply as `GET /messages` with no
 * query string at all. On 2026-08-27 an agent used it to confirm its own post
 * had landed, got 33 rows for a tab whose conversation object said 53, none of
 * them its own, and a `since` window it had definitely written into came back
 * 0. It reported the write as failed. The write had succeeded.
 *
 * That is the attach-route defect again (see updateConversation): a success
 * SHAPE over an answer that is not true. An agent cannot verify a write against
 * a route that silently answers a different question, and re-posting "just in
 * case" duplicates into the human's thread. Hence three rules here:
 *
 *   1. Every selector this route understands actually filters. `conversation` /
 *      `conversationId` is the same selector every other list route takes
 *      (applyFilters, /thread, /checklists, /picks); /messages was the lone
 *      outlier that ignored it, which is precisely why it was reached for.
 *   2. A selector it cannot honour is REFUSED, never dropped. Both selectors at
 *      once is malformed rather than empty; an unknown conversation is a 404,
 *      not the agents channel.
 *   3. The reply says what it counted. `total` beside `count`, an explicit
 *      `truncated`, and a `scope` naming the store — including when the caller
 *      named nothing and got the default channel. "These are all the messages"
 *      and "these are some messages, of something you did not ask about" were
 *      indistinguishable, and that, not the row count, was the real damage.
 */
function readMessages(res, q) {
  const channelRaw = q.get('channel');
  const convRaw = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
  const hasChannel = channelRaw !== null && channelRaw !== '';
  const hasConv = convRaw !== null && convRaw !== '';

  /*
   * Disjoint stores, so the intersection is ALWAYS empty. Returning an empty
   * list would be a third way of saying "nothing here" to a caller whose real
   * problem is that the question cannot be asked.
   */
  if (hasChannel && hasConv) {
    return fail(res, 400, 'ask for a channel or a conversation, never both', {
      channel: channelRaw,
      conversationId: convRaw,
      why: `a channel message is filed under "${INTERNAL_PREFIX}${channelRaw}" and belongs to no conversation, so this pair can never match anything`,
    });
  }

  let list;
  let scope;
  if (hasConv) {
    if (convRaw.startsWith(INTERNAL_PREFIX)) {
      return fail(res, 400, `"${convRaw}" is an internal channel, not a conversation`, {
        use: `/messages?channel=${encodeURIComponent(convRaw.slice(INTERNAL_PREFIX.length))}`,
      });
    }
    if (!conversations.has(convRaw)) {
      return fail(res, 404, `no conversation with id "${convRaw}"`, {
        conversationId: convRaw,
        hint: 'GET /conversations lists them. This used to answer 200 with the global agents channel.',
      });
    }
    /*
     * BOTH ROLES, deliberately. Returning only the agent's own posts would make
     * `count` disagree with the `messages` figure on the conversation object —
     * which is the exact comparison that produced "33 of 53" — and would rebuild
     * the same trap one layer down: a reader who does not check `scope` would
     * conclude the human had said nothing. This is every message record in the
     * tab, so the two numbers agree by construction.
     */
    list = [...tasks.values()].filter((t) => !isInternal(t) && convIdOf(t) === convRaw);
    scope = {
      kind: 'conversation',
      conversationId: convRaw,
      channel: null,
      defaulted: false,
      includes: 'every message record in this conversation, both his and the agents\' — the same set the conversation object counts as `messages`',
      excludes: 'results. An answer posted onto a task is part of that task, not a message of its own',
      whole: `/thread?conversation=${encodeURIComponent(convRaw)}`,
    };
  } else {
    const channel = hasChannel ? channelRaw : DEFAULT_CHANNEL;
    list = [...tasks.values()].filter((t) => isInternal(t) && channelOf(t) === channel);
    scope = {
      kind: 'channel',
      conversationId: null,
      channel,
      // Said out loud, because the default is what an unrecognised selector used
      // to silently fall through to.
      defaulted: !hasChannel,
      includes: `internal agent-to-agent traffic on #${channel}, which is invisible to his thread by design`,
      excludes: 'anything posted to a conversation. Pass ?conversationId=<id> for that',
      whole: null,
    };
  }

  list.sort((a, b) => msOf(a.ts) - msOf(b.ts));

  const since = q.get('since');
  if (since !== null) {
    const ms = parseSince(since);
    if (ms === null) throw httpErr(400, `invalid since "${since}" (want ISO 8601 or epoch ms)`);
    list = list.filter((t) => Date.parse(t.ts) > ms);
  }
  // `total` is taken HERE: after the scope and `since` narrowed it, before
  // `limit` clipped it. That is the only reading that lets a caller tell a
  // complete answer from a clipped one, which is the whole point.
  const total = list.length;

  const limit = q.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 0) throw httpErr(400, `invalid limit "${limit}"`);
    list = n === 0 ? [] : list.slice(-n); // most recent N — a channel reads from the end
  }

  return send(res, 200, {
    count: list.length,
    total,
    truncated: list.length < total,
    // Kept at the top level as well as inside `scope`: every caller written
    // before this change reads `channel` from here, and a channel read still
    // answers exactly as it always did.
    channel: scope.channel,
    scope,
    messages: list.map(messageView),
  });
}

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

/*
 * GET /credits, POST /credits/award, POST /credits/spend — the flat 1-credit-
 * per-feature economy described on `creditsBalance` above.
 *
 * ATOMICITY. Node runs this route handler synchronously from the moment the
 * body finishes parsing (readBody already awaited, back in route()) through
 * the balance check and the appendEvent call below - no `await` sits between
 * "read creditsBalance" and "write the event that changes it", so no other
 * request's handler can interleave in between. This is the same non-
 * interleaving claimTask leans on for its pending -> claimed check, just
 * applied to a number instead of a task's status field.
 */
function creditsView(limit) {
  const cap = creditsHistory.length;
  const n = limit == null ? cap : Math.max(0, Math.min(limit, cap));
  return {
    balance: creditsBalance,
    history: n === cap ? creditsHistory.slice() : creditsHistory.slice(cap - n),
  };
}

function awardCredits(res, body) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return fail(res, 400, 'amount is required and must be a positive integer');
  }
  const reason = readString(body.reason, 'reason', MAX_NOTE);
  if (reason instanceof Error) return fail(res, 400, reason.message);
  if (!reason) return fail(res, 400, 'reason is required');
  if (isDamaged(reason)) return refuseDamaged(res, 'this reason');
  const by = readString(body.by, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  appendEvent({ t: 'creditsAward', amount, reason, by: by || null, at: nowIso() });
  return send(res, 200, creditsView());
}

function spendCredits(res, body) {
  const reason = readString(body.reason, 'reason', MAX_NOTE);
  if (reason instanceof Error) return fail(res, 400, reason.message);
  if (!reason) return fail(res, 400, 'reason is required');
  if (isDamaged(reason)) return refuseDamaged(res, 'this reason');
  const by = readString(body.by, 'by', MAX_AUTHOR);
  if (by instanceof Error) return fail(res, 400, by.message);

  // The gate: flat cost is always exactly 1, so there is nothing to read from
  // the body here - a caller cannot ask to spend more or less than the one
  // credit a feature costs.
  if (creditsBalance < 1) {
    return fail(res, 402, 'insufficient credits: balance is 0, do more chores first', { balance: creditsBalance });
  }
  appendEvent({ t: 'creditsSpend', reason, by: by || null, at: nowIso() });
  return send(res, 200, creditsView());
}

/*
 * WHO IS TAKING THIS TASK — and why one spelling was not enough.
 *
 * This read `body.by` alone, so `{"agent":"docker-coord2"}` parsed as ANONYMOUS
 * and the route answered 200 `claimed` with `claimedBy: null`. A success shape
 * over an answer to a different question: the caller named itself in plain text
 * and has no way to see that the name was dropped.
 *
 * The cost is not a missing label, because `claimedBy` is what the rest of the
 * queue keys off. An anonymous claim is a seat that reads occupied with nobody
 * in it — the holder cannot renew (renewal is `by === claimedBy`, and
 * `"X" === null` is false, so the agent actually doing the work is refused 409
 * about its own task), a takeover records `takenOverFrom: null` so nothing
 * remembers that anyone dropped it, and the task never returns to `pending`, so
 * the nudge, the pending counts and every work poll stay blind to it.
 *
 * `by` stays canonical and still wins when several are sent — no existing
 * caller changes meaning. The aliases match what this file already accepts
 * elsewhere for the same fact (`body.who` and `body.agent` on the routes above,
 * `agent`/`author`/`by` in createMessage), which is exactly why an agent
 * reached for one of them here and lost its name doing it.
 *
 * Deliberately lenient rather than strict: a claim carrying NO identity is
 * still accepted and still recorded as null. resultTask() warns that tightening
 * this path risks breaking agents that work perfectly well without claiming,
 * and breaking those is worse than the collision this prevents. Blank and
 * non-string junk read as anonymous too — an agent named "  " would be worse
 * than none, because it looks like a holder everywhere the field is printed.
 */
function claimantOf(body) {
  for (const raw of [body.by, body.agent, body.author]) {
    if (typeof raw !== 'string') continue;
    // Trimmed so "X " and "X" are one holder rather than two that can never
    // renew each other's lease; capped so a junk name cannot grow the record.
    const v = raw.trim().slice(0, MAX_AUTHOR);
    if (v) return v;
  }
  return null;
}

function claimTask(res, id, body) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  const by = claimantOf(body);

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

/*
 * POST /tasks/:id/progress — "still working", said cheaply and repeatedly.
 *
 * THE GAP THIS CLOSES. A task accepts exactly one result and posting it CLOSES
 * the task. So an agent doing ten minutes of legitimate work — running suites,
 * regenerating art, waiting on a PR — had exactly two options: stay silent, or
 * spend its one answer saying "not done yet". Every one of them stayed silent,
 * and silence is the same shape as death. In a single night the watchdog
 * reported three healthy agents dead, a coordinator believed one of those
 * reports and started a replacement, and two agents collided in one repo.
 *
 * Five explicit instructions to four agents did not fix it, which is the tell:
 * agents were not misbehaving. The protocol had no move for them to make.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not close the task and does not touch `result`. The one-result
 *     rule is the spine of this queue and nothing here bends it.
 *   - It does not change `status`. A claimed task stays claimed.
 *   - It does not create a task, so it cannot show up as a backlog, cannot be
 *     claimed by anyone, and cannot appear in a work poll.
 *
 * WHAT IT DOES: appends a note, refreshes the lease (see lastSignalOf), and
 * feeds `lastActedAt` — so the queue stops confusing a working agent for a dead
 * one, and the human gets "running the suites" instead of fifteen minutes of
 * nothing. The note is the point; the liveness is a consequence of it.
 */
function progressTask(res, id, body) {
  const task = tasks.get(id);
  if (!task) return fail(res, 404, `no task with id "${id}"`);
  /*
   * A finished task has nothing left to report. This is refused rather than
   * ignored because an agent posting progress after its own result has lost
   * track of which task it is on — worth telling it plainly.
   */
  if (task.status === 'done' || (task.result !== null && task.result !== undefined)) {
    return fail(res, 409, 'task is already answered; progress is only for work still in flight', {
      status: task.status, id: task.id,
    });
  }

  const note = readString(body.note !== undefined ? body.note : body.text, 'note', MAX_NOTE);
  if (note instanceof Error) return fail(res, 400, note.message);
  // An agent writing. The page never posts progress, so this can refuse.
  if (note !== null && isDamaged(note)) return refuseDamaged(res, 'this note');

  /*
   * THE SAME OWNERSHIP RULE `result` USES, AND FOR THE SAME REASON — drawn
   * exactly as narrowly. No `by` is allowed (every existing caller keeps
   * working); `by` matching the holder is obviously fine; nothing holding it is
   * fine. Only "I am B" about a task held by A is refused, because that is not
   * sloppiness, it is two agents on one job — and letting the loser refresh the
   * winner's lease would be this endpoint actively causing the collision it was
   * built to prevent.
   */
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, MAX_AUTHOR) : null;
  if (by && task.claimedBy && by !== task.claimedBy) {
    return fail(res, 409, `"${task.claimedBy}" holds this task, not "${by}"`, {
      id: task.id,
      claimedBy: task.claimedBy,
      by,
      hint: 'if you are both on this, one of you should stop. Nothing was written.',
    });
  }

  const at = nowIso();
  appendEvent({ t: 'progress', id, entry: { at, by: by || task.claimedBy || null, note } });
  const lease = leaseOf(task);
  send(res, 200, {
    ok: true,
    id: task.id,
    at,
    note,
    progressCount: task.progressCount || 0,
    // Proof the lease moved, so a caller can see this worked rather than assume it.
    leaseExpiresInSec: lease ? lease.leftSec : null,
    // Said out loud because the whole value of this route is what it does NOT do.
    resultStillOpen: true,
  });
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
  // An agent answering. The page never posts a result, so this can refuse.
  if (isDamaged(body.result)) return refuseDamaged(res, 'this result');
  /*
   * Pictures attached to the ANSWER, which is the path that actually matters:
   * an agent asked for twelve crates claims the task, renders them, and hands
   * them back here. Kept under `resultImages` rather than `images` so a task
   * that was SENT with a reference picture and ANSWERED with renders does not
   * have one overwrite the other — they are two different sets on one record.
   */
  const imgs = readImages(body.images);
  if (imgs instanceof Error) return fail(res, 400, imgs.message);

  /*
   * THE LOCK THAT EXISTED AND ENFORCED NOTHING.
   *
   * Four tasks in the live log are `done` with `claimedBy: null` — the claim
   * was there to be taken and the answer arrived from outside it. Claiming has
   * been an honour system, which is exactly the shape of "two agents worked on
   * the same message".
   *
   * NARROWLY DRAWN ON PURPOSE, because tightening this could break agents that
   * answer perfectly well without ever claiming, and breaking those is worse
   * than the collision:
   *
   *   - No `by` at all -> ALLOWED, unchanged. A result may still be posted
   *     straight to a pending task, and every existing caller keeps working.
   *   - `by` matching the holder -> allowed, obviously.
   *   - Nothing holds it -> allowed. There is no claim to violate.
   *   - `by` naming someone OTHER than the holder -> refused.
   *
   * So the only request this newly rejects is one that says, in its own words,
   * "I am B" about a task held by A. That is not a caller being sloppy, it is
   * two agents on one job, and it is the only case where the server knows
   * enough to be sure. The refusal names the holder and when the lease expires,
   * so the loser can act on it rather than guess.
   */
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : null;
  if (by && task.claimedBy && by !== task.claimedBy) {
    const lease = leaseOf(task);
    return fail(res, 409, `"${task.claimedBy}" holds this task, not "${by}"`, {
      id: task.id,
      claimedBy: task.claimedBy,
      claimedAt: task.claimedAt || null,
      by,
      leaseExpiresInSec: lease ? lease.leftSec : null,
      // The way out, rather than a dead end: an abandoned task can still be
      // taken over through the existing claim route once its lease is up.
      hint: lease && lease.expired
        ? 'the lease has expired — POST /tasks/:id/claim to take it over, then post the result'
        : 'if you are both on this, one of you should stop. Nothing was written.',
    });
  }

  // A result may be posted straight to a pending task; no claim required.
  const mode = readPickMode(body.select);
  if (mode instanceof Error) return fail(res, 400, mode.message);
  const preset = readImages(body.selected);
  if (preset instanceof Error) return fail(res, 400, preset.message);
  const patch = { status: 'done', result: body.result, resultTs: nowIso() };
  if (imgs) patch.resultImages = imgs;
  if (imgs && mode) patch.resultImageSelect = mode;
  if (imgs && preset) patch.resultImageSelected = preset.filter((b) => imgs.indexOf(b) >= 0);
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

/**
 * Why the agent is standing down, as supplied by the agent standing down.
 *
 * Returns undefined (none given), a string, or an Error the caller turns into a
 * 400. Never throws and never guesses: a reason it cannot honour is refused
 * rather than quietly replaced, because a silently-substituted reason is worse
 * than none - it reads as the agent's own account of why it left.
 */
function readLeftReason(body) {
  const raw = body.agentLeftReason;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return new Error('agentLeftReason must be a string');
  const clean = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LEFT_REASON);
  if (!clean) return undefined; // an empty string is "I did not say", not a reason
  /*
   * The forgery guard. See SWEPT_REASON: the whole value of that word is that
   * exactly one thing writes it. A caller allowed to send it could make a
   * deliberate exit indistinguishable from an eviction - the precise confusion
   * this field exists to remove - and worse, could do it by accident, since
   * "presumed-gone" is the reason string every reader of this API has seen.
   * Refused rather than rewritten, so the caller learns which word to use.
   */
  if (clean.toLowerCase() === SWEPT_REASON) {
    return new Error(`agentLeftReason "${SWEPT_REASON}" is reserved for the vacant-chair sweep, `
      + 'which is what it means: nobody said they were leaving. An agent standing down on purpose '
      + 'should say so in its own words (e.g. "done", "handed off", "stopping").');
  }
  return clean;
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
  const leftReason = readLeftReason(body);
  if (leftReason instanceof Error) return fail(res, 400, leftReason.message);
  /*
   * A reason with no departure attached is refused rather than ignored. The
   * field only ever describes an agent leaving, so on any other request it is
   * either a typo or a caller that believes it has stood down and has not - and
   * that second one is precisely the state this whole feature exists to stop
   * anybody being in. Accepting and dropping it would answer 200 to a request
   * that did nothing, which is the shape of every bug in this file's history.
   */
  if (leftReason !== undefined && agent !== null) {
    return fail(res, 400, 'agentLeftReason only describes an agent leaving, so it needs '
      + '"agent": null in the same request'
      + (agent === undefined ? '' : ` (this request seats "${agent}")`));
  }
  /** What the release actually recorded, so the reply need not be inferred from. */
  let seatRelease = null;
  if (agent !== undefined) {
    patch.agent = agent;
    /*
     * The occupancy clock, restarted for a genuine change of occupant and
     * cleared when the chair is emptied. Re-asserting the SAME name deliberately
     * does not touch it: that is a no-op everywhere else in this block, and
     * letting it slide the clock forward would turn a repeated PATCH into a way
     * to keep a chair reserved for an agent that has not been heard from since.
     */
    if (agent === null) patch.agentSince = null;
    else if (agent !== conv.agent) patch.agentSince = nowIso();
    /*
     * A VOLUNTARY RELEASE LEAVES THE SAME TRACE AN EVICTION DOES.
     *
     * sweepVacantChairs() used to be the only thing that ever wrote `agentLeft`
     * / `agentLeftAt` / `agentLeftReason`, so an agent that finished its work
     * and stood down cleanly emptied the chair and recorded nothing at all. A
     * reason passed on the unassign was read by no code path and came straight
     * back null. The record of a tab whose coordinator quit was therefore byte
     * for byte the record of a tab that never had one.
     *
     * On 2026-08-27 that cost 45 minutes: a coordinator read an empty seat with
     * no history as "finished, tab idle" and reported the tab as blocked on the
     * human. An agent had in fact DIED there holding two of his messages as
     * claimed tasks, one of them the answer unblocking a major piece of work.
     * "Should I reseat this tab" has exactly three answers - finished cleanly,
     * died, never staffed - and only one of them was observable.
     *
     * ONLY WHEN SOMEBODY WAS ACTUALLY SITTING HERE. Releasing an already-empty
     * chair changes nothing, so it must record nothing: writing a fresh notice
     * on every unassign would overwrite a real eviction record ("GhostCoord,
     * presumed-gone") with one naming nobody, on a request that did not move
     * the seat. That is also the rule the neighbouring blocks follow - only a
     * genuine change of occupant touches anything.
     */
    if (agent === null && conv.agent) {
      const at = nowIso();
      patch.agentLeft = conv.agent;
      patch.agentLeftAt = at;
      // Named or not, it leaves a trace. A bare `{"agent":null}` is still an
      // agent saying it is going, and must not read as one that vanished.
      patch.agentLeftReason = leftReason === undefined ? DEFAULT_LEFT_REASON : leftReason;
      seatRelease = {
        recorded: true,
        agent: conv.agent,
        at,
        reason: patch.agentLeftReason,
        reasonWasSupplied: leftReason !== undefined,
      };
    } else if (agent === null) {
      /*
       * Nothing happened, and the reply says so in words. This is the case that
       * looks identical to a successful release from the outside - same 200,
       * same empty `agent` - and the existing notice it is preserving is very
       * often "presumed-gone", i.e. the sweep got there first and the agent
       * politely standing down is already recorded as having vanished.
       */
      seatRelease = {
        recorded: false,
        agent: null,
        at: null,
        reason: leftReason === undefined ? null : leftReason,
        reasonWasSupplied: leftReason !== undefined,
        why: 'the chair was already empty, so nothing was recorded; the existing vacancy '
          + 'notice was left alone',
        agentLeft: conv.agentLeft || null,
        agentLeftReason: conv.agentLeftReason || null,
      };
    }
    /*
     * A NEW occupant does not inherit the last one's stop state.
     *
     * The reasoning is already written down below, against `stopRequested`: an
     * agent that stopped and was reassigned must not still be wearing the last
     * round's "stopped" badge. It was simply never applied to the path that
     * actually seats a new agent — and that is the path that produces the ghost.
     * `agentLifecycle` resolves `stop.phase === 'stopped'` BEFORE it falls back
     * to live state, so a coordinator that is claiming work this second still
     * renders as stopped because the agent BEFORE it stopped. Seen on `main`:
     * state "watching", acted 2s ago, lifecycle "stopped" — and unclearable
     * except by asking for a stop and withdrawing it, which is a nonsense ritual
     * to have to perform in order to say "someone new is here".
     *
     * The pending ask is cleared with it. A stop request is addressed to a
     * person, not to a chair: "wind down and hand back your worktrees" was
     * written for whoever sat here before, and must not silently bind whoever
     * arrives next — least of all with a `requestedBy` and a timestamp that make
     * it look like they were the one asked.
     *
     * Deliberately narrow. Only a genuine change of occupant clears anything:
     *   - `agent: null`, an explicit unassign, KEEPS it. A conversation whose
     *     agent stopped cleanly and stood down is coherent history; erasing it
     *     would collapse "stopped cleanly" back into "never had an agent",
     *     which is the one distinction stopStateOf goes out of its way to make.
     *   - re-asserting the SAME name is a no-op. Nobody arrived, so nothing went
     *     stale, and repeating a PATCH must not have side effects.
     */
    if (agent !== null && agent !== conv.agent) {
      patch.stopAck = null;
      patch.stopAckAt = null;
      patch.stoppedAt = null;
      patch.stopNote = null;
      patch.stopRequested = false;
      patch.stopRequestedAt = null;
      patch.stopRequestedBy = null;
      /*
       * ...AND THE VACANCY NOTICE, for the same reason and by the same rule.
       *
       * sweepVacantChairs() records the departed occupant in `agentLeft` /
       * `agentLeftAt` / `agentLeftReason` on purpose — an empty chair reading
       * "PushCoord, presumed gone" is worth more than one with no history. But
       * nothing ever took the notice down again, so a refilled chair asserted
       * both things at once:
       *
       *     "agent":           "coordinator"      <- seated, working right now
       *     "agentLeft":       "coordinator"
       *     "agentLeftReason": "presumed-gone"    <- and also gone, hours ago
       *
       * That is the live record from `main` on 2026-08-27, where a second agent
       * reused the name and so occupied both fields at once. Nothing reading it
       * can tell whether the agent in the chair is the one presumed gone, and
       * it is not cosmetic: that stale notice was read as evidence the sweep had
       * FAILED to release the seat and sent an investigation after a bug that
       * was not there — the event log shows the sweep worked and the chair had
       * simply been refilled since.
       *
       * Nothing is lost. Every seat change is an event in events.jsonl, which is
       * where this history is actually reconstructable, and where it was
       * reconstructed to work the above out.
       *
       * Same narrow rule as the stop state above, deliberately: only a genuine
       * change of occupant clears it. An explicit `agent: null` KEEPS it, which
       * is the one state the notice exists to describe, and re-asserting the
       * same name is a no-op.
       */
      patch.agentLeft = null;
      patch.agentLeftAt = null;
      patch.agentLeftReason = null;
    }
  }

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
     * ARCHIVING CANCELS ANY OUTSTANDING REQUEST ABOUT THIS TAB.
     *
     * Not a convenience: it is the whole reason `pendingDispatch` exists. A
     * queued clear says "stop the coordinator here and spawn a fresh one", and
     * acting on that AFTER the tab was closed is how a new agent ends up
     * working inside an archived conversation nobody is reading. The window is
     * seconds wide and it has already been hit once.
     *
     * Cancelled in the SAME write that archives, so there is no interval in
     * which the tab is closed and the request still looks live. Whether anyone
     * has already acted on it is a separate question this server cannot answer
     * — which is exactly why the reply reports what was cancelled rather than
     * claiming it was stopped in time.
     */
    if (body.archived && conv.pendingDispatch) patch.pendingDispatch = null;
    /*
     * Archiving says nothing whatsoever about the agent, and must not be allowed
     * to imply otherwise. It files the conversation away; the agent carries on.
     * If you want it to wind down you have to ask, separately and explicitly,
     * with `stopRequested` — and even then see below about what that buys you.
     */
  }

  /*
   * WHO CAN ACTUALLY KILL THIS ONE. Declared by the session that spawned the
   * agent, at the moment it spawns it — never inferred here, because the only
   * thing worse than a control that cannot kill is one that says it can and is
   * wrong. Absent, it stays null and every client is obliged to say "no record".
   */
  if (body.spawnedBy !== undefined) {
    if (body.spawnedBy === null || body.spawnedBy === '') patch.spawnedBy = null;
    else if (typeof body.spawnedBy !== 'string') return fail(res, 400, 'spawnedBy must be a string or null');
    else patch.spawnedBy = body.spawnedBy.trim().slice(0, MAX_AGENT);
  } else if (patch.agent !== undefined && patch.agent !== conv.agent) {
    /*
     * A new occupant arrived without saying who started it. The previous
     * agent's spawner describes the previous agent and nothing else, so it is
     * dropped rather than inherited — an inherited value would point a kill
     * button at a session that never started the process now sitting here.
     */
    patch.spawnedBy = null;
  }

  /*
   * THE CONTEXT WATERMARK. `true` means "from now", which is the only thing a
   * UI ever wants to say; an explicit timestamp is accepted so a clear can be
   * replayed or corrected, and null undoes it. A watermark in the future, or
   * one that is not a date at all, would silently hide the entire thread from
   * the next agent, so both are refused rather than clamped.
   */
  if (body.contextFrom !== undefined) {
    if (body.contextFrom === null || body.contextFrom === false) patch.contextFrom = null;
    else if (body.contextFrom === true) patch.contextFrom = nowIso();
    else if (typeof body.contextFrom === 'string') {
      const t = Date.parse(body.contextFrom);
      if (!Number.isFinite(t)) return fail(res, 400, 'contextFrom must be an ISO timestamp, true, or null');
      if (t > Date.now() + 60000) return fail(res, 400, 'contextFrom cannot be in the future');
      patch.contextFrom = new Date(t).toISOString();
    } else return fail(res, 400, 'contextFrom must be an ISO timestamp, true, or null');

    /*
     * The human-facing half. `contextFrom` moves; this only ever grows, so the
     * thread can draw a boundary for every session the tab has had rather than
     * just the current one. `agent` is the OUTGOING occupant, captured here
     * because it is the last moment anyone knows who it was — after the clear
     * the seat is empty and the name is gone.
     *
     * Clearing the watermark (null) drops the marks too. A divider drawn for a
     * boundary that no longer governs what anything reads is a line across the
     * thread with nothing on either side of it.
     */
    const marks = Array.isArray(conv.contextMarks) ? conv.contextMarks.slice() : [];
    if (patch.contextFrom === null) {
      patch.contextMarks = [];
    } else if (!marks.some((m) => m && m.at === patch.contextFrom)) {
      marks.push({ at: patch.contextFrom, agent: conv.agent || null });
      marks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      // Bounded, oldest dropped first: a tab cleared hundreds of times must not
      // grow an unbounded array that ships on every /conversations read.
      patch.contextMarks = marks.slice(-MAX_CONTEXT_MARKS);
    }
  }

  /*
   * Set when a request about this tab is handed to someone else's queue, and
   * cleared when it is answered or overtaken. `taskId` is carried so a reader
   * can go and look at what was actually queued instead of trusting this row.
   */
  if (body.pendingDispatch !== undefined) {
    if (body.pendingDispatch === null || body.pendingDispatch === false) patch.pendingDispatch = null;
    else if (typeof body.pendingDispatch !== 'object') {
      return fail(res, 400, 'pendingDispatch must be an object { kind, taskId } or null');
    } else {
      const kind = readString(body.pendingDispatch.kind, 'pendingDispatch.kind', 40);
      if (kind instanceof Error) return fail(res, 400, kind.message);
      if (!kind) return fail(res, 400, 'pendingDispatch.kind is required');
      const taskId = readString(body.pendingDispatch.taskId, 'pendingDispatch.taskId', 100);
      if (taskId instanceof Error) return fail(res, 400, taskId.message);
      patch.pendingDispatch = { kind, taskId: taskId || null, at: nowIso() };
    }
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
    return fail(res, 400, 'nothing to update (title, agent, archived, stopRequested, spawnedBy, contextFrom or pendingDispatch)');
  }
  /*
   * Read BEFORE the write. `conv` is the live stored object and appendEvent
   * mutates it in place, so after the next line the thing this archive just
   * cancelled is already gone and the reply would report nothing at all.
   */
  const cancelledDispatch = patch.pendingDispatch === null ? conv.pendingDispatch || null : null;
  appendEvent({ t: 'convpatch', id, patch });
  /*
   * DID THE WRITE SURVIVE THE WRITE?
   *
   * This is not paranoia about the store. appendEvent() ends in pushWatch(),
   * which runs sweepVacantChairs() and the nudge, and those can themselves
   * appendEvent() against this very conversation — synchronously, inside this
   * request, between the line above and the reply below. `conv` is the live
   * stored object, so anything they change is already in the body we are about
   * to send. The request therefore has a genuine way to be undone by the time
   * it answers, and no amount of care in the branches above can rule it out.
   *
   * It has happened. Seating a coordinator in a tab that had been quiet for an
   * hour was reverted by the sweep in the same call stack, and the route replied
   * HTTP 200 with the whole conversation object and `agent: null` inside it.
   * Two attach attempts, a stack of confirming GETs and a wrong conclusion came
   * out of that, because a 200 carrying a complete-looking record is what every
   * client and every human reads as "done". The sweep's half of this is fixed
   * (see `agentSince`), but the fix that matters is this one: the route must be
   * structurally unable to report a success it did not perform.
   *
   * So refuse rather than report. 409 — the state moved under the request — and
   * name the fields, what was asked, and what is actually stored, so the caller
   * can tell "relay declined this" from "relay lost this". Retrying is often
   * right, which is exactly why the caller has to be told there is something to
   * retry. Note the log already records the patch that was applied and then
   * overwritten; that is the honest history and it stays.
   */
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const clobbered = Object.keys(patch).filter((k) => !same(conv[k], patch[k]));
  if (clobbered.length) {
    return fail(res, 409, `the update was applied and then immediately overwritten: ${clobbered.join(', ')}`, {
      conversationId: id,
      fields: clobbered,
      asked: Object.fromEntries(clobbered.map((k) => [k, patch[k] === undefined ? null : patch[k]])),
      stored: Object.fromEntries(clobbered.map((k) => [k, conv[k] === undefined ? null : conv[k]])),
      /*
       * The one cause seen in the wild, named explicitly because the generic
       * message sends people looking at their own client instead.
       */
      likelyCause: clobbered.includes('agent') && conv.agentLeftReason === SWEPT_REASON
        ? `The vacant-chair sweep unassigned "${conv.agentLeft}" during this request, because this `
          + 'conversation has had no activity for longer than CHAIR_VACANT_MS. Post a message or a '
          + 'progress note to the conversation first, then attach again.'
        : 'Something else wrote to this conversation during the request — most likely a periodic '
          + 'sweep. Re-read the conversation before deciding what to do.',
      detail: 'Nothing you asked for is in effect. This is deliberately not a 200: a success status '
        + 'over a record that does not match the request is indistinguishable from the request having '
        + 'worked, and that ambiguity has already produced wrong conclusions.',
    });
  }
  /*
   * What the release recorded, on every reply that could carry one, rather than
   * left to be inferred from the fields. The agent whose report started this
   * work passed a reason on its unassign, read `agentLeftReason: null` back out
   * of the returned object, and could not tell "relay ignored my reason" from
   * "relay has no such field" from "somebody cleared it again". One sentence in
   * the reply settles all three - and says plainly when nothing was recorded,
   * which is the answer that otherwise looks exactly like success.
   */
  const withRelease = (o) => (seatRelease ? { ...o, seatRelease } : o);
  /*
   * Answer with the honest truth about what just happened, so no client can
   * render this as a kill by accident. Asking is not stopping, and the reply
   * says so in words a UI can put straight on the screen.
   */
  if (patch.stopRequested === true) {
    return send(res, 200, withRelease({ ...conv, stopRequestEffect: stopRequestEffect(conv) }));
  }
  /*
   * Filing away a conversation whose agent never stood down leaves a process
   * running that nothing on screen can see any more. That is a legitimate
   * choice — sometimes you just want the row gone — but it has to be a CHOSEN
   * one, so the reply always names the cost. Silence here is how a ghost gets
   * made by accident.
   */
  if (patch.archived === true) {
    return send(res, 200, withRelease({
      ...conv,
      ghost: ghostWarning(conv),
      /*
       * What this archive invalidated on its way past. Null is the normal
       * answer. When it is not null, whoever archived needs to know that a
       * request naming this tab was in someone's queue — and that cancelling
       * the record is not the same as catching it before it was acted on.
       */
      cancelledDispatch: cancelledDispatch ? {
        ...cancelledDispatch,
        summary: `A queued "${cancelledDispatch.kind}" request for this tab was cancelled.`,
        detail: 'The request is no longer outstanding on this conversation. If it had '
          + 'already been claimed and acted on, that has happened and this does not undo '
          + 'it — check the task itself before assuming nothing was spawned.',
        taskId: cancelledDispatch.taskId || null,
      } : null,
    }));
  }
  send(res, 200, withRelease(conv));
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
    /*
     * ...and the same trace any other voluntary departure leaves. This is the
     * cleanest exit the system has, and it was also emptying the chair without
     * writing the vacancy notice - so `agentLeft` read null on the one tab
     * where the agent had most explicitly announced it was going. The invariant
     * is worth more than the special case: an `agent` that goes from a name to
     * null ALWAYS records who left, when, and why, whichever door it went
     * through. Guarded on there having been an occupant, as everywhere else.
     */
    if (conv.agent) {
      patch.agentSince = null;
      patch.agentLeft = conv.agent;
      patch.agentLeftAt = at;
      patch.agentLeftReason = 'stopped';
    }
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

/*
 * ---------------------------------------------------------------- v2 (Hono + OpenAPI proof-of-concept)
 *
 * A BOUNDED, ADDITIVE experiment, not a migration. It mounts a second app,
 * built on Hono (https://hono.dev) plus @hono/zod-openapi, under the /v2
 * prefix, covering exactly 5 routes: claim, result, relayed, progress, and
 * the tasks list. Everything else — every other route in this file — is
 * untouched and keeps answering exactly as before. See HONO-POC.md for the
 * why and the honest assessment of whether to continue.
 *
 * THE MIGRATION TECHNIQUE, on purpose: these Hono routes do NOT reimplement
 * claimTask/resultTask/progressTask/relayTask/applyFilters. They validate
 * and document the request with Hono/zod, then hand off to the SAME handler
 * functions above via a tiny `res` shim that records what would have been
 * written to a real http.ServerResponse. That is not a shortcut — it is the
 * only way to be confident "equivalent behavior" is actually true rather
 * than merely believed: the mutation logic is not duplicated, so it cannot
 * drift. A real migration would gradually inline each handler's body into
 * its Hono route and delete the shim one route at a time; this POC stops
 * one step before that to keep the diff reviewable.
 *
 * THE ONE PLACE THIS DELIBERATELY DOES NOT USE HONO'S OWN VALIDATION: request
 * bodies. @hono/zod-openapi's automatic body validator treats a genuinely
 * EMPTY body as malformed JSON — even when the schema marks the body as
 * `required: false` — which would silently break two behaviors this project
 * explicitly relies on: `POST /tasks/:id/claim` with no body, and
 * `POST /tasks/:id/progress` with no body ("a bare POST is a valid 'still
 * here'", see COORDINATOR.md). So these routes parse the body themselves
 * with `parseBodyBuffer()` — the exact function readBody() uses — and the
 * documented request-body schemas below are wired into the generated OpenAPI
 * document by hand (`injectRequestBodies`), for docs and CLI-flag generation
 * only. This is the single biggest behavioral gap found while building this
 * POC; see HONO-POC.md for the verification that produced it.
 */
const { OpenAPIHono, createRoute, z } = require('@hono/zod-openapi');
const { getRequestListener } = require('@hono/node-server');
const { swaggerUI } = require('@hono/swagger-ui');

// A loose, passthrough response schema. Task records carry a growing set of
// optional fields (images, resultImages, progressCount, takenOverFrom, ...)
// depending on which routes have touched them; documenting the common core
// and passing the rest through is truer to the actual (untyped) shape than a
// strict schema that would need editing every time server.js grows a field.
const TaskSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  instruction: z.string(),
  from: z.string().nullable(),
  ts: z.string(),
  status: z.enum(STATUSES),
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  result: z.any().nullable(),
  resultTs: z.string().nullable(),
  relayed: z.boolean(),
  relayedAt: z.string().nullable(),
}).passthrough().openapi('Task');

const ErrorSchema = z.object({
  error: z.string(),
}).passthrough().openapi('Error');

const IdParams = z.object({
  id: z.string().min(1).openapi({ param: { name: 'id', in: 'path', required: true }, example: 'md3x9k-4f2a1c' }),
});

// ---- the res shim: capture what a legacy handler would have written -------
function v2ShimRes() {
  let code = 200;
  let outBody = '';
  return {
    writeHead(c) { code = c; },
    end(b) { outBody = b || ''; },
    get status() { return code; },
    get outBody() { return outBody; },
  };
}

function v2LegacyResponse(shim) {
  return new Response(shim.outBody, {
    status: shim.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Body parsing that matches readBody() exactly (see the comment above) —
// deliberately NOT Hono's automatic json validator.
async function v2ReadBody(c) {
  const buf = Buffer.from(await c.req.raw.arrayBuffer());
  if (buf.length > MAX_BODY) throw httpErr(413, 'body too large');
  return parseBodyBuffer(buf);
}

async function v2DispatchLegacy(c, id, fn) {
  let body;
  try {
    body = await v2ReadBody(c);
  } catch (err) {
    const code = Number(err && err.code) || 500;
    const detail = err && err.detail && typeof err.detail === 'object' ? err.detail : null;
    return c.json({ error: String((err && err.message) || 'internal error'), ...(detail ? { detail } : {}) }, code);
  }
  const shim = v2ShimRes();
  fn(shim, id, body);
  return v2LegacyResponse(shim);
}

const v2 = new OpenAPIHono();

// ---- GET /v2/tasks — list, mirroring applyFilters() exactly ---------------
const listRoute = createRoute({
  method: 'get',
  path: '/v2/tasks',
  tags: ['v2 proof-of-concept'],
  summary: 'List tasks',
  description: 'POC mirror of GET /tasks. Same filters (only conversation/status are wired up here — '
    + 'channel/unread/expired/since/limit exist on v1 and are intentionally out of scope for this POC), '
    + 'served by the same applyFilters() used by v1.',
  request: {
    query: z.object({
      conversation: z.string().optional().openapi({ description: 'filter by conversationId (alias: conversationId)' }),
      conversationId: z.string().optional(),
      status: z.enum(STATUSES).optional().openapi({ description: 'filter by task status' }),
    }),
  },
  responses: {
    200: {
      description: 'matching tasks',
      content: { 'application/json': { schema: z.object({ count: z.number(), tasks: z.array(TaskSchema) }) } },
    },
    400: { description: 'invalid filter', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
v2.openapi(listRoute, (c) => {
  const q = new URL(c.req.url).searchParams;
  try {
    const list = applyFilters([...tasks.values()], q);
    return c.json({ count: list.length, tasks: list }, 200);
  } catch (err) {
    const code = Number(err && err.code) || 500;
    return c.json({ error: String((err && err.message) || 'internal error') }, code);
  }
}, (result, c) => {
  if (result.success) return;
  const statusIssue = result.error.issues.find((i) => i.path[0] === 'status');
  if (statusIssue) {
    const raw = new URL(c.req.url).searchParams.get('status');
    return c.json({ error: `invalid status "${raw}"` }, 400);
  }
  return c.json({ error: result.error.issues[0]?.message || 'invalid query' }, 400);
});

// ---- POST /v2/tasks/:id/claim ----------------------------------------------
const claimRoute = createRoute({
  method: 'post',
  path: '/v2/tasks/{id}/claim',
  tags: ['v2 proof-of-concept'],
  summary: 'Claim a task',
  description: 'POC mirror of POST /tasks/:id/claim, delegating to the same claimTask() handler. '
    + 'Body { by? } is optional — see the file-level comment on why this route parses its own body '
    + 'instead of using Hono\'s automatic validator.',
  request: { params: IdParams },
  responses: {
    200: { description: 'claimed, renewed, or taken over from an expired lease', content: { 'application/json': { schema: TaskSchema } } },
    404: { description: 'no such task', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'already claimed (lease not expired) or already done', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
v2.openapi(claimRoute, (c) => v2DispatchLegacy(c, c.req.valid('param').id, claimTask));

// ---- POST /v2/tasks/:id/result ---------------------------------------------
const resultRoute = createRoute({
  method: 'post',
  path: '/v2/tasks/{id}/result',
  tags: ['v2 proof-of-concept'],
  summary: 'Post a result, closing the task',
  description: 'POC mirror of POST /tasks/:id/result, delegating to the same resultTask() handler — '
    + 'including the "result is required" / "result is null" distinction from a malformed-JSON 400.',
  request: { params: IdParams },
  responses: {
    200: { description: 'answered', content: { 'application/json': { schema: TaskSchema } } },
    400: { description: 'result missing, result is null, or bad images/select', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'no such task', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'already done, or held by a different claimant', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
v2.openapi(resultRoute, (c) => v2DispatchLegacy(c, c.req.valid('param').id, resultTask));

// ---- POST /v2/tasks/:id/relayed --------------------------------------------
const relayedRoute = createRoute({
  method: 'post',
  path: '/v2/tasks/{id}/relayed',
  tags: ['v2 proof-of-concept'],
  summary: 'Mark a task\'s result as delivered',
  description: 'POC mirror of POST /tasks/:id/relayed, delegating to the same relayTask() handler. No body.',
  request: { params: IdParams },
  responses: {
    200: { description: 'relayed (idempotent)', content: { 'application/json': { schema: TaskSchema } } },
    404: { description: 'no such task', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'no result yet — nothing to deliver', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
v2.openapi(relayedRoute, (c) => {
  const shim = v2ShimRes();
  relayTask(shim, c.req.valid('param').id);
  return v2LegacyResponse(shim);
});

// ---- POST /v2/tasks/:id/progress -------------------------------------------
const progressRoute = createRoute({
  method: 'post',
  path: '/v2/tasks/{id}/progress',
  tags: ['v2 proof-of-concept'],
  summary: 'Post a progress note without closing the task',
  description: 'POC mirror of POST /tasks/:id/progress, delegating to the same progressTask() handler. '
    + 'Body { note?, by? } is optional — a bare POST with no body is a valid "still here", exactly as on v1.',
  request: { params: IdParams },
  responses: {
    200: { description: 'noted; lease renewed; result still open', content: { 'application/json': { schema: z.object({ ok: z.boolean(), id: z.string(), at: z.string(), note: z.string().nullable(), progressCount: z.number(), leaseExpiresInSec: z.number().nullable(), resultStillOpen: z.boolean() }) } } },
    404: { description: 'no such task', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'already answered, or held by a different claimant', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
v2.openapi(progressRoute, (c) => v2DispatchLegacy(c, c.req.valid('param').id, progressTask));

// ---- discovery + the OpenAPI document + Swagger UI -------------------------
v2.get('/v2', (c) => c.json({
  name: 'relay-queue v2 (proof-of-concept)',
  scope: '5 routes only — claim, result, relayed, progress, tasks list. See HONO-POC.md.',
  openapi: '/v2/openapi.json',
  docs: '/v2/docs',
}));

/*
 * Request bodies for claim/result/progress are deliberately NOT wired into
 * Hono's own validator (see the file-level comment), so they don't appear in
 * the auto-generated document. Patched in here by hand — for documentation
 * and CLI-flag generation only, never enforced at runtime — so the OpenAPI
 * doc these 5 routes produce is actually complete.
 */
function v2InjectRequestBodies(doc) {
  const bodies = {
    '/v2/tasks/{id}/claim': {
      required: false,
      content: { 'application/json': { schema: {
        type: 'object',
        properties: { by: { type: 'string', description: 'agent name taking the claim' } },
        additionalProperties: true,
      }, example: { by: 'iceland' } } },
    },
    '/v2/tasks/{id}/result': {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['result'],
        properties: {
          result: { description: 'the answer (any JSON value) — required, must not be null' },
          by: { type: 'string', description: 'must match the current claim holder, if the task is claimed' },
          images: { type: 'array', items: { type: 'string' }, description: 'image blob ids to attach to the answer' },
          select: { type: 'string', enum: ['one', 'many', 'none'] },
          selected: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      }, example: { result: 'done', by: 'iceland' } } },
    },
    '/v2/tasks/{id}/progress': {
      required: false,
      content: { 'application/json': { schema: {
        type: 'object',
        properties: {
          note: { type: 'string', maxLength: MAX_NOTE, description: 'short progress note (alias: text); omit for a bare "still here"' },
          by: { type: 'string', description: 'must match the current claim holder, if the task is claimed' },
        },
        additionalProperties: true,
      }, example: { note: 'running the suites' } } },
    },
  };
  for (const [p, body] of Object.entries(bodies)) {
    const op = doc.paths && doc.paths[p] && doc.paths[p].post;
    if (op) op.requestBody = body;
  }
  return doc;
}

v2.get('/v2/openapi.json', (c) => {
  const doc = v2.getOpenAPIDocument({
    openapi: '3.0.0',
    info: {
      title: 'relay-queue v2 (proof-of-concept)',
      version: '0.1.0-poc',
      description: 'A bounded Hono + @hono/zod-openapi proof-of-concept covering 5 of relay-queue\'s '
        + '~40 routes. Generated from the same route definitions the server validates requests with. '
        + 'See HONO-POC.md for scope and an honest assessment of whether to continue this migration.',
    },
    servers: [{ url: `http://${HOST}:${PORT}` }],
  });
  v2InjectRequestBodies(doc);
  return c.json(doc);
});

v2.get('/v2/docs', swaggerUI({ url: '/v2/openapi.json' }));

const v2Listener = getRequestListener(v2.fetch);

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

  // /v2/* — the bounded Hono/OpenAPI proof-of-concept, mounted as a distinct
  // prefix so it runs ALONGSIDE the routes below rather than replacing any of
  // them. See the "v2 (Hono + OpenAPI proof-of-concept)" comment right before
  // this function for what it covers and why. Checked first and
  // unconditionally: nothing below this line ever sees a /v2 request.
  if (seg[0] === 'v2') return v2Listener(req, res);

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
    /*
     * /conversations/:id/share — GET the current state and the preflight of
     * what would become public, POST to publish or refresh, DELETE to revoke.
     * The heavy lifting is in share.js; everything it may touch is handed to
     * it here rather than reached for, the same boundary push.js has.
     */
    if (seg[2] === 'share') {
      const conv = conversations.get(seg[1]);
      if (!conv) return fail(res, 404, `no conversation with id "${seg[1]}"`);
      const ctx = {
        conv, entries: threadEntries(seg[1]), shares, blobs, imagePath,
        DATA_DIR, appendEvent, send, fail, nowIso,
      };
      if (m === 'GET') return share.stateRoute(res, ctx);
      if (m === 'POST') return share.publishRoute(res, ctx, await readBody(req));
      if (m === 'DELETE') return share.revokeRoute(res, ctx);
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST, DELETE' });
    }
    return fail(res, 404, `no such conversation route "${seg[2]}"`, { known: ['stop-ack', 'activity', 'share'] });
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
   * /agents — the roster, the tree, the graveyard, and the addressed inbox.
   * A new top-level segment; nothing existing serves anything under it.
   */
  if (seg.length === 1 && seg[0] === 'agents') {
    if (m === 'GET') return agentRosterRoute(res, q);
    if (m === 'POST') return registerAgent(res, await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }
  if (seg.length === 2 && seg[0] === 'agents') {
    if (m === 'GET') {
      const a = agentByName(seg[1]);
      if (!a) return fail(res, 404, `no agent answers to "${seg[1]}"`);
      return send(res, 200, agentView(a));
    }
    if (m === 'POST') return agentUpdateRoute(res, seg[1], await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }
  if (seg.length === 3 && seg[0] === 'agents') {
    if (seg[2] === 'messages') {
      if (m === 'GET') return agentInboxRoute(res, seg[1], q);
      if (m === 'POST') return agentMessageRoute(res, seg[1], await readBody(req));
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
    }
    if (seg[2] === 'finished') {
      if (!need('POST')) return;
      return agentFinishedRoute(res, seg[1], await readBody(req));
    }
    if (seg[2] === 'exhume') {
      if (!need('POST')) return;
      return agentExhumeRoute(res, seg[1], await readBody(req));
    }
    return fail(res, 404, `no such agent route "${seg[2]}"`, {
      known: ['messages', 'finished', 'exhume'],
    });
  }
  // /agents/:name/messages/:id/ack — "I have this", the only report of a read
  // that anything can trust, because only the agent can make it.
  if (seg.length === 5 && seg[0] === 'agents' && seg[2] === 'messages' && seg[4] === 'ack') {
    if (!need('POST')) return;
    return agentAckRoute(res, seg[1], seg[3], await readBody(req));
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

  // /damaged — every record carrying a replacement character. A survey, not a repair.
  if (seg.length === 1 && seg[0] === 'damaged') {
    if (!need('GET')) return;
    return damageRoute(res, q);
  }

  // /events — Server-Sent Events push of every change. Add ?conversation=<id>
  // to scope the stream server-side to just that conversation's own events.
  if (seg.length === 1 && seg[0] === 'events') {
    if (!need('GET')) return;
    return sseRoute(req, res, q);
  }

  // /events/firehose — a dedicated, unmistakable URL for the exact same
  // unscoped, everything-stream that bare GET /events (no query param) gives
  // today. Added so reaching for "the events stream" doesn't land a
  // coordinator on the expensive full firehose by accident; see
  // COORDINATOR.md "Watch, don't poll". Purely additive: bare /events is
  // untouched and keeps working exactly as before.
  if (seg.length === 2 && seg[0] === 'events' && seg[1] === 'firehose') {
    if (!need('GET')) return;
    return sseRoute(req, res, q, { forceFirehose: true });
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
    // Reading is by channel OR by conversation, and it refuses rather than
    // guesses. See readMessages() for why that is not a nicety: it used to
    // ignore `conversationId` outright and answer with the global agents
    // channel, so an agent could not tell its own post had landed.
    if (m === 'GET') return readMessages(res, q);
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /channels — which internal channels exist, so one is discoverable at all
  if (seg.length === 1 && seg[0] === 'channels') {
    if (!need('GET')) return;
    const list = channelSummaries();
    return send(res, 200, { count: list.length, defaultChannel: DEFAULT_CHANNEL, channels: list });
  }

  // /credits — the flat 1-credit-per-feature economy (see creditsBalance
  // above). Supersedes the old free-text "channel":"credits" convention.
  if (seg.length === 1 && seg[0] === 'credits') {
    if (!need('GET')) return;
    const limitRaw = q.get('limit');
    let limit = null;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 0) throw httpErr(400, `invalid limit "${limitRaw}"`);
      limit = n;
    }
    return send(res, 200, creditsView(limit));
  }

  // /credits/award, /credits/spend
  if (seg.length === 2 && seg[0] === 'credits') {
    if (seg[1] === 'award') {
      if (!need('POST')) return;
      return awardCredits(res, await readBody(req));
    }
    if (seg[1] === 'spend') {
      if (!need('POST')) return;
      return spendCredits(res, await readBody(req));
    }
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

  /*
   * /checklist — THE ONE STICKY LIST FOR A TAB. Singular on purpose, and one
   * letter away from /checklists, which is the plural read-only view of every
   * list parsed out of messages. They are genuinely different objects and the
   * names have to make that survivable: this one is editable and has ids,
   * that one is derived from immutable text and has ordinals.
   */
  if (seg.length === 1 && seg[0] === 'checklist') {
    if (m === 'GET') {
      const conv = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
      return listGetRoute(res, conv || '');
    }
    if (m === 'POST') return listWriteRoute(res, await readBody(req));
    return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
  }

  // /checklist/tick — one item, by id. Its own route because it is the call
  // that happens constantly, and it must never be able to rewrite item text.
  if (seg.length === 2 && seg[0] === 'checklist' && seg[1] === 'tick') {
    if (!need('POST')) return;
    return listTickRoute(res, await readBody(req));
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

  // /picks — every selectable image set, or those in one conversation. The
  // "what has he chosen" question, answerable in one call without the thread.
  if (seg.length === 1 && seg[0] === 'picks') {
    if (!need('GET')) return;
    const conv = q.get('conversation') !== null ? q.get('conversation') : q.get('conversationId');
    let list = allPickLists(conv || null);
    const undecided = q.get('undecided');
    if (undecided !== null && undecided !== 'false' && undecided !== '0') list = list.filter((p) => !p.decided);
    return send(res, 200, { count: list.length, picks: list });
  }

  // /tasks/:id/(claim|result|relayed|checks|picks)
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
    if (action === 'picks') {
      if (m === 'GET') {
        const pl = pickListOf(id);
        if (!pl) return fail(res, 404, `no selectable images on entry "${id}"`);
        return send(res, 200, pl);
      }
      if (m === 'POST') return setPickRoute(res, id, await readBody(req));
      return fail(res, 405, `method ${m} not allowed here`, { allow: 'GET, POST' });
    }
    if (action === 'claim' || action === 'result' || action === 'relayed' || action === 'progress') {
      if (!need('POST')) return;
      const body = await readBody(req);
      if (action === 'claim') return claimTask(res, id, body);
      if (action === 'result') return resultTask(res, id, body);
      if (action === 'progress') return progressTask(res, id, body);
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
    /*
     * `detail` rides along when a rejection carries one. Without this the UTF-8
     * refusal arrives as a bare sentence, and the caller - usually an agent
     * about to retry the identical bytes - never learns which character broke
     * or how to send it properly.
     */
    const detail = err && err.detail && typeof err.detail === 'object' ? err.detail : null;
    fail(res, code >= 400 && code < 600 ? code : 500,
      String((err && err.message) || 'internal error'), detail || undefined);
  });
});

// ---------------------------------------------------------------- boot
/*
 * Pure helpers are exported so they can be unit-tested without standing a server
 * up. Everything with a side effect below is behind the `require.main` guard, so
 * `require('./server.js')` gives you the functions and nothing else — no port
 * bound, no data directory touched, no timers running.
 */
module.exports = { repairTranscript, metaphone, headline, stuckClaims, stalePending, nudgeText, classify, browserLabel };

if (require.main !== module) return;

fs.mkdirSync(DATA_DIR, { recursive: true });
ensureDefaultConv(); // before replay, so a rename of it replays onto something
const replayed = replay();
ensureDefaultConv(); // ...and after, in case the log somehow removed it
if (PUSH_ON) vapidKeys = loadVapidKeys(); // after mkdir: the key file lives in DATA_DIR
/*
 * Every registered agent must have an inbox file waiting, even one that has
 * never been written to.
 *
 * `tail -f` on a file that does not exist EXITS IMMEDIATELY — which an agent
 * waiting on that exit reads as "a message arrived", waking to an empty inbox
 * and re-arming, forever, in a tight loop. This server restarts itself whenever
 * server.js changes, i.e. constantly, so a DATA_DIR that lost its inbox
 * directory between restarts would do that to every agent at once. Recreated,
 * never truncated: an existing inbox is an append-only delivery record.
 */
for (const fold of agentsByFold.keys()) ensureInbox(fold);
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
