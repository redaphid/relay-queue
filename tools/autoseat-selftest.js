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

function run(mod, over) {
  return mod.selectSeats({
    tasks,
    conversations,
    dispatched: new Set(['t-already']),
    inFlight: new Set(['c-inflight']),
    ignore: new Set(['c-ignored']),
    now: NOW,
    graceMs: GRACE_MS,
    maxConcurrent: 3,
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

  // Exactly one coordinator for the tab holding two messages, and it is the
  // older one - the oldest message is what the human is waiting on.
  ok(chosen.filter((c) => c.conversationId === 'c-two').length === 1,
    'a tab with two waiting messages was seated more than once');
  ok(seated.includes('t-two-a'), 'the OLDER of two waiting messages was not the one that seated');

  ok(seated.length === 2, `expected exactly 2 dispatches, got ${seated.length}: ${seated.join(',')}`);

  /*
   * t-unwatched is a REAL, otherwise-eligible candidate at the same age as
   * t-seat, so under the default cap (3, with one slot already held by
   * c-inflight) it is legitimately cap-refused here — proof it is competing
   * on equal footing with every other candidate, not silently exempted from
   * the cap. Its actual rescue is asserted below under a raised cap, the same
   * way `roomy` isolates the one-per-tab guard from the cap guard.
   */
  ok(refused('t-unwatched'), 'an occupied-but-unwatched seat should still be subject to the concurrency cap like any other candidate');

  /*
   * THE FLUXPREP CASE. A seat with a name on it, but the server itself says
   * nobody is subscribed to its SSE stream (agentState.seatUnwatched, folded
   * in with a grace window and every other liveness signal server-side - see
   * seatWatchInfo() in server.js). `conv.agent` being non-null must no longer
   * be an unconditional refusal, or this exact incident recurs: a coordinator
   * exits, its name never leaves the seat, and nothing ever answers the human
   * again. Cap raised out of the way, same isolation `roomy` uses above.
   */
  const unwatchedRun = run(mod, { maxConcurrent: 99, inFlight: new Set() });
  const unwatchedWhy = Object.fromEntries(unwatchedRun.considered.map((r) => [r.taskId, r.why]));
  ok(unwatchedRun.chosen.some((c) => c.taskId === 't-unwatched'),
    'a seat occupied by a name but flagged agentState.seatUnwatched was NOT rescued - this is the FluxPrep gap');
  ok(/DeadCoord/.test(unwatchedWhy['t-unwatched'] || '') && /unwatched/.test(unwatchedWhy['t-unwatched'] || ''),
    `the reason for seating t-unwatched should name the stale coordinator and say why it was rescued: ${unwatchedWhy['t-unwatched']}`);
  // The negative control in the SAME run: a genuinely staffed seat (no
  // agentState.seatUnwatched at all) must still be refused, cap or no cap.
  ok(!unwatchedRun.chosen.some((c) => c.taskId === 't-staffed'),
    'a genuinely staffed seat was seated once the cap was raised - it must be refused on its own merits, not just by the cap');

  /*
   * The same one-per-tab rule again, but with the cap raised out of the way.
   * Mutation testing caught this: with the default cap of 3, removing the
   * one-per-tab guard changed nothing, because the SECOND message in that tab
   * was refused for hitting the cap instead. The guard was passing on the
   * strength of a different guard's work.
   */
  const roomy = run(mod, { maxConcurrent: 99, inFlight: new Set() });
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
  ok(refused('t-watchdog') && /not the human web client/.test(why['t-watchdog']),
    'a watchdog poke triggered a dispatch - this is the nag amplifier');
  ok(refused('t-checklist') && /not the human web client/.test(why['t-checklist']),
    'a checklist settle triggered a dispatch');
  ok(refused('t-fresh') && /grace/.test(why['t-fresh']),
    'a message inside the grace window was seated');
  ok(refused('t-already') && /already dispatched/.test(why['t-already']),
    'a message that already had a coordinator was dispatched a second time');
  ok(refused('t-inflight') && /still running/.test(why['t-inflight']),
    'a tab with a dispatch already running was seated again');

  // Every pending message is accounted for. A selector that silently drops
  // rows can hide a whole class of input from review.
  ok(considered.length === tasks.length,
    `considered ${considered.length} of ${tasks.length} pending messages`);

  // The cap, measured with nothing already in flight so it is the cap being
  // tested and not the in-flight guard.
  const capped = run(mod, { maxConcurrent: 1, inFlight: new Set() });
  ok(capped.chosen.length === 1, `cap of 1 let ${capped.chosen.length} through`);
  ok(capped.chosen[0] && capped.chosen[0].taskId === 't-two-a',
    'under a cap of 1 the oldest waiting message was not the one that got the coordinator');
  ok(/concurrency cap/.test((capped.considered.find((r) => r.taskId === 't-seat') || {}).why || ''),
    'a second eligible tab under a cap of 1 was not refused for being at the cap');

  // In-flight counts against the cap, not just against its own tab: an agent
  // still starting up is an agent. A cap that only counted THIS pass would
  // spawn the cap afresh every tick.
  ok(run(mod, { maxConcurrent: 1, inFlight: new Set(['c-inflight']) }).chosen.length === 0,
    'the cap ignored a dispatch that was already in flight');

  // One coordinator answers the whole tab, so both of its messages must be
  // recorded as covered - otherwise a restart dispatches a second one.
  const covered = mod.coveredBy(tasks, 'c-two').sort();
  ok(covered.length === 2 && covered[0] === 't-two-a' && covered[1] === 't-two-b',
    `coveredBy returned ${JSON.stringify(covered)} for a tab with two human messages`);
  ok(!mod.coveredBy(tasks, 'c-agentmsg').length,
    'coveredBy counted an agent post as a human message');

  return fail;
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
  ['the human-client test', 'if (t.from !== HUMAN_FROM)', 'if (false)'],
  ['the occupied-seat test', 'if (conv.agent && !unwatched)', 'if (false)'],
  /*
   * THE FLUXPREP REGRESSION, REPRODUCED ON PURPOSE. Reverting to the OLD,
   * pre-fix guard (`if (conv.agent)`, with no seatUnwatched override at all)
   * must make t-unwatched go unseated again - if it didn't, the override was
   * never the thing doing the work.
   */
  ['the seat-unwatched override', 'if (conv.agent && !unwatched)', 'if (conv.agent)'],
  ['the archived test', 'if (conv.archived)', 'if (false)'],
  ['the stopped test', "if (conv.stopAck === 'stopped')", 'if (false)'],
  ['the ignore list', 'if (ignore.has(cid))', 'if (false)'],
  ['the grace window', 'if (!(ageMs >= graceMs))', 'if (false)'],
  ['the already-dispatched memory', 'if (dispatched.has(t.id))', 'if (false)'],
  ['the in-flight guard', 'if (inFlight.has(cid))', 'if (false)'],
  ['the one-per-tab guard', 'if (takenThisPass.has(cid))', 'if (false)'],
  ['the concurrency cap', 'if (inFlight.size + chosen.length >= maxConcurrent)', 'if (false)'],
  ['human messages counted for coverage', "t.role === 'user' && t.from === HUMAN_FROM", 'true'],
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

console.log(bad ? `\n${bad} FAILURE(S)` : '\nall good');
process.exit(bad ? 1 : 0);
