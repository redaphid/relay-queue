#!/usr/bin/env node
'use strict';
/*
 * autoseat - seat a coordinator in a tab that has a human message and nobody in it.
 *
 * WHY THIS IS A HOST PROCESS AND NOT A CONTAINER.
 *
 * relay-queue is a passive queue: it records routing that something else
 * decides, and it deliberately never spawns anything. `relay-watchdog` already
 * finds unstaffed tabs correctly and says so - but it is a container, and so is
 * the server, and neither can start a Claude process. The thing that actually
 * dispatched coordinators was a Claude session seated as agent `Router` in
 * `main`, running a self-paced loop. Its own design note records the flaw:
 * "the router is a single point of failure and nothing restarts it but the
 * human." When it dies the watchdog reports `router unreachable, N tabs need
 * dispatch` into a channel nobody is reading, and the human has to ask for a
 * reseat by hand. That ask is what this file removes.
 *
 * So this is the last mile and nothing else: detection already worked, and the
 * remedy needs to run somewhere that can execute `claude`. That is the host.
 *
 * WHAT IT WILL NOT DO, AND WHY EACH GUARD EXISTS.
 *
 *   - It never seats a tab that has an agent WHO IS ACTUALLY THERE. `conv.agent`
 *     must be null, OR the server's own `agentState.seatUnwatched` must be true
 *     - re-read in the instant before the spawn either way, because the
 *     interesting race is a human or a router seating the tab while this
 *     process was deciding. `seatUnwatched` is the server noticing nobody is
 *     subscribed to that conversation's SSE stream, combined with a grace
 *     window and every other signal of life (heartbeat, lastActedAt,
 *     lastProgressAt) - see seatWatchInfo() in server.js. It exists because
 *     `conv.agent` alone cannot tell a live coordinator from one whose PROCESS
 *     exited while its name stayed on the seat ("FluxPrep": answered a few
 *     messages, finished, exited - and 12 messages queued for 9 minutes behind
 *     a seat that still read as staffed, because nothing ever unseated it).
 *
 *   - It never dispatches twice for the same human message. State is keyed on
 *     TASK ID and written BEFORE the spawn, so a crash mid-dispatch loses the
 *     coordinator, not the memory that one was already sent. This is
 *     repetition-bounding, not rate-limiting, and the distinction is the whole
 *     point: a rate limit bounds volume per window and then resets, so against
 *     a fault that does not clear it refires forever. This system has already
 *     been buried once by exactly that shape - 215 of 220 pending items were a
 *     watchdog nagging about its own dead agents. A cap of "one dispatch per
 *     thing the human actually said" cannot produce a backlog no matter how
 *     long the fault lasts, because the human only says a finite number of
 *     things.
 *
 *   - It never dispatches on anything but a human message. The test is
 *     `role === 'user' && from === 'web'`, which is structural rather than a
 *     heuristic: agent posts carry `role: 'agent'`, the watchdog's own pokes
 *     carry `from: 'relay-watchdog'`, and checklist settles carry
 *     `from: 'checklist'`. This is what stops the obvious infinite loop, where
 *     a dispatched agent's own writes look like new work and dispatch another.
 *
 *   - It never dispatches into a thread that was closed on purpose - archived,
 *     or `stopAck === 'stopped'`. Those are finished, not forgotten, and there
 *     is by definition nobody left in them to answer.
 *
 * The grace period is not politeness either: it is the window in which a human
 * who is already opening the tab gets to seat it himself without a race.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DEFAULT_QUEUE = 'http://127.0.0.1:3901';
const DEFAULT_STATE = path.join(os.homedir(), '.relay-autoseat', 'state.json');

/* The human's own client. Everything else that can create a `role: "user"`
 * task - `checklist` settles, and anything a machine posts - is deliberately
 * NOT this value, which is why the trigger can be one equality test. */
const HUMAN_FROM = 'web';

/* How long a dispatch record is kept. Long enough that a message from last week
 * cannot be re-dispatched by a restart; short enough that the file stays small. */
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------- pure core

/*
 * The whole decision, as a function of data. Separated from the IO so it can be
 * driven by fixtures - including fixtures that SHOULD be refused, which is the
 * only way to know the refusals are real and not merely untested.
 *
 * Returns every task considered and why, not just the winners. A selector that
 * only reports what it accepted cannot be audited: "it picked nothing" and "it
 * looked at nothing" produce identical output.
 */
function selectSeats(opts) {
  const tasks = opts.tasks || [];
  const conversations = opts.conversations || [];
  const dispatched = opts.dispatched || new Set();
  const inFlight = opts.inFlight || new Set();
  const ignore = opts.ignore || new Set();
  const now = opts.now;
  const graceMs = opts.graceMs;
  const maxConcurrent = opts.maxConcurrent == null ? 3 : opts.maxConcurrent;

  const byId = new Map(conversations.map((c) => [c.id, c]));
  const chosen = [];
  const considered = [];
  const takenThisPass = new Set();

  /* Oldest first. If the cap bites, the message that has waited longest is the
   * one that gets answered - the opposite order would starve exactly the tab
   * the human is most annoyed about. */
  const ordered = tasks.slice().sort((a, b) => Date.parse(a.ts || 0) - Date.parse(b.ts || 0));

  for (const t of ordered) {
    const cid = t.conversationId || 'main';
    const conv = byId.get(cid);
    const row = { taskId: t.id, conversationId: cid, title: (conv && conv.title) || cid };
    const no = (why) => { row.seat = false; row.why = why; considered.push(row); };

    if (dispatched.has(t.id)) { no('a coordinator was already dispatched for this message'); continue; }
    if (t.role !== 'user') { no(`role is ${JSON.stringify(t.role)}, so this is not the human speaking`); continue; }
    if (t.from !== HUMAN_FROM) { no(`from is ${JSON.stringify(t.from)}, not the human web client`); continue; }
    if (ignore.has(cid)) { no('conversation is on the ignore list'); continue; }
    if (!conv) { no('conversation is not in the conversation list'); continue; }
    if (conv.archived) { no('conversation is archived, which IS the answer'); continue; }
    if (conv.stopAck === 'stopped') { no('conversation was deliberately stopped'); continue; }
    /*
     * SEAT-UNWATCHED: the server's own answer to "is anyone actually reading
     * this conversation's SSE stream right now", combined server-side with a
     * grace window and every other signal of life (see seatWatchInfo() /
     * evidenceOfLifeMs() in server.js). `conv.agent` being non-null no longer
     * refuses on its own — that was exactly the "FluxPrep" gap: a coordinator's
     * process exited, its name stayed on the seat, and this exact check kept
     * refusing forever because it only ever looked at the name.
     *
     * Deliberately trusting the server's verdict rather than recomputing it
     * from raw fields here: it already folds in heartbeat/lastActedAt/
     * lastProgressAt/listener-count with the right grace window, and duplicating
     * that logic client-side is how the two drift apart. This also costs
     * nothing extra to check — `agentState` already rides on the same
     * GET /conversations poll this file was already making.
     */
    const unwatched = !!(conv.agentState && conv.agentState.seatUnwatched);
    if (conv.agent && !unwatched) { no(`the seat is filled by ${conv.agent}`); continue; }

    const ageMs = now - Date.parse(t.ts);
    if (!(ageMs >= graceMs)) {
      no(`only ${Math.round(ageMs / 1000)}s old; grace is ${Math.round(graceMs / 1000)}s`);
      continue;
    }
    if (inFlight.has(cid)) { no('a dispatch for this tab is still running'); continue; }
    if (takenThisPass.has(cid)) { no('another message in this same tab was already chosen this pass'); continue; }
    if (inFlight.size + chosen.length >= maxConcurrent) { no(`at the concurrency cap of ${maxConcurrent}`); continue; }

    takenThisPass.add(cid);
    row.seat = true;
    row.staleSeat = unwatched ? conv.agent : null;
    row.why = unwatched
      ? `${conv.agent} is seated but unwatched ${conv.agentState.unwatchedForSec}s (no live SSE subscriber) `
        + `while a message waited ${Math.round(ageMs / 1000)}s`
      : `human message waiting ${Math.round(ageMs / 1000)}s in an empty seat`;
    row.ageSec = Math.round(ageMs / 1000);
    considered.push(row);
    chosen.push(row);
  }
  return { chosen, considered };
}

/*
 * Every pending human message ALREADY in the tab we are about to seat.
 *
 * All of them are recorded as dispatched, not just the one that triggered it,
 * because one coordinator answers the whole tab. Without this, a tab holding
 * three unanswered messages would be a standing order for three coordinators -
 * the in-flight guard hides it while this process lives, and a restart would
 * uncover it.
 */
function coveredBy(tasks, conversationId) {
  return tasks
    .filter((t) => (t.conversationId || 'main') === conversationId
      && t.role === 'user' && t.from === HUMAN_FROM)
    .map((t) => t.id);
}

/* A name a human can read in the tab list and match to a log file. */
function agentName(title, conversationId) {
  const slug = String(title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18)
    .replace(/-+$/, '');
  return `auto-${slug || conversationId.slice(0, 8)}-${conversationId.slice(-4)}`;
}

// ------------------------------------------------------------------ brief

function brief(o) {
  return [
    `You are the coordinator for relay tab "${o.title}", conversationId \`${o.conversationId}\`.`,
    `Relay is at ${o.queue}. Your name is \`${o.agent}\` - use it everywhere.`,
    '',
    'You were dispatched AUTOMATICALLY because a message arrived in this tab and nobody was seated in it.',
    'The human did not ask for you by hand and is not watching a terminal. The tab is your only channel.',
    '',
    'FIRST, read `D:\\projects\\relay-queue\\COORDINATOR.md`. It is the mechanical reference for this API',
    'and it documents several traps that fail silently. Then, in this order:',
    '',
    `1. Take the seat: POST /conversations/${o.conversationId} with {"agent":"${o.agent}"}.`,
    '   If that returns 409, someone else took it while you were starting - STOP and exit. Do not race.',
    '2. Post an ack into the tab straight away: POST /messages with',
    `   {"conversationId":"${o.conversationId}","agent":"${o.agent}","text":"..."}.`,
    '   A silent agent is indistinguishable from a dead one.',
    `3. GET /tasks?conversation=${o.conversationId}&status=pending and answer each one:`,
    `   claim with {"by":"${o.agent}"} - the field is \`by\`, NOT \`agent\`, and getting it wrong`,
    '   returns 200 while claiming for nobody - then do the work, then',
    `   POST /tasks/<id>/result {"result":"...","by":"${o.agent}"}, then POST /tasks/<id>/relayed.`,
    '   Post the RESULT on the task, not just a message. A message alone leaves the task open.',
    `4. Before concluding the tab is clear, also check GET /checklist?conversation=${o.conversationId}`,
    `   and GET /checklists?conversation=${o.conversationId}. A tab with no pending task can still`,
    '   have real outstanding work sitting in a checklist.',
    `5. When you are genuinely finished, RELEASE THE SEAT: POST /conversations/${o.conversationId}`,
    '   with {"agent":null}. Relay records who took a tab but never who left, so an agent that keeps',
    '   the chair after finishing makes the tab look staffed while new messages pile up behind it.',
    '',
    'Rules:',
    `- Work ONLY conversation ${o.conversationId}. Claiming a task in another conversation silently`,
    '  steals another agent message - the queue accepts one result per task.',
    '- Every message you post is read on a phone by someone with ADHD. SHORT, bulleted, bold-keyed.',
    '  Lead with the answer, never with the investigation.',
    '- PURE ASCII in any JSON body. An em-dash makes the POST fail outright.',
    '- Build bodies with a heredoc and `curl --data-binary @-`, never `-d` with a shell-quoted string.',
    '  A Windows path or an apostrophe inside a `-d` body kills the request with no output and exit 0.',
    '- Keep posting progress while you work. Work longer than ~10 minutes with no result or progress',
    '  note and relay treats you as dead. Re-claiming does not reset that clock.',
    '- Do NOT speak aloud, and do not send push notifications.',
    '- Do NOT archive, share or publish any conversation. Sharing is the decision of the human, from the UI.',
    '- If the work needs a decision only the human can make, ask ONE short question, then release the',
    '  seat and exit rather than sitting on it.',
    '- If you conclude the message needs no action, say so in the tab, close the task, release the seat.',
  ].join('\n');
}

// --------------------------------------------------------------------- io

async function getJson(base, route) {
  const r = await fetch(base + route, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${route} -> ${r.status}`);
  return r.json();
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of Object.entries(raw.dispatched || {})) {
      if (Date.parse(v && v.at) >= cutoff) out[k] = v;
    }
    return { dispatched: out };
  } catch {
    return { dispatched: {} };
  }
}

/*
 * Written with a temp file and a rename, because the failure this file guards
 * against is a crash - and a state file torn in half by the very crash it is
 * meant to survive would let every message in it dispatch a second time.
 */
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// -------------------------------------------------------------------- run

async function tick(cfg, runtime) {
  const log = runtime.log;
  let tasks; let convs;
  try {
    tasks = (await getJson(cfg.queue, '/tasks?status=pending')).tasks || [];
    convs = (await getJson(cfg.queue, '/conversations?archived=1')).conversations || [];
  } catch (e) {
    log(`queue unreachable: ${e.message}`);
    return;
  }

  const { chosen, considered } = selectSeats({
    tasks,
    conversations: convs,
    dispatched: new Set(Object.keys(runtime.state.dispatched)),
    inFlight: runtime.inFlight,
    ignore: cfg.ignore,
    now: Date.now(),
    graceMs: cfg.graceMs,
    maxConcurrent: cfg.maxConcurrent,
  });

  if (cfg.explain) {
    for (const row of considered) {
      log(`${row.seat ? 'SEAT  ' : 'skip  '}${row.title} (${row.conversationId}) task ${row.taskId}: ${row.why}`);
    }
    if (!considered.length) log('nothing pending to consider');
  }
  if (!chosen.length) {
    /*
     * Say "nothing to seat" only when that is NEWS.
     *
     * This runs every few seconds forever, so an unconditional line here is
     * ~8600 entries a day saying nothing happened, and the one line that
     * mattered is buried in them. That is the same failure this whole file is
     * built to avoid, just aimed at a log file instead of his phone: volume
     * that makes a real signal unfindable. Repeating only on CHANGE keeps the
     * log a record of events rather than of time passing.
     */
    const quiet = `nothing to seat (${considered.length} pending message(s) considered)`;
    if (!cfg.explain && quiet !== runtime.lastQuiet) { log(quiet); runtime.lastQuiet = quiet; }
    return;
  }
  runtime.lastQuiet = null;

  for (const pick of chosen) {
    /*
     * RE-READ THE SEAT. The list above is a snapshot, and the gap between
     * reading it and acting on it is exactly where a human or a router seats
     * the tab. Two agents in one tab is the worst outcome this file can
     * produce, so it is checked twice against live state rather than once.
     */
    let live;
    try {
      live = await getJson(cfg.queue, `/conversations/${pick.conversationId}`);
    } catch (e) {
      log(`SKIP ${pick.conversationId}: could not re-read the seat (${e.message})`);
      continue;
    }
    /*
     * The re-read must ask the SAME question selectSeats() did, not just
     * "is agent non-null" — otherwise every seat-unwatched pick would be
     * skipped here unconditionally, since live.agent is expected to be
     * non-null on exactly that path. Recomputed fresh from this GET rather
     * than trusted from `pick`, because a NEW occupant sitting down in the
     * gap (even one seated to genuinely watch it) immediately resets the
     * server's own clock via agentSince, so seatUnwatched already reads false
     * for them without any special-casing here.
     */
    const liveUnwatched = !!(live.agentState && live.agentState.seatUnwatched);
    if (live.agent && !liveUnwatched) { log(`SKIP ${pick.conversationId}: ${live.agent} took the seat while we were deciding`); continue; }
    if (live.archived || live.stopAck === 'stopped') { log(`SKIP ${pick.conversationId}: closed while we were deciding`); continue; }

    const agent = agentName(live.title || pick.title, pick.conversationId);
    const covered = coveredBy(tasks, pick.conversationId);

    if (cfg.dry) {
      log(`DRY-RUN would dispatch ${agent} into ${pick.title} (${pick.conversationId}), covering ${covered.length} message(s)`);
      continue;
    }

    /*
     * RECORD BEFORE SPAWNING. If this process dies between the write and the
     * spawn, the outcome is a message nobody was sent to answer - which the
     * watchdog already alarms on. If it were the other way round, the outcome
     * would be a message that dispatches a coordinator on every restart,
     * forever. The first failure is visible and bounded; the second is the
     * backlog this system has already drowned in once.
     */
    const at = new Date().toISOString();
    for (const id of covered) {
      runtime.state.dispatched[id] = { at, conversationId: pick.conversationId, agent };
    }
    saveState(cfg.stateFile, runtime.state);

    fs.mkdirSync(cfg.logDir, { recursive: true });
    const logFile = path.join(cfg.logDir, `${agent}-${at.replace(/[:.]/g, '-')}.log`);
    const fd = fs.openSync(logFile, 'a');

    const args = ['-p', brief({ ...pick, title: live.title || pick.title, agent, queue: cfg.queue })];
    if (cfg.model) args.push('--model', cfg.model);

    let child;
    try {
      child = spawn(cfg.claude, args, { cwd: cfg.cwd, stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (e) {
      fs.closeSync(fd);
      log(`DISPATCH FAILED ${agent} -> ${pick.conversationId}: ${e.message}`);
      continue;
    }

    runtime.inFlight.add(pick.conversationId);
    log(`DISPATCH ${agent} -> ${pick.title} (${pick.conversationId}) covering ${covered.length} message(s), log ${path.basename(logFile)}`);

    child.on('exit', (code) => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      runtime.inFlight.delete(pick.conversationId);
      log(`FINISHED ${agent} exit=${code} (${pick.conversationId})`);
    });
    child.on('error', (e) => {
      runtime.inFlight.delete(pick.conversationId);
      log(`DISPATCH ERROR ${agent}: ${e.message}`);
    });
  }
}

function parseArgs(argv) {
  const cfg = {
    queue: DEFAULT_QUEUE,
    intervalMs: 10000,
    graceMs: 20000,
    maxConcurrent: 3,
    stateFile: DEFAULT_STATE,
    logDir: path.join(path.dirname(DEFAULT_STATE), 'logs'),
    claude: process.env.AUTOSEAT_CLAUDE || path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    cwd: 'D:\\projects',
    model: '',
    ignore: new Set(),
    once: false,
    dry: false,
    explain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--queue') cfg.queue = next();
    else if (a === '--interval') cfg.intervalMs = Number(next()) * 1000;
    else if (a === '--grace') cfg.graceMs = Number(next()) * 1000;
    else if (a === '--max-concurrent') cfg.maxConcurrent = Number(next());
    else if (a === '--state') cfg.stateFile = next();
    else if (a === '--log-dir') cfg.logDir = next();
    else if (a === '--claude') cfg.claude = next();
    else if (a === '--cwd') cfg.cwd = next();
    else if (a === '--model') cfg.model = next();
    else if (a === '--ignore') String(next()).split(',').forEach((x) => x && cfg.ignore.add(x.trim()));
    else if (a === '--once') cfg.once = true;
    else if (a === '--dry') cfg.dry = true;
    else if (a === '--explain') cfg.explain = true;
    else if (a === '--help' || a === '-h') cfg.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return cfg;
}

const USAGE = `autoseat - dispatch a coordinator into a tab that has a human message and no agent.

  node tools/autoseat.js [--once] [--dry] [--explain]

  --queue URL          relay base (default ${DEFAULT_QUEUE})
  --interval SEC       seconds between polls (default 10)
  --grace SEC          seconds a message must wait before seating (default 20)
  --max-concurrent N   most coordinators dispatched at once (default 3)
  --state FILE         dispatch memory (default ${DEFAULT_STATE})
  --log-dir DIR        per-dispatch child logs
  --claude PATH        the claude executable
  --cwd DIR            working directory for the coordinator (default D:\\projects)
  --model NAME         model for the coordinator (default: whatever claude is configured with)
  --ignore A,B         conversation ids never to seat
  --once               run a single pass and exit
  --dry                decide, log, spawn nothing
  --explain            print every message considered and why it was or was not seated
`;

async function main() {
  let cfg;
  try { cfg = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (cfg.help) { console.log(USAGE); return; }

  const log = (m) => console.log(`${stamp()}  ${m}`);
  const runtime = { state: loadState(cfg.stateFile), inFlight: new Set(), log };

  log(`autoseat watching ${cfg.queue} every ${cfg.intervalMs / 1000}s; grace ${cfg.graceMs / 1000}s, `
    + `cap ${cfg.maxConcurrent}, ${Object.keys(runtime.state.dispatched).length} message(s) already dispatched`
    + (cfg.dry ? ' [DRY-RUN]' : ''));

  /*
   * Nothing a single tick can throw is worth taking the watcher down for. An
   * unhandled rejection here would end the process, and a dispatcher that
   * exits on one bad poll is a dispatcher that is not running the next time it
   * is needed - the exact failure mode of the router it replaces.
   */
  const safeTick = () => tick(cfg, runtime).catch((e) => log(`tick failed: ${e.message}`));
  await safeTick();
  if (cfg.once) return; /* a spawned child keeps running; we just stop deciding */
  setInterval(safeTick, cfg.intervalMs);
}

module.exports = { selectSeats, coveredBy, agentName, brief, HUMAN_FROM };

if (require.main === module) main();
