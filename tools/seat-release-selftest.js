'use strict';
/*
 * seat-release-selftest - prove an agent that stands down leaves a trace.
 *
 *   node tools/seat-release-selftest.js
 *
 * THE BUG THIS SUITE EXISTS FOR. Only sweepVacantChairs() ever wrote the
 * vacancy notice (`agentLeft` / `agentLeftAt` / `agentLeftReason`). A
 * coordinator that finished its work and released its own chair -
 *
 *     POST /conversations/<id> {"agent":null,"agentLeftReason":"done"}
 *
 * - emptied the seat and recorded NOTHING. The supplied reason was not read by
 * any code path; it came back null. So the record of a tab whose agent quit
 * cleanly was byte for byte the record of a tab that never had an agent at all:
 *
 *     "agent":           null
 *     "agentLeft":       null
 *     "agentLeftReason": null
 *
 * WHAT THAT COST, on 2026-08-27. A coordinator looked at an empty-seated tab,
 * read "nobody here, nothing recorded" as "the work finished and the tab is
 * idle", and reported to the human that it was blocked on him. In fact an agent
 * had DIED holding two of his messages as claimed tasks, one of them the answer
 * unblocking a major piece of work. He lost 45 minutes. "The seat is empty" had
 * to be able to distinguish:
 *
 *     finished cleanly   -> agentLeft set, reason a deliberate word
 *     evicted by the sweep -> agentLeft set, reason exactly "presumed-gone"
 *     never staffed      -> agentLeft null
 *
 * and it could only tell the middle one apart. That distinction is the whole
 * input to "should I reseat this tab".
 *
 * WHAT MUST NOT CHANGE - and these are the checks carrying the risk, because
 * they pass on the OLD code too and so are genuine regression guards rather
 * than green-by-construction:
 *   - the sweep must still write "presumed-gone", and it must remain the ONLY
 *     way that word can appear. A caller may not forge it, or an eviction and a
 *     clean exit collapse back into one state through a different door.
 *   - releasing an ALREADY-EMPTY chair must keep the existing notice verbatim.
 *     This is the guard that a naive "write a tombstone on every unassign"
 *     fails: it would overwrite a real eviction record with a fresh one naming
 *     nobody, on a request that changed nothing.
 *   - a NEW occupant still clears the previous occupant's notice AND stop state
 *     (fixed earlier the same day - see tools/seat-tombstone-selftest.js).
 *   - re-asserting the same name is still a no-op, and a title-only edit still
 *     leaves the chair alone.
 *   - `agent:null` still PRESERVES stop history. "Stopped cleanly and stood
 *     down" is exactly the state the notice is for; erasing it would collapse
 *     it back into "never had an agent".
 *
 * Ports come from the OS (see tools/harness-lib.js). Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v === undefined ? null : v);

/*
 * Two clocks, deliberately, on two separate servers.
 *
 * The voluntary-release half must not race the sweep: with a 1.2s vacancy clock
 * a chair can be evicted between the seating and the release, and the suite
 * would then be measuring the sweep while claiming to measure the release. The
 * eviction half needs the opposite. One shared value cannot be both, and a
 * hand-rolled imitation of the sweep would test this file's idea of it rather
 * than the sweep itself.
 */
const SLOW = { CHAIR_VACANT_MS: String(60 * 60 * 1000), WATCH_TICK_MS: '250' };
const FAST = { CHAIR_VACANT_MS: '1200', WATCH_TICK_MS: '100' };

async function withServer(env, label, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-'));
  const srv = await startServer({ dir, label, env });

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
  /** Waits for the real sweep to fire rather than assuming a sleep was enough. */
  const waitVacated = async (id, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const c = await get(id);
      if (c && c.agent === null && c.agentLeft) return c;
      await sleep(50);
    }
    return await get(id);
  };

  try {
    await fn({ srv, dir, call, get, seat, waitVacated });
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

async function main() {
  console.log('seat-release-selftest');

  let cleanReason = null;

  // ------------------------------------------------------- the release itself
  await withServer(SLOW, 'seat-release', async ({ call, get, seat, srv }) => {
    console.log('\na voluntary release records who left, when, and why');

    const id = await seat('release probe', 'LeaverCoord');
    const left = await call('POST', `/conversations/${id}`, { agent: null, agentLeftReason: 'done' });
    check('the release is accepted', left.status === 200, `HTTP ${left.status} ${j(left.body)}`);
    check('the chair is empty', left.body && left.body.agent === null, j(left.body && left.body.agent));
    check('*** who left is recorded ***', left.body && left.body.agentLeft === 'LeaverCoord',
      j(left.body && left.body.agentLeft));
    check('*** the caller-supplied reason is honoured ***', left.body && left.body.agentLeftReason === 'done',
      j(left.body && left.body.agentLeftReason));
    check('*** and a time ***', !!(left.body && left.body.agentLeftAt), j(left.body && left.body.agentLeftAt));
    check('the occupancy clock is cleared', left.body && left.body.agentSince === null,
      j(left.body && left.body.agentSince));

    /*
     * The reply is not the record. A POST echo has already been wrong here once
     * (the attach route answering 200 with `agent:null`), which is why the
     * stored object is read back separately every time.
     */
    const back = await get(id);
    check('*** the STORED record agrees, not just the reply ***',
      back && back.agentLeft === 'LeaverCoord' && back.agentLeftReason === 'done',
      j({ agentLeft: back && back.agentLeft, reason: back && back.agentLeftReason }));
    cleanReason = back && back.agentLeftReason;

    console.log('\na bare {"agent":null} still leaves a trace');

    const id2 = await seat('bare release probe', 'QuietCoord');
    const bare = await call('POST', `/conversations/${id2}`, { agent: null });
    check('*** who left is recorded with no reason supplied ***',
      bare.body && bare.body.agentLeft === 'QuietCoord', j(bare.body && bare.body.agentLeft));
    check('*** and a default reason is filled in ***',
      bare.body && typeof bare.body.agentLeftReason === 'string' && bare.body.agentLeftReason.length > 0,
      j(bare.body && bare.body.agentLeftReason));
    check('*** which is NOT the eviction word ***',
      bare.body && bare.body.agentLeftReason !== 'presumed-gone', j(bare.body && bare.body.agentLeftReason));

    console.log('\nthe reply says what was recorded, so a caller need not guess');

    const id3 = await seat('echo probe', 'EchoCoord');
    const rel = await call('POST', `/conversations/${id3}`, { agent: null, agentLeftReason: 'handed off' });
    check('*** the release is reported back ***', !!(rel.body && rel.body.seatRelease), j(rel.body && rel.body.seatRelease));
    check('*** ...as recorded, naming the agent ***',
      rel.body && rel.body.seatRelease && rel.body.seatRelease.recorded === true
      && rel.body.seatRelease.agent === 'EchoCoord', j(rel.body && rel.body.seatRelease));

    // Releasing a chair nobody is in changed nothing, and must SAY that rather
    // than answering with the same success shape as a real release.
    const again = await call('POST', `/conversations/${id3}`, { agent: null, agentLeftReason: 'done' });
    check('*** releasing an empty chair reports that nothing was recorded ***',
      again.body && again.body.seatRelease && again.body.seatRelease.recorded === false,
      j(again.body && again.body.seatRelease));

    console.log('\n"presumed-gone" is the sweep`s word and a caller may not forge it');

    const id4 = await seat('forgery probe', 'ForgeCoord');
    const forged = await call('POST', `/conversations/${id4}`, { agent: null, agentLeftReason: 'presumed-gone' });
    check('*** a caller-supplied "presumed-gone" is refused ***', forged.status === 400,
      `HTTP ${forged.status} ${j(forged.body)}`);
    const stillThere = await get(id4);
    check('...and the refusal changed nothing', stillThere && stillThere.agent === 'ForgeCoord',
      j(stillThere && stillThere.agent));

    console.log('\na reason with no release is refused, never silently swallowed');

    const id5 = await seat('stray reason probe', 'StayCoord');
    const strayTitle = await call('POST', `/conversations/${id5}`, { title: 'renamed', agentLeftReason: 'done' });
    check('*** a reason on an edit that seats nobody is refused ***', strayTitle.status === 400,
      `HTTP ${strayTitle.status} ${j(strayTitle.body)}`);
    const straySeat = await call('POST', `/conversations/${id5}`, { agent: 'OtherCoord', agentLeftReason: 'done' });
    check('*** a reason alongside SEATING someone is refused ***', straySeat.status === 400,
      `HTTP ${straySeat.status} ${j(straySeat.body)}`);
    const notRenamed = await get(id5);
    check('...and neither refusal changed anything',
      notRenamed && notRenamed.title === 'stray reason probe' && notRenamed.agent === 'StayCoord',
      j({ title: notRenamed && notRenamed.title, agent: notRenamed && notRenamed.agent }));

    const badType = await call('POST', `/conversations/${id5}`, { agent: null, agentLeftReason: 42 });
    check('*** a non-string reason is refused ***', badType.status === 400,
      `HTTP ${badType.status} ${j(badType.body)}`);

    const longOne = await seat('long reason probe', 'VerboseCoord');
    const long = await call('POST', `/conversations/${longOne}`, { agent: null, agentLeftReason: 'x'.repeat(4000) });
    check('*** an over-long reason is capped, not refused and not stored whole ***',
      long.status === 200 && long.body && typeof long.body.agentLeftReason === 'string'
      && long.body.agentLeftReason.length > 0 && long.body.agentLeftReason.length <= 300,
      `HTTP ${long.status} len=${j(long.body && long.body.agentLeftReason && long.body.agentLeftReason.length)}`);

    console.log('\nthe record survives a restart (it is an event, not a cache)');

    await srv.restart();
    const replayed = await get(id);
    check('*** the departure replays from the log ***',
      replayed && replayed.agentLeft === 'LeaverCoord' && replayed.agentLeftReason === 'done',
      j({ agentLeft: replayed && replayed.agentLeft, reason: replayed && replayed.agentLeftReason }));

    console.log('\nwhat must NOT change - a new occupant still clears the notice');

    const reseated = await call('POST', `/conversations/${id}`, { agent: 'FreshCoord' });
    check('the new agent is seated', reseated.body && reseated.body.agent === 'FreshCoord',
      j(reseated.body && reseated.body.agent));
    check('the notice is cleared', reseated.body && reseated.body.agentLeft === null,
      j(reseated.body && reseated.body.agentLeft));
    check('...and its reason', reseated.body && reseated.body.agentLeftReason === null,
      j(reseated.body && reseated.body.agentLeftReason));
    check('...and its timestamp', reseated.body && reseated.body.agentLeftAt === null,
      j(reseated.body && reseated.body.agentLeftAt));

    console.log('\nwhat must NOT change - the neighbouring rules in the same block');

    const sinceA = reseated.body && reseated.body.agentSince;
    const sameAgain = await call('POST', `/conversations/${id}`, { agent: 'FreshCoord' });
    check('re-asserting the same name is still a no-op',
      sameAgain.body && sameAgain.body.agentSince === sinceA,
      j({ before: sinceA, after: sameAgain.body && sameAgain.body.agentSince }));

    await call('POST', `/conversations/${id}`, { agent: null, agentLeftReason: 'done' });
    const titled = await call('POST', `/conversations/${id}`, { title: 'renamed, nothing to do with seats' });
    check('a title-only edit still leaves the vacancy notice alone',
      titled.body && titled.body.agentLeft === 'FreshCoord', j(titled.body && titled.body.agentLeft));

    console.log('\nwhat must NOT change - stop history survives an unassign');

    const sid = await seat('stop history probe', 'StopCoord');
    await call('POST', `/conversations/${sid}/stop-ack`, { agent: 'StopCoord', phase: 'stopping', note: 'winding down' });
    const stopped = await call('POST', `/conversations/${sid}`, { agent: null, agentLeftReason: 'stopped' });
    check('an unassign keeps the stop acknowledgement',
      stopped.body && stopped.body.stopAck === 'stopping', j(stopped.body && stopped.body.stopAck));
    check('...and the note', stopped.body && stopped.body.stopNote === 'winding down',
      j(stopped.body && stopped.body.stopNote));

    console.log('\nthe other door out of the chair records a departure too');

    /*
     * `stop-ack {"phase":"stopped"}` empties the seat itself. It is the most
     * explicit exit the system has and it was leaving `agentLeft` null, so the
     * one tab where the agent had most clearly announced it was going looked
     * least staffed-then-vacated. The invariant is the point: `agent` going
     * from a name to null ALWAYS records who left, whichever door it used.
     */
    const aid = await seat('stop-ack probe', 'AckCoord');
    const ack = await call('POST', `/conversations/${aid}/stop-ack`, { agent: 'AckCoord', phase: 'stopped' });
    check('the stop-ack is accepted', ack.status === 200, `HTTP ${ack.status} ${j(ack.body)}`);
    const afterAck = await get(aid);
    check('the chair is empty after a stopped ack', afterAck && afterAck.agent === null,
      j(afterAck && afterAck.agent));
    check('*** ...and it records who left ***', afterAck && afterAck.agentLeft === 'AckCoord',
      j(afterAck && afterAck.agentLeft));
    check('*** ...labelled stopped, not presumed-gone ***', afterAck && afterAck.agentLeftReason === 'stopped',
      j(afterAck && afterAck.agentLeftReason));
    check('*** ...with a time ***', !!(afterAck && afterAck.agentLeftAt), j(afterAck && afterAck.agentLeftAt));
    // The stop-ack's own fields are what made this exit legible before; they
    // must still be there, or this "fix" traded one record for another.
    check('the stop acknowledgement itself is untouched',
      afterAck && afterAck.stopAck === 'stopped' && !!afterAck.stoppedAt,
      j({ stopAck: afterAck && afterAck.stopAck, stoppedAt: afterAck && afterAck.stoppedAt }));
  });

  // ------------------------------------------------------------- the eviction
  await withServer(FAST, 'seat-release-sweep', async ({ call, get, seat, waitVacated }) => {
    console.log('\nwhat must NOT change - the sweep still evicts and still says presumed-gone');

    const id = await seat('sweep probe', 'GhostCoord');
    const vacated = await waitVacated(id);
    check('the chair is vacated after the vacancy clock', vacated && vacated.agent === null,
      j(vacated && vacated.agent));
    check('...the departed name is kept', vacated && vacated.agentLeft === 'GhostCoord',
      j(vacated && vacated.agentLeft));
    check('...labelled presumed-gone', vacated && vacated.agentLeftReason === 'presumed-gone',
      j(vacated && vacated.agentLeftReason));

    /*
     * THE POINT OF THE WHOLE EXERCISE, stated as one assertion: the two ways a
     * chair empties must not read the same. Compared against the reason a
     * genuine clean exit produced on the other server above, so this cannot
     * pass by both being null.
     */
    check('*** a clean exit and an eviction are distinguishable ***',
      typeof cleanReason === 'string' && cleanReason.length > 0
      && vacated && vacated.agentLeftReason === 'presumed-gone'
      && cleanReason !== vacated.agentLeftReason,
      j({ cleanExit: cleanReason, evicted: vacated && vacated.agentLeftReason }));

    /*
     * The guard a naive fix fails. Releasing a chair that the sweep already
     * emptied must not overwrite the eviction record with a fresh one - the
     * request changes nothing, so it must record nothing.
     */
    console.log('\nwhat must NOT change - releasing an already-empty chair keeps the eviction record');

    const wasAt = vacated && vacated.agentLeftAt;
    const noop = await call('POST', `/conversations/${id}`, { agent: null });
    check('the evicted name is kept', noop.body && noop.body.agentLeft === 'GhostCoord',
      j(noop.body && noop.body.agentLeft));
    check('...the eviction reason is kept', noop.body && noop.body.agentLeftReason === 'presumed-gone',
      j(noop.body && noop.body.agentLeftReason));
    check('...and its timestamp is not rewritten', noop.body && noop.body.agentLeftAt === wasAt,
      j({ before: wasAt, after: noop.body && noop.body.agentLeftAt }));

    const stored = await get(id);
    check('...and the stored record agrees', stored && stored.agentLeftReason === 'presumed-gone',
      j(stored && stored.agentLeftReason));

    console.log('\nwhat must NOT change - a fresh occupant is not swept on sight');

    const seated = await call('POST', `/conversations/${id}`, { agent: 'FreshCoord' });
    check('the seating sticks', seated.body && seated.body.agent === 'FreshCoord',
      j(seated.body && seated.body.agent));
    const rightAfter = await get(id);
    check('...and is still there immediately after', rightAfter && rightAfter.agent === 'FreshCoord',
      j(rightAfter && rightAfter.agent));
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
