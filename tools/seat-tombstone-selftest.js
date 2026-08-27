'use strict';
/*
 * seat-tombstone-selftest — prove a refilled chair stops advertising a vacancy.
 *
 *   node tools/seat-tombstone-selftest.js
 *
 * THE BUG THIS SUITE EXISTS FOR. sweepVacantChairs() vacates a chair by writing
 * `agent: null` and keeping the departed name in `agentLeft` / `agentLeftAt` /
 * `agentLeftReason` — deliberately, because "PushCoord, presumed gone" is a more
 * useful thing to read than an empty chair with no history.
 *
 * Nothing ever cleared it again. So the moment a new agent sat down, the
 * conversation asserted two contradictory things at once:
 *
 *     "agent":            "coordinator"          <- seated, working right now
 *     "agentLeft":        "coordinator"
 *     "agentLeftReason":  "presumed-gone"        <- and also gone, hours ago
 *
 * That is the live record from `main` on 2026-08-27, where the same NAME
 * occupied both fields because a second agent reused it. A reader cannot tell
 * from that whether the agent in the chair is the one presumed gone, and on
 * 2026-08-27 it cost a real investigation: the stale tombstone was read as
 * proof that the sweep had FAILED to release the seat, when the event log shows
 * it had worked perfectly and the chair had simply been refilled since.
 *
 * THE PRECEDENT THIS FOLLOWS. updateConversation() already clears the previous
 * occupant's STOP state on a genuine change of occupant, for exactly this
 * reason, and says so: an agent that arrives must not wear the last round's
 * badge. `agentLeft*` is the same defect in the same block; it was simply never
 * added to the list.
 *
 * WHAT MUST NOT CHANGE, and these are the checks that carry the risk:
 *   - the sweep must still WRITE the tombstone. If this suite passed by the
 *     sweep quietly doing nothing, it would be measuring nothing at all — so
 *     the tombstone is asserted present before it is asserted gone.
 *   - an explicit unassign (`agent: null`) must KEEP it. That is the one state
 *     where an empty chair with history is the whole point, and it matches how
 *     the neighbouring stop-state block already draws the same line.
 *   - a newly seated agent must not be swept on sight (the `agentSince` guard).
 *
 * Nothing is lost by clearing it: every seat change is an event in
 * events.jsonl, which is where this history is actually reconstructable — and
 * is where it was reconstructed to diagnose this.
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

/*
 * A short vacancy clock and a fast tick, so the REAL sweep runs rather than a
 * hand-written imitation of it. Seeding the tombstone directly would test this
 * suite's idea of the sweep instead of the sweep.
 */
const CHAIR_VACANT_MS = 1200;
const ENV = { CHAIR_VACANT_MS: String(CHAIR_VACANT_MS), WATCH_TICK_MS: '100' };

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tomb-'));
  const srv = await startServer({ dir, label: 'seat-tombstone', env: ENV });

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

  /** Waits for the sweep to actually fire, rather than assuming a sleep was enough. */
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
    await fn({ srv, dir, call, get, waitVacated });
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

async function main() {
  console.log('seat-tombstone-selftest');

  await withServer(async ({ call, get, waitVacated }) => {
    console.log('\nthe sweep still records who left (this must hold, or nothing below means anything)');

    const made = await call('POST', '/conversations', { title: 'tombstone probe', agent: 'GhostCoord' });
    const id = made.body && made.body.id;
    check('a conversation can be created with an agent', made.status === 201 && !!id,
      `HTTP ${made.status}`);

    const vacated = await waitVacated(id);
    check('the chair is vacated after the vacancy clock', vacated && vacated.agent === null,
      JSON.stringify(vacated && vacated.agent));
    check('...and the departed name is kept', vacated && vacated.agentLeft === 'GhostCoord',
      JSON.stringify(vacated && vacated.agentLeft));
    check('...labelled presumed-gone', vacated && vacated.agentLeftReason === 'presumed-gone',
      JSON.stringify(vacated && vacated.agentLeftReason));
    check('...with a time', !!(vacated && vacated.agentLeftAt), JSON.stringify(vacated && vacated.agentLeftAt));

    console.log('\na new occupant does not inherit the last one`s vacancy notice');

    const seated = await call('POST', `/conversations/${id}`, { agent: 'FreshCoord' });
    check('the new agent is seated', seated.body && seated.body.agent === 'FreshCoord',
      JSON.stringify(seated.body && seated.body.agent));
    /*
     * The bug, stated three ways, because all three fields are read by
     * different things and leaving any one behind keeps the contradiction.
     */
    check('*** the vacancy notice is cleared ***', seated.body && seated.body.agentLeft === null,
      JSON.stringify(seated.body && seated.body.agentLeft));
    check('*** ...and its reason ***', seated.body && seated.body.agentLeftReason === null,
      JSON.stringify(seated.body && seated.body.agentLeftReason));
    check('*** ...and its timestamp ***', seated.body && seated.body.agentLeftAt === null,
      JSON.stringify(seated.body && seated.body.agentLeftAt));

    // The read-back matters separately from the reply: the reply could be right
    // while the stored record stays wrong, and the stored record is what the
    // tab list, the watchdog and every agent poll actually read.
    const back = await get(id);
    check('...and the STORED record agrees, not just the reply',
      back && back.agent === 'FreshCoord' && back.agentLeft === null,
      JSON.stringify({ agent: back && back.agent, agentLeft: back && back.agentLeft }));

    // Regression guard on the fix that came before this one: a freshly seated
    // agent gets the full clock, and must not be evicted on sight.
    check('...and the new agent is not swept on sight', back && back.agent === 'FreshCoord',
      JSON.stringify(back && back.agent));

    console.log('\nwhat must NOT change');

    const vacated2 = await waitVacated(id);
    check('the new agent is eventually swept too, on its own clock',
      vacated2 && vacated2.agent === null && vacated2.agentLeft === 'FreshCoord',
      JSON.stringify({ agent: vacated2 && vacated2.agent, left: vacated2 && vacated2.agentLeft }));

    /*
     * An explicit unassign KEEPS the history. This is the line the neighbouring
     * stop-state block already draws, and the one case where an empty chair with
     * a name on it is exactly what should be read.
     */
    const un = await call('POST', `/conversations/${id}`, { agent: null });
    check('an explicit unassign keeps who left', un.body && un.body.agentLeft === 'FreshCoord',
      JSON.stringify(un.body && un.body.agentLeft));
    check('...and keeps the reason', un.body && un.body.agentLeftReason === 'presumed-gone',
      JSON.stringify(un.body && un.body.agentLeftReason));

    /*
     * Re-asserting the same name is a no-op everywhere else in this block and
     * must stay one here: repeating a PATCH must not have side effects.
     */
    const seatA = await call('POST', `/conversations/${id}`, { agent: 'SameCoord' });
    check('seating clears the notice again', seatA.body && seatA.body.agentLeft === null,
      JSON.stringify(seatA.body && seatA.body.agentLeft));
    const sinceA = seatA.body && seatA.body.agentSince;
    const seatB = await call('POST', `/conversations/${id}`, { agent: 'SameCoord' });
    check('re-asserting the same name is still a no-op',
      seatB.body && seatB.body.agentSince === sinceA,
      JSON.stringify({ before: sinceA, after: seatB.body && seatB.body.agentSince }));

    /*
     * A title-only PATCH says nothing about the chair and must not touch it.
     * Without this, "clear it whenever anything is written" would pass every
     * check above while quietly erasing history on an unrelated edit.
     */
    await waitVacated(id);
    const titled = await call('POST', `/conversations/${id}`, { title: 'renamed, nothing to do with seats' });
    check('a title-only edit leaves the vacancy notice alone',
      titled.body && titled.body.agentLeft === 'SameCoord',
      JSON.stringify(titled.body && titled.body.agentLeft));
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
