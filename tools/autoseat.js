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
 *     `role === 'user' && HUMAN_ORIGINS.has(from)`, which is structural rather
 *     than a heuristic: agent posts carry `role: 'agent'`, the watchdog's own
 *     pokes carry `from: 'relay-watchdog'`, and checklist settles carry
 *     `from: 'checklist'`. None of those are in the allowlist, so none of them
 *     can dispatch. This is what stops the obvious infinite loop, where a
 *     dispatched agent's own writes look like new work and dispatch another.
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

/*
 * PROOF OF LIFE, written every completed poll.
 *
 * The supervisor (tools/autoseat-start.ps1) used to decide "is autoseat up?"
 * by asking whether a node.exe with autoseat.js in its command line exists.
 * That check cannot fail for a process that is running but no longer working,
 * which is the failure it most needs to catch.
 *
 * Nothing else here could stand in for it, which is the point:
 *
 *   - THE LOG CANNOT. `nothing to seat` is deliberately printed only when the
 *     text CHANGES (see the note at the quiet branch below), so a healthy
 *     autoseat with a steady queue writes nothing for hours by design. On
 *     2026-08-29 that produced a 16.7-hour silence that was investigated as a
 *     hang and was not one - the process was polling correctly the whole time,
 *     and settling that took TCP-socket forensics because no artifact on disk
 *     could tell "idle and fine" from "wedged". Log silence is not evidence.
 *
 *   - state.json CANNOT. It is written only when a coordinator is dispatched,
 *     so it is untouched for days at a time during normal operation.
 *
 * So the heartbeat is a separate file that means one specific thing: a poll
 * ran to completion this recently. It is deliberately NOT written at the top
 * of a tick. setInterval keeps firing even while an earlier tick is stuck
 * awaiting a hung fetch, so a heartbeat stamped on entry would keep reading
 * fresh while no poll ever finished - a green light for the exact fault it is
 * meant to expose. It is written when a tick RESOLVES, so a wedged fetch
 * starves it and the supervisor sees the staleness.
 */
const DEFAULT_HEARTBEAT = path.join(os.homedir(), '.relay-autoseat', 'heartbeat.json');

/*
 * The human's own clients - the surfaces HE posts from, and nothing else.
 *
 * THIS IS AN ALLOWLIST ON PURPOSE. KEEP IT ONE. The loop-safety property of
 * this whole file rests on it: a dispatched coordinator, the watchdog, and a
 * checklist settle cannot name themselves onto a list they are not on, so a
 * dispatch feeding on agent writes is impossible rather than merely unlikely.
 * A blocklist ("anything that is not a known agent") or a heuristic would
 * invert that - the default would become "dispatch", and every posting surface
 * nobody remembered to exclude would become a loop. server.js makes exactly
 * this argument about PAGE_ORIGINS, and records a surface slipping through it
 * once already.
 *
 * It was a single string, `'web'`, and that was a bug with teeth: he talks to
 * relay by VOICE at least as often as by keyboard, and those posts arrive as
 * `voice` (dictation through the ordinary send path) and `voice-conversation`
 * (the two-way voice mode). Neither matched, so an empty tab holding a spoken
 * message was a silent black hole - no coordinator, no error, and nothing to
 * alarm on, because refusing on `from` is not a failure. One of his messages
 * sat unanswered for 23 minutes that way.
 *
 * Adding them costs nothing structurally, because they are human-origin: no
 * agent emits them. `checklist` is deliberately absent even though it is a page
 * origin too - a ticked box is not an instruction, and the server's own
 * PAGE_ORIGINS set is therefore NOT the right list to borrow here.
 *
 * ADDING A UI SURFACE HE CAN SPEAK OR TYPE FROM? ADD IT IN ../staffability.js,
 * IN THE SAME COMMIT. The failure is silent in the safe direction: he gets
 * ignored.
 *
 * DEFINED ONCE, IN ../staffability.js, AND REQUIRED BY server.js TOO. Both
 * processes have to answer "would autoseat ever seat this?" - autoseat to
 * decide, the server to EXPLAIN a backlog on GET /tasks and /health - and a
 * second copy of this set is a copy that can drift. Drift here is not cosmetic:
 * the set is what makes agent-seats-agent loops impossible rather than merely
 * unlikely, and a structural guard that exists in two versions is no longer
 * structural. The refusal wording is single-sourced with it, for the same
 * reason - the server quotes these sentences verbatim.
 */
const { HUMAN_ORIGINS, REASON } = require('../staffability');

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
    if (t.role !== 'user') { no(REASON.notUserRole(t)); continue; }
    if (!HUMAN_ORIGINS.has(t.from)) { no(REASON.notHumanOrigin(t)); continue; }
    if (ignore.has(cid)) { no('conversation is on the ignore list'); continue; }
    if (!conv) { no(REASON.noConversation()); continue; }
    if (conv.archived) { no(REASON.archived()); continue; }
    if (conv.stopAck === 'stopped') { no(REASON.stopped()); continue; }
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
      && t.role === 'user' && HUMAN_ORIGINS.has(t.from))
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
    'FIRST, read `/home/hypnodroid/Projects/relay-queue/COORDINATOR.md`. It is the mechanical reference for this API',
    'and it documents several traps that fail silently. Then, in this order:',
    '',
    `1. Take the seat: POST /conversations/${o.conversationId} with {"agent":"${o.agent}"}.`,
    '   If that returns 409, someone else took it while you were starting - STOP and exit. Do not race.',
    '2. Post an ack into the tab straight away: POST /messages with',
    `   {"conversationId":"${o.conversationId}","agent":"${o.agent}","text":"..."}.`,
    '   A silent agent is indistinguishable from a dead one.',
    `3. GET /tasks?conversation=${o.conversationId}&status=pending and answer each one:`,
    `   claim with {"by":"${o.agent}"} - \`by\` is the canonical field, though \`agent\`,`,
    '   `author` and `claimedBy` are accepted aliases now and record the same holder - then do the work, then',
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

/*
 * EVERY POLL IS BOUNDED. `fetch` has no default overall timeout - undici's
 * headers/body timeouts are 300s each, so a relay that accepts a connection
 * and then goes quiet parks a tick for five minutes, and a proxy or a
 * half-open socket can park it far longer. setInterval keeps firing behind it,
 * so the visible symptom is not an error but an autoseat that is alive,
 * responding, and quietly doing nothing.
 *
 * 8s is chosen against the observed workload, not by feel: both routes are
 * local (127.0.0.1) reads that normally answer in single-digit milliseconds,
 * so 8s is ~1000x the expected cost - it cannot fire on a slow-but-working
 * relay, and it converts an indefinite hang into an ordinary handled error
 * that the next tick retries 10s later.
 *
 * This is belt AND braces with the heartbeat, deliberately. The timeout stops
 * the most likely hang from happening; the heartbeat catches the hangs nobody
 * predicted. Neither replaces the other - a timeout only bounds the waits it
 * was wrapped around, and the failure worth guarding is the one not thought of.
 */
const FETCH_TIMEOUT_MS = 8000;

async function getJson(base, route) {
  const r = await fetch(base + route, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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

/*
 * Same tmp-and-rename as saveState, for the same reason: the supervisor reads
 * this file on a timer, and a half-written one would parse as "no heartbeat",
 * which is the restart signal. A torn read must never be able to order a kill.
 *
 * The pid is part of the record, not decoration. Without it a `--once` run
 * (mine, a selftest's, anyone debugging by hand) would refresh the file and
 * vouch for a daemon that had actually died - so the supervisor cross-checks
 * that the heartbeat was written by a process that is still alive. `--once`
 * does not write one at all, which closes the same hole from the other side.
 */
function writeHeartbeat(file, outcome) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid,
      ts: new Date().toISOString(),
      outcome: outcome || 'ok',
    }, null, 1));
    fs.renameSync(tmp, file);
  } catch {
    /* A heartbeat that cannot be written must not take the dispatcher down
     * with it. The supervisor will read it as stale and restart, which is a
     * survivable outcome; throwing here would turn a full disk into a dead
     * dispatcher, which is not. */
  }
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
    /*
     * This still counts as a completed poll. autoseat asked, got a definite
     * answer, and reported it - the loop is turning and the code is working.
     * Withholding the heartbeat here would make a relay outage look like an
     * autoseat wedge and restart this process every 5 minutes for as long as
     * relay stayed down, which cannot fix relay and would destroy the run
     * history that a relay outage most needs. The outcome is recorded so the
     * distinction is legible in the file itself.
     */
    runtime.lastOutcome = `queue unreachable: ${e.message}`;
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
    runtime.lastOutcome = `idle, ${considered.length} considered`;
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
  runtime.lastOutcome = `seated ${chosen.length}`;
}

function parseArgs(argv) {
  const cfg = {
    queue: DEFAULT_QUEUE,
    intervalMs: 10000,
    graceMs: 20000,
    maxConcurrent: 3,
    stateFile: DEFAULT_STATE,
    heartbeatFile: DEFAULT_HEARTBEAT,
    logDir: path.join(path.dirname(DEFAULT_STATE), 'logs'),
    claude: process.env.AUTOSEAT_CLAUDE || path.join(os.homedir(), '.local', 'bin', 'claude'),
    // SECURITY-COUPLED, do not "tidy" this to some other checkout.
    // Claude Code discovers .claude/skills/ and loads .claude/settings.json
    // ONLY for the directory the session is rooted in. The coordinator
    // protocol (skills/relay-coordinator) and the default-deny PreToolUse
    // guard (hooks/coordinator-guard.js) both live in
    // /home/hypnodroid/Projects/relay-queue/.claude. Point this anywhere else
    // and the coordinator boots with no protocol AND no guard, silently:
    // nothing errors, and default-deny quietly becomes default-allow.
    //
    // 2026-09-01: moved off D:\projects\relay-queue with the container's code
    // mount. The cwd, the skill and the guard have to travel together - the D:
    // tree's .claude/settings.json carries WINDOWS hook paths, so rooting a WSL
    // session there would load a guard command that cannot execute, which is
    // the default-allow case above rather than an error anyone would see.
    cwd: '/home/hypnodroid/Projects/relay-queue',
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
    else if (a === '--heartbeat') cfg.heartbeatFile = next();
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
  --heartbeat FILE     proof-of-life for the supervisor (default ${DEFAULT_HEARTBEAT})
  --log-dir DIR        per-dispatch child logs
  --claude PATH        the claude executable
  --cwd DIR            working directory for the coordinator (default /home/hypnodroid/Projects/relay-queue;
                       this is where the coordinator skill and the guard are found - see the note in parseArgs)
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
  const runtime = { state: loadState(cfg.stateFile), inFlight: new Set(), log, lastOutcome: 'starting' };

  log(`autoseat watching ${cfg.queue} every ${cfg.intervalMs / 1000}s; grace ${cfg.graceMs / 1000}s, `
    + `cap ${cfg.maxConcurrent}, ${Object.keys(runtime.state.dispatched).length} message(s) already dispatched`
    + (cfg.dry ? ' [DRY-RUN]' : ''));

  /*
   * Nothing a single tick can throw is worth taking the watcher down for. An
   * unhandled rejection here would end the process, and a dispatcher that
   * exits on one bad poll is a dispatcher that is not running the next time it
   * is needed - the exact failure mode of the router it replaces.
   */
  /*
   * A tick that THREW deliberately does not beat. The catch keeps the watcher
   * alive (see above), but an unexpected fault every poll is not a working
   * dispatcher, and letting the heartbeat go stale hands the supervisor the
   * one remedy that might clear it: a fresh process. Only a tick that RAN TO
   * COMPLETION - seated, idle, or cleanly reporting relay unreachable - is
   * allowed to vouch for this process.
   */
  const beat = () => { if (!cfg.once) writeHeartbeat(cfg.heartbeatFile, runtime.lastOutcome); };
  const safeTick = () => tick(cfg, runtime).then(beat, (e) => log(`tick failed: ${e.message}`));

  /* Stamp one before the first poll, so a just-started autoseat is never
   * mistaken for a wedged one during the seconds its first tick takes. */
  beat();

  await safeTick();
  if (cfg.once) return; /* a spawned child keeps running; we just stop deciding */
  setInterval(safeTick, cfg.intervalMs);
}

// parseArgs is exported for autoseat-selftest.js, which asserts that the
// DEFAULT cwd is a directory actually containing the coordinator skill and the
// guard registration. That coupling has no runtime symptom when broken, so it
// needs a test rather than a comment.
module.exports = { selectSeats, coveredBy, agentName, brief, writeHeartbeat, parseArgs, HUMAN_ORIGINS };

if (require.main === module) main();
