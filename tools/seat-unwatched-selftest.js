#!/usr/bin/env node
'use strict';
/*
 * seat-unwatched-selftest - prove relay notices when nobody is actually
 * subscribed to a conversation's SSE stream, combined with a grace window so
 * a normal momentary gap never reads as a fault.
 *
 *   node tools/seat-unwatched-selftest.js
 *
 * THE INCIDENT THIS GUARDS AGAINST ("FluxPrep", 2026-08-28). A coordinator
 * agent was dispatched, answered a few messages, finished its task, and its
 * whole process exited. `agent` stayed non-null the entire time afterward -
 * nothing server-side ever observes a process exiting - so autoseat.js's
 * existing `agent === null` trigger refused to seat anyone else, forever. For
 * about 9 minutes, 12 human messages queued up with zero live listeners on the
 * conversation's SSE stream, and nothing noticed: the seat looked occupied but
 * nobody was actually holding it.
 *
 * WHAT THIS PROVES, each one a way a naive "listeners == 0 -> fire" version
 * would get it wrong (see seatWatchInfo() and evidenceOfLifeMs() in
 * server.js, and the design note above SEAT_UNWATCHED_MS):
 *   - a quiet, caught-up tab (nothing pending) never reports seatUnwatched,
 *     however long nobody has been listening - that is Tuesday, not a fault.
 *   - a currently-watched seat never reports unwatched, held open past the
 *     grace window or not.
 *   - a seat with a name, a pending message, and zero listeners DOES
 *     eventually report seatUnwatched, but not on the very first read - only
 *     once SEAT_UNWATCHED_MS has actually elapsed.
 *   - that signal never touches `agent` itself - it rides alongside it.
 *   - a momentary connect/disconnect blip well inside the grace window does
 *     NOT trip it.
 *   - a coordinator genuinely heads-down on a DIFFERENT, already-claimed task
 *     (posting a progress note, holding no stream) is not duplicated on top
 *     of - a fresh progress note vouches for it exactly as it does for
 *     `state: 'working'`.
 *   - a freshly reseated occupant is not blamed for a vacancy that predates
 *     it - the same agentSince fix CHAIR_VACANT_MS's sweep already needed.
 *   - a firehose (unscoped /events) connection never counts toward any single
 *     conversation's listener tally - or the signal would never fire while
 *     relay-watchdog (which watches the firehose) is attached.
 *
 * Then two mutations, each applied to a SCRATCH COPY of server.js built with
 * one in-memory string substitution (never the real file, never sed/perl -
 * see autoseat-selftest.js for why that matters on this box: CRLF makes those
 * tools silently match nothing and exit 0, reporting a fake "survived"), each
 * proving the suite goes RED without the guard it removes:
 *   - killing seatWatchInfo's own verdict reproduces the FluxPrep incident
 *     exactly: a dead seat with a pending message never gets flagged, ever.
 *   - killing the SSE connect hook (the count is never incremented) produces
 *     the OPPOSITE failure: every occupied seat with a pending message reads
 *     as unwatched the moment the grace window elapses, REGARDLESS of a real,
 *     live listener sitting right there.
 *
 * Zero dependencies. Node built-ins only, like the rest of this project.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer } = require('./harness-lib');

const SRC = path.join(__dirname, '..', 'server.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v === undefined ? null : v);

/** Fast enough to run in seconds; SEAT_UNWATCHED_MS is independently tunable in production. */
const FAST = { SEAT_UNWATCHED_MS: '700' };

async function withServer(env, fn, serverOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seatwatch-'));
  const srv = await startServer({ dir, label: 'seatwatch', env, server: serverOverride });

  const call = async (method, p, body) => {
    const r = await fetch(srv.base + p, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* some routes answer empty */ }
    return { status: r.status, body: json };
  };
  const get = async (id) => (await call('GET', `/conversations/${id}`)).body;
  const seat = async (title, agent) => {
    const made = await call('POST', '/conversations', { title, agent });
    if (made.status !== 201 || !made.body || !made.body.id) {
      throw new Error(`could not create a conversation: HTTP ${made.status} ${j(made.body)}`);
    }
    return made.body.id;
  };
  const post = (conversationId, text) => call('POST', '/tasks', { conversationId, text, from: 'test' });

  const inflight = [];
  /** Opens a real SSE connection; returns a handle that closes it on demand. */
  function open(query) {
    let closed = false;
    const req = http.request(`${srv.base}/events${query || ''}`, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.on('data', () => {}); // drain - only the open socket itself matters here
    });
    req.on('error', () => {});
    req.end();
    inflight.push(req);
    return { close: () => { if (!closed) { closed = true; req.destroy(); } } };
  }

  try {
    await fn({ srv, dir, call, get, seat, post, open });
  } catch (err) {
    process.stderr.write(`\n[server output]\n${srv.out}\n`);
    throw err;
  } finally {
    for (const req of inflight) req.destroy();
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the log */ }
  }
}

/** Polls GET /conversations/<id> until agentState.seatUnwatched === want, or times out with the last read. */
async function waitSeatUnwatched(get, id, want, ms = 4000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await get(id);
    if (last && last.agentState && last.agentState.seatUnwatched === want) return last;
    await sleep(40);
  }
  return last;
}

/*
 * Builds a scratch mutant copy of server.js with exactly one substitution
 * applied, written NEXT TO the real server.js (not in the OS temp dir) -
 * server.js has a few relative requires (./icons.js, ./push.js, ./share.js)
 * that resolve relative to wherever the running file lives, so a copy dropped
 * in os.tmpdir() dies on boot with MODULE_NOT_FOUND before it ever gets to
 * demonstrate anything. Named with a random suffix and always removed in
 * proveMutationMatters()'s finally block; also gitignored (*.mutant.js) in
 * case a killed run ever leaves one behind.
 */
function buildMutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8');
  const hits = src.split(find).length - 1;
  // The same honesty check autoseat-selftest.js's loadMutant() makes: a
  // mutation that matched nothing would silently run the ORIGINAL code and
  // report "survived" indistinguishably from a genuinely untested guard.
  if (hits !== 1) throw new Error(`mutation target ${JSON.stringify(find)} matched ${hits} times, expected exactly 1`);
  const mutantPath = path.join(path.dirname(SRC), `${crypto.randomBytes(6).toString('hex')}.mutant.js`);
  fs.writeFileSync(mutantPath, src.split(find).join(replace));
  return mutantPath;
}

/**
 * Runs `fn` against a server built from a mutated copy of server.js, and
 * reports whether the mutation's expected SYMPTOM actually appears - i.e.
 * whether removing the guard really does reproduce the bug it guards against.
 * `fn` returns true when the BROKEN behavior is observed under the mutant.
 */
async function proveMutationMatters(name, find, replace, fn) {
  let mutantPath;
  try {
    mutantPath = buildMutant(find, replace);
  } catch (e) {
    console.log(`FAIL  ${name}: mutant could not be built - ${e.message}`);
    failures++;
    return;
  }
  try {
    let brokenObserved = false;
    await withServer(FAST, async (ctx) => { brokenObserved = await fn(ctx); }, mutantPath);
    if (brokenObserved) {
      console.log(`ok    ${name} removed -> the bug it guards against reproduces, as expected`);
    } else {
      console.log(`FAIL  ${name} removed -> the suite still behaved correctly. That guard is NOT tested.`);
      failures++;
    }
  } finally {
    try { fs.rmSync(mutantPath, { force: true }); } catch { /* best effort */ }
  }
}

async function main() {
  console.log('seat-unwatched-selftest');

  // ---------------------------------------------------- behavior, real code
  await withServer(FAST, async ({ call, get, seat, post, open }) => {
    console.log('\na quiet, caught-up tab is never "unwatched", however old');
    const idle = await seat('idle tab', 'IdleCoord');
    await sleep(900);
    const idleConv = await get(idle);
    check('no pending message -> seatUnwatched stays false',
      idleConv.agentState.seatUnwatched === false, j(idleConv.agentState));
    check('listeners still reported even with none open',
      idleConv.agentState.listeners === 0, j(idleConv.agentState.listeners));

    console.log('\na currently-watched seat never reports unwatched, pending or not');
    const watched = await seat('watched tab', 'WatchedCoord');
    await post(watched, 'hello');
    const stream = open(`?conversation=${watched}`);
    await sleep(200); // let the connection actually establish
    const afterConnect = await get(watched);
    check('a live listener is reflected right away',
      afterConnect.agentState.listeners >= 1, j(afterConnect.agentState));
    await sleep(900); // longer than SEAT_UNWATCHED_MS
    const stillWatched = await get(watched);
    check('*** held open past the grace window, still not unwatched ***',
      stillWatched.agentState.seatUnwatched === false, j(stillWatched.agentState));
    stream.close();

    console.log('\n*** THE FLUXPREP CASE: agent seated, message pending, nobody listening ***');
    const dead = await seat('dead coordinator tab', 'FluxPrep');
    await post(dead, 'are you there');
    const soon = await get(dead);
    check('not unwatched on the very first read - the grace window has not elapsed yet',
      soon.agentState.seatUnwatched === false, j(soon.agentState));
    const gone = await waitSeatUnwatched(get, dead, true);
    check('*** eventually flagged seatUnwatched once the grace window passes ***',
      !!gone && gone.agentState.seatUnwatched === true, j(gone && gone.agentState));
    check('agent is UNCHANGED - this signal rides alongside the agent field, never touches it',
      !!gone && gone.agent === 'FluxPrep', j(gone && gone.agent));

    console.log('\na momentary connect/disconnect blip does not trip it');
    const blip = await seat('blip tab', 'BlipCoord');
    await post(blip, 'ping');
    const s1 = open(`?conversation=${blip}`);
    await sleep(150);
    s1.close();
    await sleep(150); // still well inside the 700ms grace
    const rightAfterBlip = await get(blip);
    check('a brief listener blip does not immediately read as unwatched',
      rightAfterBlip.agentState.seatUnwatched === false, j(rightAfterBlip.agentState));

    console.log('\na coordinator heads-down on a DIFFERENT task is not duplicated on top of');
    const busy = await seat('busy coordinator tab', 'BusyCoord');
    const firstTask = await post(busy, 'first message, about to be claimed');
    await call('POST', `/tasks/${firstTask.body.id}/claim`, { by: 'BusyCoord' });
    await sleep(500); // simulating a long-running claim, most of the grace window
    await call('POST', `/tasks/${firstTask.body.id}/progress`, { by: 'BusyCoord', note: 'still working' });
    await post(busy, 'a second message arrives while still busy'); // pending > 0 again
    await sleep(200); // comfortably inside the grace window measured from the progress note
    const stillBusy = await get(busy);
    check('*** a fresh progress note holds off seatUnwatched despite zero listeners ***',
      stillBusy.agentState.seatUnwatched === false, j(stillBusy.agentState));

    console.log('\na freshly reseated occupant is not blamed for a vacancy that predates it');
    const stale = await seat('stale then fresh tab', 'GhostCoord');
    await post(stale, 'anyone home');
    const wasUnwatched = await waitSeatUnwatched(get, stale, true);
    check('the old occupant is flagged unwatched first, to set up the real assertion below',
      !!wasUnwatched && wasUnwatched.agentState.seatUnwatched === true, j(wasUnwatched && wasUnwatched.agentState));
    await call('POST', `/conversations/${stale}`, { agent: 'FreshCoord' });
    const rightAfterReseat = await get(stale);
    check('*** immediately false again for the new occupant, same zero listeners ***',
      rightAfterReseat.agentState.seatUnwatched === false, j(rightAfterReseat.agentState));

    console.log('\na firehose connection never counts toward any single conversation');
    const withFirehose = await seat('firehose does not count', 'GhostCoord2');
    await post(withFirehose, 'hello again');
    const firehose = open(''); // unscoped - the firehose
    await sleep(200);
    const stillFlags = await waitSeatUnwatched(get, withFirehose, true);
    check('*** a firehose watcher does not suppress the signal ***',
      !!stillFlags && stillFlags.agentState.seatUnwatched === true, j(stillFlags && stillFlags.agentState));
    firehose.close();
  });

  // ------------------------------------------------ mutation: prove it can fail
  console.log('\nmutation - each guard is removed in turn; the suite MUST go red:');

  await proveMutationMatters(
    "seatWatchInfo's own verdict",
    'const seatUnwatched = !!lastLife && (now - lastLife) >= SEAT_UNWATCHED_MS;',
    'const seatUnwatched = false;',
    async ({ get, seat, post }) => {
      const dead = await seat('mutant dead coordinator', 'FluxPrep');
      await post(dead, 'are you there');
      await sleep(1200); // well past the grace window
      const still = await get(dead);
      // Broken means it reproduces the FluxPrep incident: still false forever.
      return !!still && !!still.agentState && still.agentState.seatUnwatched === false;
    },
  );

  await proveMutationMatters(
    'the SSE connect hook (listener count never increments)',
    'w.count++;',
    '/* mutated: listener count never increments */;',
    async ({ get, seat, post, open }) => {
      const watched = await seat('mutant watched tab', 'WatchedCoord');
      await post(watched, 'hello');
      const stream = open(`?conversation=${watched}`);
      await sleep(1200); // well past the grace window, WITH a live connection open
      const still = await get(watched);
      stream.close();
      // Broken means the opposite failure: fires anyway, despite a real listener.
      return !!still && !!still.agentState && still.agentState.seatUnwatched === true;
    },
  );

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
