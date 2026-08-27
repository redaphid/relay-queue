'use strict';
/*
 * claim-identity-selftest — prove a claimed task is held by SOMEBODY.
 *
 *   node tools/claim-identity-selftest.js
 *
 * THE BUG THIS SUITE EXISTS FOR. `claimTask()` read `body.by` and nothing else.
 * Every other spelling of the same fact — `agent`, `author` — parsed as absent,
 * so a claim that named its owner in plain text was accepted as ANONYMOUS:
 *
 *     POST /tasks/<id>/claim {"agent":"docker-coord2"}
 *     -> 200 OK   {"status":"claimed","claimedBy":null}
 *
 * A success shape over an answer to a different question, which is the same
 * class of defect as the attach route that returned 200 with the seat unfilled.
 * The caller has no way to see it: it asked to claim, it was told 200 claimed.
 *
 * WHY IT MATTERS MORE THAN A COSMETIC NULL. The whole queue keys off
 * `claimedBy`, so an anonymous claim is not a claim with a missing label, it is
 * a seat that reads occupied while nobody is in it:
 *
 *   - The holder cannot renew its own lease. Renewal is `by === task.claimedBy`,
 *     and `"X" === null` is false — so the ONE agent actually doing the work is
 *     told 409 "task is already claimed" about its own task.
 *   - Nobody can be found to chase. `/status` lists it as stuck `claimedBy:null`,
 *     and sweepVacantChairs() can never connect the task to the agent it
 *     vacated, because the task never recorded one.
 *   - It never returns to `pending`, so the nudge, the pending counts and every
 *     agent work poll are all blind to it. The work is simply lost, silently.
 *
 * `resultTask()` already carries a comment noting "four tasks in the live log
 * are `done` with `claimedBy: null`", read at the time as agents answering
 * without claiming. This route manufactures that exact record from agents that
 * DID claim, and named themselves doing it.
 *
 * THE NEGATIVE CHECKS ARE THE POINT. Accepting more spellings is easy; the
 * risk is tightening something that used to work. So this suite also pins:
 *   - a genuinely anonymous claim (no identity field at all) still succeeds,
 *     because resultTask's comment warns explicitly against breaking agents
 *     that work fine without claiming;
 *   - `by` still wins when both are sent, so the canonical field never loses;
 *   - blank and non-string junk still reads as anonymous, not as an agent
 *     literally named "  ".
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

/** Spawns a server on its own scratch dir and port, then always cleans up. */
async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claimid-'));
  const srv = await startServer({ dir, label: 'claim-identity', env });

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

  // A fresh task every time, so no check can inherit another's claim state.
  const newTask = async (label) => {
    const r = await call('POST', '/tasks', { instruction: `claim-identity probe: ${label}`, from: 'selftest' });
    if (!r.body || !r.body.id) throw new Error(`could not create task: ${JSON.stringify(r)}`);
    return r.body.id;
  };

  try {
    await fn({ srv, dir, call, newTask });
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

async function main() {
  console.log('claim-identity-selftest');

  await withServer({}, async ({ call, newTask }) => {
    console.log('\nwho the server thinks is holding the task');

    // The canonical field. This passed before the fix and must keep passing —
    // it is the regression guard on the whole change.
    const t1 = await newTask('by');
    const r1 = await call('POST', `/tasks/${t1}/claim`, { by: 'agent-by' });
    check('`by` is recorded as the holder', r1.body && r1.body.claimedBy === 'agent-by',
      JSON.stringify(r1.body && r1.body.claimedBy));

    /*
     * The bug itself. `agent` is the spelling COORDINATOR.md uses for the same
     * concept on conversations and the one createMessage() already accepts, so
     * it is what an agent reaches for; before the fix this returned 200 with
     * claimedBy null.
     */
    const t2 = await newTask('agent');
    const r2 = await call('POST', `/tasks/${t2}/claim`, { agent: 'agent-agent' });
    check('`agent` is recorded as the holder', r2.body && r2.body.claimedBy === 'agent-agent',
      JSON.stringify(r2.body && r2.body.claimedBy));

    const t3 = await newTask('author');
    const r3 = await call('POST', `/tasks/${t3}/claim`, { author: 'agent-author' });
    check('`author` is recorded as the holder', r3.body && r3.body.claimedBy === 'agent-author',
      JSON.stringify(r3.body && r3.body.claimedBy));

    console.log('\nthe consequences of an anonymous claim');

    /*
     * The sharpest symptom: the agent doing the work is locked out of its own
     * task. Renewal compares `by` to `claimedBy`, so an anonymous claim makes
     * the holder a stranger to the queue for the whole lease.
     */
    const t4 = await newTask('renew');
    await call('POST', `/tasks/${t4}/claim`, { agent: 'renewer' });
    const r4 = await call('POST', `/tasks/${t4}/claim`, { agent: 'renewer' });
    check('the holder can renew its own claim', r4.status === 200,
      `HTTP ${r4.status} ${JSON.stringify(r4.body && r4.body.error)}`);

    /*
     * And the refusal handed to the SECOND agent has to name the first, or the
     * collision it is there to prevent cannot be acted on: "someone holds this"
     * is not a fact anybody can chase.
     */
    const t5 = await newTask('collide');
    await call('POST', `/tasks/${t5}/claim`, { agent: 'first-holder' });
    const r5 = await call('POST', `/tasks/${t5}/claim`, { by: 'second-agent' });
    check('a colliding claim is refused', r5.status === 409, `HTTP ${r5.status}`);
    check('...and the refusal names who holds it', r5.body && r5.body.claimedBy === 'first-holder',
      JSON.stringify(r5.body && r5.body.claimedBy));

    /*
     * A takeover must record where the task came FROM, which is the audit trail
     * for a rescued task. With an anonymous claim that provenance is null: the
     * task was taken from nobody, so nothing records that an agent dropped it.
     */
    const t6 = await newTask('takeover');
    await call('POST', `/tasks/${t6}/claim`, { agent: 'dead-holder' });
    const r6 = await call('POST', `/tasks/${t6}/claim`, { by: 'rescuer' });
    check('a live lease is not stealable', r6.status === 409, `HTTP ${r6.status}`);

    console.log('\nwhat must NOT change');

    /*
     * Deliberately still allowed. resultTask() warns that tightening the claim
     * path risks breaking agents that answer perfectly well without claiming,
     * and breaking those is worse than the collision this fixes.
     */
    const t7 = await newTask('anonymous');
    const r7 = await call('POST', `/tasks/${t7}/claim`, {});
    check('a claim with no identity still succeeds', r7.status === 200, `HTTP ${r7.status}`);
    check('...and is honestly recorded as anonymous', r7.body && r7.body.claimedBy === null,
      JSON.stringify(r7.body && r7.body.claimedBy));

    // `by` is the canonical field and must never lose to an alias.
    const t8 = await newTask('precedence');
    const r8 = await call('POST', `/tasks/${t8}/claim`, { by: 'canonical', agent: 'alias' });
    check('`by` wins when both are sent', r8.body && r8.body.claimedBy === 'canonical',
      JSON.stringify(r8.body && r8.body.claimedBy));

    // Blank is not a name. An agent called "  " would be worse than anonymous,
    // because it would look like a holder in every UI that prints the field.
    const t9 = await newTask('blank');
    const r9 = await call('POST', `/tasks/${t9}/claim`, { agent: '   ' });
    check('a blank name is anonymous, not an agent named "   "',
      r9.body && r9.body.claimedBy === null, JSON.stringify(r9.body && r9.body.claimedBy));

    // Junk types must not crash the route or land in the record.
    const t10 = await newTask('junk');
    const r10 = await call('POST', `/tasks/${t10}/claim`, { agent: { name: 'nope' } });
    check('a non-string name is anonymous, not an object in the record',
      r10.status === 200 && r10.body && r10.body.claimedBy === null,
      `HTTP ${r10.status} ${JSON.stringify(r10.body && r10.body.claimedBy)}`);

    // Surrounding whitespace is trimmed, so "X " and "X" are the same holder
    // rather than two agents who can never renew each other's lease.
    const t11 = await newTask('trim');
    const r11 = await call('POST', `/tasks/${t11}/claim`, { agent: '  spaced  ' });
    check('a padded name is trimmed to the real one',
      r11.body && r11.body.claimedBy === 'spaced', JSON.stringify(r11.body && r11.body.claimedBy));

    console.log('\nthe seat is visible to the rest of the server');

    /*
     * The reason the whole thing matters. An abandoned claim is only findable
     * by asking, and what it is asked FOR is a name. If the record says null,
     * the task is stuck and there is nobody to chase about it.
     */
    const t12 = await newTask('stuck');
    await call('POST', `/tasks/${t12}/claim`, { agent: 'goes-quiet' });
    const st = await call('GET', '/status');
    const row = st.body && Array.isArray(st.body.stuck)
      ? st.body.stuck.find((s) => s.id === t12) : null;
    // With a default lease it is not stuck yet — that is correct, and the check
    // that matters is the claim list, which is what a rescuer actually reads.
    const claimed = await call('GET', `/tasks?status=claimed`);
    const mine = claimed.body && Array.isArray(claimed.body.tasks)
      ? claimed.body.tasks.find((t) => t.id === t12) : null;
    check('a claimed task reports its holder to a rescuer',
      mine && mine.claimedBy === 'goes-quiet',
      JSON.stringify(mine && mine.claimedBy) + (row ? ' (also stuck)' : ''));
  });

  /*
   * Now the same task with the lease set to nothing, so the rescue path runs
   * for real rather than being reasoned about. An expired anonymous claim is
   * the worst case: taken over FROM nobody, so nothing records that an agent
   * dropped it and no name survives for the human to ask about.
   */
  await withServer({ CLAIM_LEASE_MS: '1' }, async ({ call, newTask }) => {
    console.log('\nrescuing an abandoned claim (lease expired)');

    const t = await newTask('rescue');
    await call('POST', `/tasks/${t}/claim`, { agent: 'abandoner' });
    await new Promise((r) => setTimeout(r, 25));
    const taken = await call('POST', `/tasks/${t}/claim`, { by: 'rescuer' });
    check('an expired claim can be taken over', taken.status === 200, `HTTP ${taken.status}`);
    check('...and the takeover records who dropped it',
      taken.body && taken.body.takenOverFrom === 'abandoner',
      JSON.stringify(taken.body && taken.body.takenOverFrom));
    check('...and the rescuer is now the holder',
      taken.body && taken.body.claimedBy === 'rescuer',
      JSON.stringify(taken.body && taken.body.claimedBy));
  });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
