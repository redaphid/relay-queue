#!/usr/bin/env node
'use strict';
/*
 * autoseat-selftest - prove the seating decision, and prove it can refuse.
 *
 * This suite is mostly made of things that MUST NOT be seated, because the
 * dangerous failures of an auto-dispatcher are all false positives: two agents
 * in one tab, a coordinator spawned into a thread that was closed on purpose,
 * or a dispatch loop feeding on the dispatched agent's own writes.
 *
 * A green suite full of refusals is worthless on its own - "refused everything"
 * and "looked at nothing" are the same output. So the second half of this file
 * MUTATES the selector, one guard at a time, and asserts the suite goes RED.
 * A guard whose removal changes nothing was never being tested.
 *
 * The mutation is applied to the source IN MEMORY and compiled with `vm`,
 * deliberately. Mutating on disk with `sed -i` or `perl -0pi` silently matches
 * nothing against this box's CRLF files and exits 0, which reports every
 * mutation as "survived" - a green light produced by a no-op. Here the
 * replacement count is asserted to be exactly 1 before the mutant is run, so a
 * mutation that failed to apply is an error, not a pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SRC = path.join(__dirname, 'autoseat.js');
const real = require('./autoseat.js');

const NOW = Date.parse('2026-08-27T23:30:00.000Z');
const GRACE_MS = 20000;
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

// ------------------------------------------------------------- fixtures

/*
 * Every control gets its OWN empty conversation. Sharing one would let the
 * "already chose this tab" guard refuse them, and then a mutation that removes
 * the guard actually under test would not change the result - the test would
 * pass for the wrong reason and go on passing after the code broke.
 */
const conversations = [
  { id: 'c-seat', title: 'Seat me', agent: null, archived: false, stopAck: null },
  { id: 'c-voice', title: 'Dictated', agent: null, archived: false, stopAck: null },
  { id: 'c-voiceconv', title: 'Spoken', agent: null, archived: false, stopAck: null },
  { id: 'c-staffed', title: 'Staffed', agent: 'live-coord', archived: false, stopAck: null },
  /*
   * Occupied by a name, but the server itself says nobody is listening
   * (SEAT_UNWATCHED_MS elapsed with zero SSE subscribers - see seatWatchInfo()
   * in server.js). This is the "FluxPrep" shape: a coordinator's process
   * exited, `agent` never changed, and only agentState.seatUnwatched can tell
   * the two apart from `conv.agent` alone.
   */
  { id: 'c-unwatched', title: 'Staffed but unwatched', agent: 'DeadCoord', archived: false, stopAck: null,
    agentState: { seatUnwatched: true, unwatchedForSec: 300, listeners: 0 } },
  { id: 'c-archived', title: 'Archived', agent: null, archived: true, stopAck: null },
  { id: 'c-stopped', title: 'Stopped', agent: null, archived: false, stopAck: 'stopped' },
  { id: 'c-ignored', title: 'Ignored', agent: null, archived: false, stopAck: null },
  { id: 'c-agentmsg', title: 'Agent chatter', agent: null, archived: false, stopAck: null },
  { id: 'c-watchdog', title: 'Watchdog poke', agent: null, archived: false, stopAck: null },
  { id: 'c-checklist', title: 'Checklist tick', agent: null, archived: false, stopAck: null },
  { id: 'c-fresh', title: 'Just arrived', agent: null, archived: false, stopAck: null },
  { id: 'c-already', title: 'Already dispatched', agent: null, archived: false, stopAck: null },
  { id: 'c-inflight', title: 'Dispatch running', agent: null, archived: false, stopAck: null },
  { id: 'c-two', title: 'Two messages', agent: null, archived: false, stopAck: null },
];

const tasks = [
  { id: 't-seat', conversationId: 'c-seat', role: 'user', from: 'web', ts: ago(120) },
  /*
   * The same message as t-seat in every way that should matter - a thing he
   * said, in a tab with nobody in it - except that he said it out loud.
   * `voice` is dictation sent through the ordinary send path; from the
   * two-way voice mode it arrives as `voice-conversation`. While the trigger
   * tested `from === 'web'` these were a silent black hole: refusing on `from`
   * is not an error, so nothing alarmed and nobody could tell from outside
   * that a spoken message had been dropped. One of his sat 23 minutes.
   */
  { id: 't-voice', conversationId: 'c-voice', role: 'user', from: 'voice', ts: ago(120) },
  { id: 't-voiceconv', conversationId: 'c-voiceconv', role: 'user', from: 'voice-conversation', ts: ago(120) },
  { id: 't-staffed', conversationId: 'c-staffed', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-unwatched', conversationId: 'c-unwatched', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-archived', conversationId: 'c-archived', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-stopped', conversationId: 'c-stopped', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-ignored', conversationId: 'c-ignored', role: 'user', from: 'web', ts: ago(120) },
  // The dispatched agent's own post. Seating on this is the infinite loop.
  { id: 't-agentmsg', conversationId: 'c-agentmsg', role: 'agent', from: 'web', ts: ago(120) },
  // The watchdog nagging about the very tab we would be dispatching into.
  { id: 't-watchdog', conversationId: 'c-watchdog', role: 'user', from: 'relay-watchdog', ts: ago(120) },
  { id: 't-checklist', conversationId: 'c-checklist', role: 'user', from: 'checklist', ts: ago(120) },
  { id: 't-fresh', conversationId: 'c-fresh', role: 'user', from: 'web', ts: ago(5) },
  { id: 't-already', conversationId: 'c-already', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-inflight', conversationId: 'c-inflight', role: 'user', from: 'web', ts: ago(120) },
  { id: 't-two-a', conversationId: 'c-two', role: 'user', from: 'web', ts: ago(300) },
  { id: 't-two-b', conversationId: 'c-two', role: 'user', from: 'web', ts: ago(60) },
];

/*
 * A coordinator process that is alive but not ours to feed: a survivor of an
 * earlier autoseat, finishing its last turn. This replaced the in-memory
 * `inFlight` Set, which was lost on every restart - and a restart is exactly
 * when the Sporefall tab got a second coordinator on 2026-09-17.
 */
const STILL_RUNNING = new Map([['c-inflight', { agent: 'auto-inflight', pid: 4242, attached: false, busy: true, closing: null }]]);

/*
 * The default cap here is deliberately ROOMY - larger than the number of tabs
 * these fixtures can possibly seat. The cap has its own tests further down with
 * an explicit `maxConcurrent`; letting it also bite in the general run would
 * mean "refused because of its `from`" and "refused because of the cap" produce
 * the same not-seated result, and a regression in the human-origin allowlist
 * could hide behind the cap. That is not hypothetical - see the `roomy` run in
 * check(), which exists because the one-agent-per-tab guard was already once
 * passing on the cap's work.
 */
function run(mod, over) {
  return mod.selectSeats({
    tasks,
    conversations,
    dispatched: new Set(['t-already']),
    coordinators: STILL_RUNNING,
    ignore: new Set(['c-ignored']),
    now: NOW,
    graceMs: GRACE_MS,
    maxConcurrent: 9,
    ...over,
  });
}

// ------------------------------------------------------------ assertions

/*
 * Returns a list of failure strings rather than throwing, so the same suite can
 * be run against a mutant and asked "did this go red?" instead of crashing the
 * harness on the first difference.
 */
function check(mod) {
  const fail = [];
  const ok = (cond, msg) => { if (!cond) fail.push(msg); };

  const { chosen, considered } = run(mod);
  const seated = chosen.map((c) => c.taskId).sort();
  const why = Object.fromEntries(considered.map((r) => [r.taskId, r.why]));
  const refused = (id) => considered.some((r) => r.taskId === id && r.seat === false);

  // The positive control. Without this, every guard could simply refuse
  // everything and the suite would still be green.
  ok(seated.includes('t-seat'), 'an empty seat with a human message waiting was NOT seated');

  /*
   * He speaks to relay at least as often as he types at it, so these are
   * positive controls of exactly the same weight as the one above - not
   * variants of it. The allowlist is what makes them pass, and the two
   * allowlist mutations at the bottom of this file are what prove that.
   */
  ok(seated.includes('t-voice'),
    'a DICTATED message (from:"voice") in an empty seat was NOT seated');
  ok(seated.includes('t-voiceconv'),
    'a message from two-way voice mode (from:"voice-conversation") in an empty seat was NOT seated');

  /*
   * THE FLUXPREP CASE. A seat with a name on it, but the server itself says
   * nobody is subscribed to its SSE stream (agentState.seatUnwatched, folded
   * in with a grace window and every other liveness signal server-side - see
   * seatWatchInfo() in server.js). `conv.agent` being non-null must no longer
   * be an unconditional refusal, or this exact incident recurs: a coordinator
   * exits, its name never leaves the seat, and nothing ever answers the human
   * again.
   */
  ok(seated.includes('t-unwatched'),
    'a seat occupied by a name but flagged agentState.seatUnwatched was NOT rescued - this is the FluxPrep gap');
  ok(/DeadCoord/.test(why['t-unwatched'] || '') && /unwatched/.test(why['t-unwatched'] || ''),
    `the reason for seating t-unwatched should name the stale coordinator and say why it was rescued: ${why['t-unwatched']}`);
  // The negative control alongside it in the SAME run: a genuinely staffed
  // seat (no agentState.seatUnwatched at all) must still be refused.
  ok(refused('t-staffed'), 'a genuinely staffed seat was seated - it must be refused on its own merits');

  // Exactly one coordinator for the tab holding two messages, and it is the
  // older one - the oldest message is what the human is waiting on.
  ok(chosen.filter((c) => c.conversationId === 'c-two').length === 1,
    'a tab with two waiting messages was seated more than once');
  ok(seated.includes('t-two-a'), 'the OLDER of two waiting messages was not the one that seated');

  // t-seat, t-voice, t-voiceconv, t-unwatched, and the older of the pair in
  // c-two. Anything else getting through is a guard that stopped guarding.
  ok(seated.length === 5, `expected exactly 5 dispatches, got ${seated.length}: ${seated.join(',')}`);

  /*
   * The same one-per-tab rule again, but with the cap raised out of the way.
   * Mutation testing caught this: with the default cap of 3, removing the
   * one-per-tab guard changed nothing, because the SECOND message in that tab
   * was refused for hitting the cap instead. The guard was passing on the
   * strength of a different guard's work.
   */
  const roomy = run(mod, { maxConcurrent: 99, coordinators: new Map() });
  ok(roomy.chosen.filter((c) => c.conversationId === 'c-two').length === 1,
    'with no cap in the way, a tab with two waiting messages was seated twice');
  ok(/already chosen this pass/.test((roomy.considered.find((r) => r.taskId === 't-two-b') || {}).why || ''),
    'the second message in a tab was not refused for that tab already being seated');

  // The refusals, each with the reason it was refused for. Asserting the reason
  // and not just the refusal is what stops one guard silently covering for
  // another when the other is removed.
  ok(refused('t-staffed') && /seat is filled by live-coord/.test(why['t-staffed']),
    'a tab with a live agent was seated, or refused for the wrong reason');
  ok(refused('t-archived') && /archived/.test(why['t-archived']),
    'an archived tab was seated, or refused for the wrong reason');
  ok(refused('t-stopped') && /stopped/.test(why['t-stopped']),
    'a deliberately stopped tab was seated, or refused for the wrong reason');
  ok(refused('t-ignored') && /ignore list/.test(why['t-ignored']),
    'an ignored tab was seated, or refused for the wrong reason');
  ok(refused('t-agentmsg') && /not the human speaking/.test(why['t-agentmsg']),
    'an AGENT post triggered a dispatch - this is the infinite loop');
  /*
   * The two machine origins that wear `role: "user"`. Widening the human
   * allowlist to be "helpful" is the one edit that would let these through, so
   * the reason is asserted too: they must be refused BY THE ALLOWLIST, not
   * incidentally by some other guard that a later change could remove.
   */
  ok(refused('t-watchdog') && /not a human client/.test(why['t-watchdog']),
    'a watchdog poke triggered a dispatch - this is the nag amplifier');
  ok(refused('t-checklist') && /not a human client/.test(why['t-checklist']),
    'a checklist settle triggered a dispatch');
  ok(refused('t-fresh') && /grace/.test(why['t-fresh']),
    'a message inside the grace window was seated');
  ok(refused('t-already') && /already dispatched/.test(why['t-already']),
    'a message that already had a coordinator was dispatched a second time');
  ok(refused('t-inflight') && /still holds this tab/.test(why['t-inflight']),
    'a tab with a dispatch already running was seated again');

  // Every pending message is accounted for. A selector that silently drops
  // rows can hide a whole class of input from review.
  ok(considered.length === tasks.length,
    `considered ${considered.length} of ${tasks.length} pending messages`);

  // The cap, measured with nothing already in flight so it is the cap being
  // tested and not the in-flight guard.
  const capped = run(mod, { maxConcurrent: 1, coordinators: new Map() });
  ok(capped.chosen.length === 1, `cap of 1 let ${capped.chosen.length} through`);
  ok(capped.chosen[0] && capped.chosen[0].taskId === 't-two-a',
    'under a cap of 1 the oldest waiting message was not the one that got the coordinator');
  ok(/concurrency cap/.test((capped.considered.find((r) => r.taskId === 't-seat') || {}).why || ''),
    'a second eligible tab under a cap of 1 was not refused for being at the cap');

  // In-flight counts against the cap, not just against its own tab: an agent
  // still starting up is an agent. A cap that only counted THIS pass would
  // spawn the cap afresh every tick.
  ok(run(mod, { maxConcurrent: 1, coordinators: STILL_RUNNING }).chosen.length === 0,
    'the cap ignored a dispatch that was already in flight');

  // One coordinator answers the whole tab, so both of its messages must be
  // recorded as covered - otherwise a restart dispatches a second one.
  const covered = mod.coveredBy(tasks, 'c-two').sort();
  ok(covered.length === 2 && covered[0] === 't-two-a' && covered[1] === 't-two-b',
    `coveredBy returned ${JSON.stringify(covered)} for a tab with two human messages`);
  ok(!mod.coveredBy(tasks, 'c-agentmsg').length,
    'coveredBy counted an agent post as a human message');

  /*
   * coveredBy has to agree with the selector about what "human" means, and it
   * is a separate expression, so it can drift. If it counted only `web` while
   * the selector seated `voice`, the spoken message would never be recorded as
   * dispatched and the next restart would send a SECOND coordinator into that
   * tab - the exact backlog shape this file exists to make impossible.
   */
  ok(mod.coveredBy(tasks, 'c-voice').join() === 't-voice',
    'coveredBy did not count a dictated message as the human speaking, so a restart would re-dispatch it');
  ok(mod.coveredBy(tasks, 'c-voiceconv').join() === 't-voiceconv',
    'coveredBy did not count a two-way-voice message as the human speaking');
  ok(!mod.coveredBy(tasks, 'c-watchdog').length && !mod.coveredBy(tasks, 'c-checklist').length,
    'coveredBy counted a watchdog poke or a checklist settle as a human message');

  lifecycle(mod, ok);
  return fail;
}

/*
 * THE LONG-LIVED COORDINATOR DECISIONS, as pure fixtures, so the mutation pass
 * below covers them too. Each gets its own tabs for the same reason the
 * fixtures above do: a shared tab lets one guard pass on another's work.
 */
function lifecycle(mod, ok) {
  const t = (id, cid, sec, from) => ({ id, conversationId: cid, role: 'user', from: from || 'web', ts: ago(sec) });
  const conv = (id, agent, extra) => ({ id, title: id, agent: agent || null, archived: false, stopAck: null, ...extra });
  const pick = (res, id) => res.considered.find((r) => r.taskId === id) || {};

  // A LIVE, IDLE coordinator of ours: the message is its next turn - even
  // inside the grace window, and never a second seat.
  const live = new Map([['L', { agent: 'auto-l', pid: 11, attached: true, busy: false, closing: null, lastActiveAt: 5 }]]);
  let r = mod.selectSeats({
    tasks: [t('l1', 'L', 2), t('l2', 'L', 1)], conversations: [conv('L', 'auto-l')],
    coordinators: live, now: NOW, graceMs: GRACE_MS, maxConcurrent: 1,
  });
  ok(r.deliveries.length === 2 && !r.chosen.length,
    `a message for a live idle coordinator was not delivered as a turn (deliveries ${r.deliveries.length}, seats ${r.chosen.length})`);

  // The same coordinator MID-TURN: nothing is written into a running turn.
  const busy = new Map([['L', { agent: 'auto-l', pid: 11, attached: true, busy: true, closing: null }]]);
  r = mod.selectSeats({
    tasks: [t('l1', 'L', 60)], conversations: [conv('L', 'auto-l')],
    coordinators: busy, now: NOW, graceMs: GRACE_MS, maxConcurrent: 9,
  });
  ok(!r.deliveries.length && !r.chosen.length && pick(r, 'l1').code === 'busy',
    'a message was delivered into, or seated beside, a coordinator that is mid-turn');

  // OUR OWN DEAD COORDINATOR'S NAME ON THE SEAT: reseat it at once, as a
  // resume of its remembered session - no 2-minute seatUnwatched wait.
  r = mod.selectSeats({
    tasks: [t('o1', 'O', 60)], conversations: [conv('O', 'auto-o')],
    records: { O: { agent: 'auto-o', sessionId: 'sess-o' } }, now: NOW, graceMs: GRACE_MS, maxConcurrent: 9,
  });
  ok(r.chosen.length === 1 && r.chosen[0].resumeSessionId === 'sess-o',
    'a seat held only by the name of our own dead coordinator was not reseated as a resume');
  // ...but a stranger's name on the seat is still an occupant.
  r = mod.selectSeats({
    tasks: [t('o1', 'O', 60)], conversations: [conv('O', 'someone-else')],
    records: { O: { agent: 'auto-o', sessionId: 'sess-o' } }, now: NOW, graceMs: GRACE_MS, maxConcurrent: 9,
  });
  ok(!r.chosen.length, 'a seat held by somebody else was taken because we once had a coordinator in that tab');

  // EVICTION AT THE CAP: the least recently active IDLE one goes.
  const two = new Map([
    ['A', { agent: 'auto-a', pid: 1, attached: true, busy: false, closing: null, lastActiveAt: 200 }],
    ['B', { agent: 'auto-b', pid: 2, attached: true, busy: false, closing: null, lastActiveAt: 100 }],
  ]);
  r = mod.selectSeats({
    tasks: [t('n1', 'N', 60)], conversations: [conv('N'), conv('A', 'auto-a'), conv('B', 'auto-b')],
    coordinators: two, now: NOW, graceMs: GRACE_MS, maxConcurrent: 2,
  });
  ok(r.chosen.length === 1 && r.chosen[0].evict === 'B',
    `at the cap, the least recently active idle coordinator was not the one evicted (evict=${r.chosen[0] && r.chosen[0].evict})`);
  // ...and never one mid-turn: all slots busy means wait.
  const allBusy = new Map([...two].map(([k, v]) => [k, { ...v, busy: true }]));
  r = mod.selectSeats({
    tasks: [t('n1', 'N', 60)], conversations: [conv('N'), conv('A', 'auto-a'), conv('B', 'auto-b')],
    coordinators: allBusy, now: NOW, graceMs: GRACE_MS, maxConcurrent: 2,
  });
  ok(!r.chosen.length && pick(r, 'n1').code === 'cap',
    'at the cap with every coordinator mid-turn, one was evicted anyway - that kills an answer in progress');

  // A delivery is still bound by the human allowlist: agent/watchdog frames
  // in a live tab must never become turns.
  r = mod.selectSeats({
    tasks: [t('w1', 'L', 60, 'relay-watchdog'), { ...t('a1', 'L', 60), role: 'agent' }],
    conversations: [conv('L', 'auto-l')], coordinators: live, now: NOW, graceMs: GRACE_MS, maxConcurrent: 9,
  });
  ok(!r.deliveries.length, 'a watchdog poke or an agent post in a live tab was delivered as a turn - that is the loop');
}

// ------------------------------------------------------------- mutations

function loadMutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8');
  const hits = src.split(find).length - 1;
  /*
   * The check that makes this honest. A mutation that matched nothing would run
   * the ORIGINAL code, the suite would pass, and the report would read
   * "survived" - indistinguishable from a genuinely untested guard.
   */
  if (hits !== 1) throw new Error(`mutation target ${JSON.stringify(find)} matched ${hits} times, expected exactly 1`);
  const m = new Module(SRC, null);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(src.split(find).join(replace), SRC);
  return m.exports;
}

const MUTATIONS = [
  ['the human-vs-agent test', "if (t.role !== 'user')", 'if (false)'],
  ['the human-client test', 'if (!HUMAN_ORIGINS.has(t.from))', 'if (false)'],
  ['the occupied-seat test', 'if (conv.agent && !unwatched && !ownDeadSeat)', 'if (false)'],
  /*
   * THE FLUXPREP REGRESSION, REPRODUCED ON PURPOSE. Reverting to the OLD,
   * pre-fix guard (`if (conv.agent)`, with no seatUnwatched override at all)
   * must make t-unwatched go unseated again - if it didn't, the override was
   * never the thing doing the work.
   */
  ['the seat-unwatched override', 'if (conv.agent && !unwatched && !ownDeadSeat)', 'if (conv.agent && !ownDeadSeat)'],
  ['the archived test', 'if (conv.archived)', 'if (false)'],
  ['the stopped test', "if (conv.stopAck === 'stopped')", 'if (false)'],
  ['the ignore list', 'if (ignore.has(cid))', 'if (false)'],
  ['the grace window', 'if (!(ageMs >= graceMs))', 'if (false)'],
  ['the already-dispatched memory', 'if (dispatched.has(t.id))', 'if (false)'],
  ['the live-process guard (persisted dedupe)', 'if (coord) {', 'if (false) {'],
  ['the one-per-tab guard', 'if (takenThisPass.has(cid))', 'if (false)'],
  ['the concurrency cap', 'if (occupied() + chosen.length >= maxConcurrent)', 'if (false)'],
  ['delivery to a live coordinator', 'if (coord && coord.attached && !coord.closing) {', 'if (false) {'],
  ['the mid-turn wait', 'if (coord.busy) {', 'if (false) {'],
  ['our own dead seat is reseatable', 'if (conv.agent && !unwatched && !ownDeadSeat)', 'if (conv.agent && !unwatched)'],
  ['our own dead seat must be OUR name', 'rec && rec.agent === conv.agent', 'rec'],
  ['eviction at the cap', 'if (!victim) {', 'if (true) {'],
  ['never evict mid-turn', 'c.attached && !c.busy && !c.closing', 'c.attached && !c.closing'],
  ['least recently active first', '(a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0)', '(b[1].lastActiveAt || 0) - (a[1].lastActiveAt || 0)'],
  ['human messages counted for coverage', "t.role === 'user' && HUMAN_ORIGINS.has(t.from)", 'true'],
  /*
   * The allowlist itself, mutated in BOTH directions, because it is a list and
   * a list can be wrong two ways.
   *
   * Narrowing it back to `web` alone replays the bug this was extended for. It
   * must go red, or the voice fixtures above are decoration that would keep
   * passing while he was being ignored again.
   *
   * Widening it to swallow the machine origins must go red too. That is the
   * load-bearing one: it proves the watchdog and checklist refusals are the
   * ALLOWLIST's doing and not some other guard's, which is what licenses the
   * claim that a dispatch loop is structurally impossible here rather than
   * merely unobserved. If this mutant survived, the allowlist could be swapped
   * for a blocklist tomorrow and nothing would notice.
   */
  ['voice dropped back out of the human allowlist',
    "const HUMAN_ORIGINS = new Set(['web', 'voice', 'voice-conversation']);",
    "const HUMAN_ORIGINS = new Set(['web']);"],
  ['machine origins let into the human allowlist',
    "new Set(['web', 'voice', 'voice-conversation'])",
    "new Set(['web', 'voice', 'voice-conversation', 'relay-watchdog', 'checklist'])"],
];

// ------------------------------------------------------------------ main

let bad = 0;

const baseline = check(real);
if (baseline.length) {
  console.log('FAIL  the suite is red against the real code:');
  for (const f of baseline) console.log(`        - ${f}`);
  bad += baseline.length;
} else {
  console.log('ok    every guard behaves, and an empty seat with a waiting message IS seated');
}

console.log('\nmutation - each guard is removed in turn; the suite MUST go red:');
for (const [name, find, replace] of MUTATIONS) {
  let mutantFailures;
  try {
    mutantFailures = check(loadMutant(find, replace));
  } catch (e) {
    console.log(`FAIL  ${name}: mutant could not be built or run - ${e.message}`);
    bad++;
    continue;
  }
  if (mutantFailures.length) {
    console.log(`ok    ${name} removed -> ${mutantFailures.length} assertion(s) failed`
      + ` (first: ${mutantFailures[0]})`);
  } else {
    console.log(`FAIL  ${name} removed -> the suite still passed. That guard is NOT tested.`);
    bad++;
  }
}

// A name has to be usable as an agent name and stay readable in a tab list.
const n = real.agentName('Relay: auto-seat on message', 'mtc5gwiw-raq28f');
if (!/^auto-[a-z0-9-]+$/.test(n) || n.length > 40) {
  console.log(`FAIL  agentName produced ${JSON.stringify(n)}`);
  bad++;
} else {
  console.log(`\nok    agentName -> ${n}`);
}

// The brief must name the tab it is for, and must not use the field name that
// fails silently on a claim.
const b = real.brief({ title: 'T', conversationId: 'cid-1', agent: 'auto-t', queue: 'http://x' });
if (!b.includes('cid-1') || !b.includes('"by"') || /[^\x00-\x7F]/.test(b)) {
  console.log('FAIL  the brief is missing the conversation id, the claim field, or is not pure ASCII');
  bad++;
} else {
  console.log('ok    the brief names its tab, uses the `by` claim field, and is pure ASCII');
}

/*
 * The coordinator is spawned with cfg.cwd, and Claude Code discovers
 * .claude/skills/ and loads .claude/settings.json ONLY for the directory a
 * session is rooted in. So the default cwd is not a convenience - it is what
 * makes the coordinator protocol visible and what registers the default-deny
 * guard.
 *
 * Break it and NOTHING reports an error: the coordinator boots with no manual,
 * the PreToolUse hook never fires, and default-deny silently becomes
 * default-allow. There is no log line and no failed request to notice. That is
 * exactly the class of fault that needs a test instead of a comment.
 *
 * Assert against the files themselves, not against a hardcoded path string, so
 * the directory can legitimately move as long as the protocol moves with it.
 */
const defaults = real.parseArgs([]);
const seatCwd = defaults.cwd;
const needed = [
  path.join(seatCwd, '.claude', 'skills', 'relay-coordinator', 'SKILL.md'),
  path.join(seatCwd, '.claude', 'settings.json'),
];
const missing = needed.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.log(`FAIL  coordinators would start in ${seatCwd}, which is missing:`);
  for (const m of missing) console.log(`        ${m}`);
  console.log('      A coordinator started there gets NO protocol and NO guard, silently.');
  bad++;
} else {
  const reg = fs.readFileSync(path.join(seatCwd, '.claude', 'settings.json'), 'utf8');
  if (!/coordinator-guard\.js/.test(reg)) {
    console.log(`FAIL  ${seatCwd}\\.claude\\settings.json does not register coordinator-guard.js.`);
    console.log('      Default-deny would silently become default-allow.');
    bad++;
  } else {
    console.log('ok    the spawn cwd contains the coordinator skill AND registers the guard');
  }
}

// ------------------------------------------------------------ lifecycle

/*
 * THE LIFECYCLE, DRIVEN FOR REAL. Everything above is the pure decision; this
 * runs the actual process management - spawn, stdin turns, stream-json
 * tailing, the SSE watch, resume, restart adoption, idle release, eviction -
 * against a fake relay (in this process) and a fake `claude` (a real child
 * process that speaks the same stream-json protocol and keeps a session store
 * on disk, so --resume can succeed or fail honestly).
 *
 * The fake claude's protocol was copied from the real CLI (2.1.x), measured on
 * 2026-09-17: one JSON line per user turn on stdin, a `system/init` event, a
 * `result` event per finished turn, a turn in progress FINISHED after stdin
 * EOF before exit, and `No conversation found with session ID: <id>` plus a
 * non-zero exit for an unknown --resume.
 */
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, cond, ms) {
  const until = Date.now() + (ms || 10000);
  while (Date.now() < until) {
    const v = await cond();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const FAKE_CLAUDE = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let sid = null; let resume = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id') sid = args[i + 1];
  if (args[i] === '--resume') { sid = args[i + 1]; resume = true; }
}
const store = process.env.FAKE_STORE;
const relay = process.env.FAKE_RELAY;
const sfile = path.join(store, sid + '.json');
const journal = (o) => fs.appendFileSync(path.join(store, 'journal.jsonl'), JSON.stringify({ pid: process.pid, sid, resume, ...o }) + '\\n');
if (resume && !fs.existsSync(sfile)) {
  process.stderr.write('No conversation found with session ID: ' + sid + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid }));
  process.exit(1);
}
const sess = fs.existsSync(sfile) ? JSON.parse(fs.readFileSync(sfile, 'utf8')) : { turns: 0, agent: null, cid: null };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
journal({ ev: 'start' });
let inflight = 0; let closed = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const text = JSON.parse(line).message.content;
    const name = /Your name is \\x60([^\\x60]+)\\x60/.exec(text) || /as \\x60([^\\x60]+)\\x60/.exec(text);
    const cid = /conversationId \\x60([^\\x60]+)\\x60/.exec(text);
    if (name) sess.agent = name[1];
    if (cid) sess.cid = cid[1];
    const ids = [...text.matchAll(/^- task (\\S+) /gm)].map((m) => m[1]);
    sess.turns++;
    fs.writeFileSync(sfile, JSON.stringify(sess));
    journal({ ev: 'turn', n: sess.turns, ids, brief: /FIRST, read/.test(text) });
    inflight++;
    const slow = /SLOW/.test(text) ? 2500 : 50;
    setTimeout(async () => {
      try {
        await fetch(relay + '/fake/answer', { method: 'POST', body: JSON.stringify({ ids, agent: sess.agent, cid: sess.cid }) });
      } catch {}
      journal({ ev: 'result', n: sess.turns });
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' }));
      inflight--;
      if (closed && !inflight) process.exit(0);
    }, slow);
  }
});
process.stdin.on('end', () => { closed = true; if (!inflight) process.exit(0); });
`;

function fakeRelay() {
  const convs = new Map();
  const tasks = [];
  const listeners = new Map();
  const subs = new Map();
  const releases = [];
  let seq = 0;
  const conv = (id) => {
    if (!convs.has(id)) convs.set(id, { id, title: `Tab ${id}`, agent: null, archived: false, stopAck: null });
    return convs.get(id);
  };
  const view = (c) => ({ ...c, agentState: { seatUnwatched: false, listeners: listeners.get(c.id) || 0 } });
  const push = (cid, obj) => { for (const res of subs.get(cid) || []) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && u.pathname === '/tasks') return json(200, { tasks: tasks.filter((t) => t.status === 'pending') });
    if (req.method === 'GET' && u.pathname === '/conversations') return json(200, { conversations: [...convs.values()].map(view) });
    const m = /^\/conversations\/([^/]+)$/.exec(u.pathname);
    if (m && req.method === 'GET') return json(200, view(conv(m[1])));
    if (m && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      const c = conv(m[1]);
      if (b.agent === null) releases.push({ cid: c.id, agent: c.agent, reason: b.agentLeftReason });
      c.agent = b.agent;
      push(c.id, { conversation: c });
      return json(200, view(c));
    }
    if (req.method === 'POST' && u.pathname === '/fake/answer') {
      const b = JSON.parse(body || '{}');
      if (b.cid && b.agent && !conv(b.cid).agent) conv(b.cid).agent = b.agent; /* the coordinator takes its seat */
      for (const t of tasks) if (b.ids.includes(t.id)) t.status = 'done';
      if (b.cid) push(b.cid, { entries: [{ id: 'x' }] });
      return json(200, {});
    }
    if (req.method === 'GET' && u.pathname === '/events') {
      const cid = u.searchParams.get('conversation');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('retry: 1000\n\n');
      listeners.set(cid, (listeners.get(cid) || 0) + 1);
      if (!subs.has(cid)) subs.set(cid, new Set());
      subs.get(cid).add(res);
      res.on('close', () => { listeners.set(cid, listeners.get(cid) - 1); subs.get(cid).delete(res); });
      return undefined;
    }
    return json(404, {});
  });
  return {
    server, convs, tasks, listeners, releases, conv,
    say(cid, text, extra) {
      const t = { id: `t${++seq}`, conversationId: cid, role: 'user', from: 'web', instruction: text,
        ts: new Date(Date.now() - 60000).toISOString(), status: 'pending', ...extra };
      conv(cid);
      tasks.push(t);
      push(cid, { entries: [t] });
      return t;
    },
    close() { for (const set of subs.values()) for (const r of set) r.destroy(); server.close(); },
  };
}

function journalOf(store) {
  try {
    return fs.readFileSync(path.join(store, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function lifecycleSuite() {
  const results = [];
  const test = async (name, fn) => {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name}: ${e.message}`]); }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoseat-life-'));
  const store = path.join(dir, 'store');
  fs.mkdirSync(store);
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, FAKE_CLAUDE, { mode: 0o755 });

  const relay = fakeRelay();
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
  const queue = `http://127.0.0.1:${relay.server.address().port}`;
  process.env.FAKE_STORE = store;
  process.env.FAKE_RELAY = queue;

  const argsFor = (name, extra) => ['--queue', queue, '--state', path.join(dir, `${name}.json`),
    '--heartbeat', path.join(dir, `${name}.hb`), '--log-dir', path.join(dir, 'logs'), '--claude', fake,
    '--cwd', dir, '--grace', '0', '--interval', '1', ...(extra || [])];
  const inProcess = (name, extra) => {
    const cfg = real.parseArgs(argsFor(name, extra));
    const lines = [];
    const runtime = real.createRuntime(cfg, (m) => lines.push(m));
    const tick = real.serialTicker(cfg, runtime, () => {});
    return { cfg, runtime, lines, tick };
  };
  const count = (lines, re) => lines.filter((l) => re.test(l)).length;
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // ---- 1. turn injection into a live process, and the watch it holds
  const A = inProcess('a');
  await test('a second message is a TURN in the same live process, delivered by the SSE doorbell', async () => {
    relay.say('tabA', 'first');
    await A.tick();
    const c = A.runtime.coords.get('tabA');
    assert(c && c.pid, 'no coordinator was spawned for a message in an empty tab');
    await waitFor('turn 1 result', () => c.turns === 1);
    assert(relay.convs.get('tabA').agent === c.agent, 'the fake coordinator did not take its seat');
    await waitFor('autoseat SSE listener on tabA', () => relay.listeners.get('tabA') === 1);
    relay.say('tabA', 'second');
    /* No manual tick: the SSE frame alone must deliver it. */
    await waitFor('turn 2 via the doorbell', () => c.turns === 2, 8000);
    const turns = journalOf(store).filter((e) => e.ev === 'turn' && e.sid === c.sessionId);
    assert(turns.length === 2 && turns.every((e) => e.pid === c.pid), `turns came from pids ${turns.map((e) => e.pid)} not all ${c.pid}`);
    assert(turns[0].brief && !turns[1].brief, 'the brief should ride the first turn only');
    assert(count(A.lines, /^DISPATCH /) === 1, `expected 1 DISPATCH, log has ${count(A.lines, /^DISPATCH /)}`);
    assert(count(A.lines, /^TURN auto-/) === 1, 'the second message was not logged as a TURN');
    assert(relay.listeners.get('tabA') === 1, `listeners on tabA = ${relay.listeners.get('tabA')}, expected exactly 1 while alive`);
  });

  // ---- 2. resume after the process dies
  await test('a killed coordinator is released, then RESUMED with the same session on the next message', async () => {
    const c = A.runtime.coords.get('tabA');
    const { pid, sessionId } = c;
    process.kill(pid, 'SIGKILL');
    await waitFor('exit handled', () => !A.runtime.coords.has('tabA'));
    await waitFor('seat released', () => relay.convs.get('tabA').agent === null);
    await waitFor('listener dropped with the process', () => relay.listeners.get('tabA') === 0);
    relay.say('tabA', 'third');
    await A.tick();
    const n = A.runtime.coords.get('tabA');
    assert(n && n.pid !== pid, 'no new process for the third message');
    assert(n.sessionId === sessionId && n.resumed, `expected resume of ${sessionId}, got ${n.sessionId} resumed=${n.resumed}`);
    await waitFor('resumed turn', () => n.turns === 1);
    const last = journalOf(store).filter((e) => e.ev === 'turn').pop();
    assert(last.resume && last.sid === sessionId && last.n === 3, `fake claude saw ${JSON.stringify(last)}`);
    assert(count(A.lines, /DISPATCH .* RESUMED/) === 1, 'no RESUMED dispatch line');
  });

  // ---- 3. resume that fails falls back to a fresh session, logged
  await test('a resume the CLI refuses falls back to a FRESH session and still answers', async () => {
    A.runtime.state.tabs.tabR = { agent: 'auto-r', sessionId: '00000000-0000-4000-8000-00000000dead', title: 'R', pid: null,
      lastActiveAt: new Date().toISOString() };
    const t = relay.say('tabR', 'answer me');
    await A.tick();
    await waitFor('fallback coordinator answered', () => {
      const c = A.runtime.coords.get('tabR');
      return c && !c.resumed && c.turns === 1;
    });
    assert(count(A.lines, /RESUME FAILED auto-r .*No conversation found/) === 1, 'RESUME FAILED was not logged with the CLI error');
    assert(relay.tasks.find((x) => x.id === t.id).status === 'done', 'the message was not answered after the fallback');
  });

  // ---- 4. idle release
  await test('an idle coordinator is retired, its seat released with a reason, its session kept', async () => {
    const c = A.runtime.coords.get('tabR');
    A.cfg.idleMs = 300;
    await sleep(400);
    await A.tick();
    await waitFor('idle exit', () => !A.runtime.coords.has('tabR') && c.finalized);
    const rel = relay.releases.filter((r) => r.cid === 'tabR').pop();
    assert(rel && /idle/.test(rel.reason), `release reason ${rel && rel.reason}`);
    assert(A.runtime.state.tabs.tabR.sessionId === c.sessionId && A.runtime.state.tabs.tabR.pid === null,
      'the session id was not kept for resume, or the pid was not cleared');
    A.cfg.idleMs = 30 * 60000;
  });
  await real.shutdown(A.runtime, 'test', { noExit: true });
  await waitFor('A coordinators gone', () => A.runtime.coords.size === 0 || [...A.runtime.coords.values()].every((c) => c.finalized));

  // ---- 5. eviction at the cap
  const E = inProcess('e', ['--max-concurrent', '1']);
  await test('at the cap the idle coordinator is evicted; with it mid-turn the new tab waits (SATURATED)', async () => {
    relay.say('tabE1', 'hello');
    await E.tick();
    const e1 = E.runtime.coords.get('tabE1');
    await waitFor('E1 idle', () => e1.turns === 1);
    relay.say('tabE2', 'SLOW please');
    await E.tick();
    assert(e1.closing === 'evicted', `E1 was not evicted (closing=${e1.closing})`);
    const e2 = E.runtime.coords.get('tabE2');
    assert(e2 && e2.busy, 'E2 was not seated after the eviction');
    await waitFor('E1 exit + release', () => e1.finalized);
    relay.say('tabE3', 'me too');
    await E.tick();
    assert(!E.runtime.coords.has('tabE3') && !e2.closing, 'a mid-turn coordinator was evicted, or E3 was seated over the cap');
    assert(count(E.lines, /^SATURATED/) >= 1, 'saturation was not logged');
    await waitFor('E2 done', () => e2.turns === 1, 6000);
    await E.tick();
    assert(e2.closing === 'evicted' && E.runtime.coords.has('tabE3'), 'once E2 went idle it was not evicted for E3');
  });
  await real.shutdown(E.runtime, 'test', { noExit: true });

  // ---- 6. autoseat restart: no double seat, mid-turn left alone, then resume
  await test('an autoseat RESTART adopts a mid-turn coordinator instead of seating twice, then resumes it', async () => {
    const cli = path.join(__dirname, 'autoseat.js');
    const startAutoseat = () => {
      const p = spawn(process.execPath, [cli, ...argsFor('r')], { stdio: ['ignore', 'pipe', 'pipe'] });
      p.out = '';
      p.stdout.on('data', (d) => { p.out += d; });
      p.stderr.on('data', (d) => { p.out += d; });
      return p;
    };
    /* Earlier tests' coordinators must be finished, or this autoseat would
     * (correctly) pick up their tabs and muddy which DISPATCH is which. */
    await waitFor('earlier tabs answered', () => relay.tasks.every((t) => t.status === 'done'), 10000);
    const one = startAutoseat();
    relay.say('tabS', 'SLOW long job');
    const first = await waitFor('restart-test dispatch', () => /DISPATCH (\S+) -> Tab tabS \(tabS\) pid (\d+) session (\S+)/.exec(one.out), 8000);
    const pid = Number(first[2]);
    const sessionId = first[3];
    await waitFor('the slow turn has started', () => journalOf(store).some((e) => e.ev === 'turn' && e.pid === pid));
    one.kill('SIGKILL'); /* the harshest restart: no shutdown handler at all */
    await new Promise((r) => one.on('exit', r));
    relay.say('tabS', 'another while it is busy');
    const two = startAutoseat();
    await waitFor('adoption', () => new RegExp(`ADOPTED \\S+ pid ${pid} `).test(two.out), 8000);
    await sleep(1200);
    assert(!/DISPATCH/.test(two.out), `the restarted autoseat seated a tab whose coordinator was still alive:\n${two.out}`);
    await waitFor('orphan finished its turn and exited', () => journalOf(store).some((e) => e.ev === 'result' && e.pid === pid), 8000);
    const resumed = await waitFor('resume after the survivor exits',
      () => /DISPATCH \S+ -> Tab tabS \(tabS\) pid (\d+) session (\S+) RESUMED/.exec(two.out), 12000)
      .catch((e) => { throw new Error(`${e.message}\n${two.out}`); });
    assert(resumed[2] === sessionId && Number(resumed[1]) !== pid, `resumed ${resumed[2]} pid ${resumed[1]}, expected session ${sessionId}`);
    await waitFor('resumed turn answered', () => relay.tasks.filter((t) => t.conversationId === 'tabS').every((t) => t.status === 'done'), 8000);
    await waitFor('idle', () => /TURN DONE .* turn #1 /.test(two.out.split('RESUMED')[1] || ''), 4000);
    // Graceful shutdown: the idle coordinator exits and its seat is released before autoseat exits.
    two.kill('SIGTERM');
    const code = await new Promise((r) => two.on('exit', (c) => r(c)));
    assert(code === 0, `autoseat exited ${code} on SIGTERM`);
    assert(/SIGTERM: closing stdin on 1 coordinator\(s\); 1 idle/.test(two.out), `shutdown line missing:\n${two.out.slice(-600)}`);
    assert(relay.releases.some((r) => r.cid === 'tabS' && /stopping/.test(r.reason || '')), 'the idle seat was not released on SIGTERM');
    assert(!pidAlive(Number(resumed[1])), 'the idle coordinator was left running after SIGTERM');
  });

  relay.close();
  await sleep(300); /* let the last coordinators' exits land before their store goes */
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

lifecycleSuite().then((results) => {
  console.log('\nlifecycle - real processes against a fake relay and a fake claude:');
  for (const [pass, name] of results) {
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!pass) bad++;
  }
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
  process.exit(bad ? 1 : 0);
}, (e) => {
  console.log(`FAIL  lifecycle suite crashed: ${e.stack}`);
  process.exit(1);
});
