'use strict';
/*
 * seat-lifecycle-selftest - the two things the clear-session control could not
 * tell the human on 2026-08-31, when he used it on the tab "Chores".
 *
 *   node tools/seat-lifecycle-selftest.js
 *
 * GAP 1 - RELAY DID NOT KNOW WHO SPAWNED THE AGENT.
 *
 * The instruction the control generated said, verbatim:
 *
 *     1. Stop PowerSpec if this session spawned it. Relay recorded
 *        spawnedBy=no record.
 *
 * The coordinator reading that HAD spawned PowerSpec, minutes earlier. Nothing
 * anywhere could say so, so the control hedged with "if this session spawned
 * it" and left the one question it exists to answer - is this mine to stop? -
 * to the reader's memory.
 *
 * `spawnedBy` was not missing. It had been on the conversation record since the
 * control shipped, and was null on every conversation this server had ever
 * stored, because the ONLY way to set it was `POST /conversations/<id>
 * {"spawnedBy":...}` - a write no spawner has any reason to make. The call a
 * spawner does make, the documented create-the-tab-and-seat-it-in-one-request
 * spawn moment, could not carry the field at all. So the field existed, the
 * route existed, and the two never met.
 *
 * GAP 2 - STOPPING AN AGENT SILENTLY STRANDED WHAT IT HELD.
 *
 * PowerSpec was holding TWO claimed tasks when it was stopped. A claim with no
 * result is invisible to every future poll - it is not `pending`, so it is
 * never offered again, and from everywhere except an explicit `?status=claimed`
 * it reads exactly like an answered one. Both of the human's questions would
 * have looked answered and never been picked up. It was caught only because
 * the coordinator running the clear happened to check by hand first; the
 * instruction said nothing, because nothing in the API told it there was
 * anything to say.
 *
 * WHAT IS DELIBERATELY NOT FIXED, and is asserted here so a later change cannot
 * quietly do it:
 *   - nothing is auto-released. An unanswerable claim is a real signal, and
 *     leaseOf() already lets another agent take a lapsed claim over. What was
 *     missing was never a mechanism to recover one - it was anyone being told
 *     there was one to recover.
 *   - nothing is verified. This server never witnesses a spawn; it only ever
 *     receives a claim about one. `spawnedBySource` says which shape of call
 *     carried the claim, and `spawnOrigin.verified` is a constant false.
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
  console.log(`  FAIL ${name}${detail === undefined ? '' : ' - ' + detail}`);
}
const j = (v) => JSON.stringify(v === undefined ? null : v);
/*
 * The shape a server WITHOUT this feature effectively answers with. Substituted
 * so every check still runs and reports on such a server: a red proof that
 * throws half way through only proves the half it reached.
 */
const EMPTY = { count: -1, byAgent: [], unheld: [], truncated: false, summary: null, detail: null };

/*
 * An hour-long vacancy clock. Every case here seats an agent and then does two
 * or three more requests against it, and each of those runs sweepVacantChairs()
 * synchronously; with a short clock the sweep would evict the occupant mid-case
 * and the suite would be measuring the sweep while claiming to measure a seat.
 */
const SLOW = { CHAIR_VACANT_MS: String(60 * 60 * 1000), WATCH_TICK_MS: '250' };

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seatlife-'));
  const srv = await startServer({ dir, label: 'seat-lifecycle', env: SLOW });

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
  const make = async (body) => {
    const made = await call('POST', '/conversations', body);
    if (made.status !== 201 || !made.body || !made.body.id) {
      throw new Error(`could not create a conversation: HTTP ${made.status} ${j(made.body)}`);
    }
    return made.body;
  };
  /** A task in a conversation, claimed by `by` (null = claimed by nobody). */
  const task = async (conversationId, text, by) => {
    const made = await call('POST', '/tasks', { conversationId, text });
    if (made.status !== 201 || !made.body || !made.body.id) {
      throw new Error(`could not post a task: HTTP ${made.status} ${j(made.body)}`);
    }
    const id = made.body.id;
    if (by !== undefined) {
      /*
       * `by: null` claims for NOBODY, via the bodyless claim the server
       * deliberately still supports. That is not a contrived case: claimTask()
       * accepts an anonymous claim on purpose, so `claimedBy: null` with no
       * result is a state the live queue can and does reach - and it is
       * invisible in exactly the same way a held one is, while belonging to no
       * agent any stop control could ask about.
       */
      const c = by === null
        ? await call('POST', `/tasks/${id}/claim`)
        : await call('POST', `/tasks/${id}/claim`, { by });
      if (c.status !== 200) throw new Error(`could not claim ${id}: HTTP ${c.status} ${j(c.body)}`);
    }
    return id;
  };

  try {
    await fn({ srv, dir, call, get, make, task });
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

/*
 * THE HALF THE HUMAN ACTUALLY READS.
 *
 * Everything above proves the server can answer the two questions. It cannot
 * prove the instruction the control generates asks them - and the instruction
 * is the whole artefact: on 2026-08-31 the server had `spawnedBy` and the text
 * still said "no record", because nothing joined the two up.
 *
 * So the two composing functions are lifted OUT of the shipped page and run
 * directly, rather than reimplemented here. A copy of them in this file would
 * pass forever while the page said something else.
 */
function uiFragments() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const from = html.indexOf('function spawnLine(');
    const to = html.indexOf('function tabSet(');
    if (from < 0 || to <= from) return null;
    // eslint-disable-next-line no-new-func
    return new Function('tabId', html.slice(from, to)
      + '\nreturn { spawnLine: spawnLine, heldLines: heldLines };')('mti8xjrt-0kx7qa');
  } catch {
    return null;
  }
}

async function main() {
  console.log('seat-lifecycle-selftest');

  await withServer(async ({ call, get, make, task }) => {
    // ------------------------------------------------ gap 1: who spawned it
    console.log('\ngap 1 - the create-and-seat call, which is the actual spawn moment, records the spawner');

    const born = await make({ title: 'spawn at birth', agent: 'ChildCoord', spawnedBy: 'ParentCoord' });
    check('*** spawnedBy survives the create call ***', born.spawnedBy === 'ParentCoord', j(born.spawnedBy));
    check('*** and is stamped with a time ***', !!born.spawnedByAt, j(born.spawnedByAt));
    check('*** and says HOW it was learned, not just what ***',
      born.spawnedBySource === 'asserted', j(born.spawnedBySource));

    // The reply is not the record. This route has answered 200 with a field it
    // did not store before; the stored object is read back every time.
    const bornBack = await get(born.id);
    check('*** the STORED record agrees, not just the 201 ***',
      bornBack && bornBack.spawnedBy === 'ParentCoord' && bornBack.spawnedBySource === 'asserted',
      j({ by: bornBack && bornBack.spawnedBy, src: bornBack && bornBack.spawnedBySource }));

    console.log('\n  ...and naming a spawner while seating nobody is refused, not quietly dropped');
    const nobody = await call('POST', '/conversations', { title: 'seats nobody', spawnedBy: 'ParentCoord' });
    check('*** a spawner with no agent is a 400 ***', nobody.status === 400, `HTTP ${nobody.status} ${j(nobody.body)}`);

    console.log('\ngap 1 - an /activity "spawned" row is a FIRST-PERSON declaration, and is recorded as one');

    const seat = await make({ title: 'declared spawn', agent: 'WorkerCoord' });
    const act = await call('POST', `/conversations/${seat.id}/activity`, {
      kind: 'spawned', agent: 'BossCoord', subagent: 'WorkerCoord', task: 'do the thing',
    });
    check('the activity row is accepted', act.status === 201, `HTTP ${act.status} ${j(act.body)}`);
    check('*** the row reports that it recorded a spawner ***',
      !!(act.body && act.body.spawnRecorded && act.body.spawnRecorded.spawnedBy === 'BossCoord'),
      j(act.body && act.body.spawnRecorded));
    const seatBack = await get(seat.id);
    check('*** the seat now names the spawner ***', seatBack && seatBack.spawnedBy === 'BossCoord',
      j(seatBack && seatBack.spawnedBy));
    check('*** as DECLARED - the reporter named itself, about the agent in this seat ***',
      seatBack && seatBack.spawnedBySource === 'declared', j(seatBack && seatBack.spawnedBySource));

    console.log('\n  ...but only about the agent actually sitting here');
    const other = await make({ title: 'someone elses child', agent: 'SittingCoord' });
    await call('POST', `/conversations/${other.id}/activity`, {
      kind: 'spawned', agent: 'BossCoord', subagent: 'SomebodyElse',
    });
    const otherBack = await get(other.id);
    check('*** a row about a non-occupant records nothing ***',
      otherBack && otherBack.spawnedBy === null, j(otherBack && otherBack.spawnedBy));

    console.log('\n  ...and a "finished" row is not a spawn declaration');
    const fin = await make({ title: 'finished is not spawned', agent: 'EndingCoord' });
    await call('POST', `/conversations/${fin.id}/activity`, {
      kind: 'finished', agent: 'BossCoord', subagent: 'EndingCoord', ok: true,
    });
    const finBack = await get(fin.id);
    check('*** finished records no spawner ***', finBack && finBack.spawnedBy === null,
      j(finBack && finBack.spawnedBy));

    console.log('\ngap 1 - the two sources are told apart, and NEITHER is presented as verified');

    const org = (await get(seat.id)).spawnOrigin;
    check('*** the single-conversation read carries the origin paragraph ***', !!org, j(org));
    check('*** which says declared ***', org && org.source === 'declared', j(org && org.source));
    check('*** and says, in the payload, that it is not verified ***', org && org.verified === false,
      j(org && org.verified));
    check('*** and the wording does not promise a kill ***',
      org && /did not witness/i.test(org.detail || ''), j(org && org.detail));

    const orgAsserted = (await get(born.id)).spawnOrigin;
    check('*** an asserted record says relay does not know who sent it ***',
      orgAsserted && /does not know who/i.test(orgAsserted.detail || ''), j(orgAsserted && orgAsserted.detail));
    check('*** and is equally unverified ***', orgAsserted && orgAsserted.verified === false,
      j(orgAsserted && orgAsserted.verified));

    const orgNone = (await get(other.id)).spawnOrigin;
    check('*** no record reads as no record, not as safe ***',
      orgNone && orgNone.by === null && orgNone.source === null && /no record/i.test(orgNone.summary || ''),
      j(orgNone));

    console.log('\n  ...a conversation write can never mint the stronger word');
    const forged = await call('POST', `/conversations/${born.id}`, { spawnedBy: 'LiarCoord', spawnedBySource: 'declared' });
    check('*** a caller-supplied source is ignored; the write is "asserted" ***',
      forged.body && forged.body.spawnedBySource === 'asserted', j(forged.body && forged.body.spawnedBySource));

    // -------------------------------------- gap 1: what must NOT change
    console.log('\nwhat must NOT change - the spawn record still describes the CURRENT occupant only');

    const reseated = await call('POST', `/conversations/${seat.id}`, { agent: 'ReplacementCoord' });
    check('a new occupant drops the previous one\'s spawner',
      reseated.body && reseated.body.spawnedBy === null, j(reseated.body && reseated.body.spawnedBy));
    check('...and the provenance goes with it, rather than vouching for a null',
      reseated.body && reseated.body.spawnedByAt === null && reseated.body.spawnedBySource === null,
      j({ at: reseated.body && reseated.body.spawnedByAt, src: reseated.body && reseated.body.spawnedBySource }));

    const keep = await make({ title: 'no-op reassert', agent: 'SameCoord', spawnedBy: 'ParentCoord' });
    const same = await call('POST', `/conversations/${keep.id}`, { agent: 'SameCoord' });
    check('re-asserting the same name is still a no-op and keeps the record',
      same.body && same.body.spawnedBy === 'ParentCoord', j(same.body && same.body.spawnedBy));

    const detached = await call('POST', `/conversations/${keep.id}`, { agent: null, agentLeftReason: 'done' });
    check('detaching drops the spawner, because it described the agent that left',
      detached.body && detached.body.spawnedBy === null && detached.body.spawnedBySource === null,
      j({ by: detached.body && detached.body.spawnedBy, src: detached.body && detached.body.spawnedBySource }));
    check('...and the seat-release notice is untouched by any of this',
      detached.body && detached.body.agentLeft === 'SameCoord' && detached.body.agentLeftReason === 'done',
      j({ left: detached.body && detached.body.agentLeft, why: detached.body && detached.body.agentLeftReason }));

    const bad = await call('POST', `/conversations/${keep.id}`, { spawnedBy: 42 });
    check('a non-string spawner is still a 400', bad.status === 400, `HTTP ${bad.status} ${j(bad.body)}`);

    // ------------------------------------- gap 2: what a stop would strand
    console.log('\ngap 2 - asking an agent to stop reports the claims it is holding');

    const hold = await make({ title: 'holding two', agent: 'PowerSpec' });
    const t1 = await task(hold.id, 'first question he asked', 'PowerSpec');
    const t2 = await task(hold.id, 'second question he asked', 'PowerSpec');
    await task(hold.id, 'still waiting, nobody took it');            // pending: not held
    const answered = await task(hold.id, 'this one was answered', 'PowerSpec');
    await call('POST', `/tasks/${answered}/result`, { result: 'done', by: 'PowerSpec' });

    const stop = await call('POST', `/conversations/${hold.id}`, { stopRequested: true, stopRequestedBy: 'human (clear session)' });
    const held = stop.body && stop.body.stopRequestEffect && stop.body.stopRequestEffect.heldTasks;
    check('*** the stop reply reports what would be stranded ***', !!held, j(stop.body && stop.body.stopRequestEffect));
    check('*** both unanswered claims are counted ***', held && held.count === 2, j(held && held.count));
    check('*** and named, so they can be reassigned rather than guessed at ***',
      held && held.byAgent.length === 2
      && held.byAgent.some((x) => x.id === t1) && held.byAgent.some((x) => x.id === t2),
      j(held && held.byAgent.map((x) => x.id)));
    check('*** the answered one is excluded - the test is "no result", not "status claimed" ***',
      held && !held.byAgent.some((x) => x.id === answered), j(held && held.byAgent.map((x) => x.id)));
    check('*** a pending task is not reported as held ***', held && held.count === 2, j(held && held.count));
    check('*** each row says whether anyone else could take it over yet ***',
      held && held.byAgent.every((x) => typeof x.leaseExpired === 'boolean' && typeof x.leaseExpiresInSec === 'number'),
      j(held && held.byAgent));
    check('*** the summary says stopping does not release them ***',
      held && /does not release/i.test(held.summary || ''), j(held && held.summary));
    check('*** and the detail says why they would never resurface ***',
      held && /invisible|never be offered/i.test(held.detail || ''), j(held && held.detail));

    console.log('\n  ...an ownerless claim is surfaced too, but never attributed to the agent');
    const orphan = await task(hold.id, 'claimed by nobody at all', null);
    const stop2 = await call('POST', `/conversations/${hold.id}`, { stopRequested: true });
    const held2 = stop2.body && stop2.body.stopRequestEffect && stop2.body.stopRequestEffect.heldTasks;
    check('*** it appears under unheld ***',
      held2 && held2.unheld.some((x) => x.id === orphan), j(held2 && held2.unheld.map((x) => x.id)));
    check('*** and NOT under the agent, which never claimed it ***',
      held2 && !held2.byAgent.some((x) => x.id === orphan), j(held2 && held2.byAgent.map((x) => x.id)));
    check('*** with claimedBy reported as null rather than filled in ***',
      held2 && held2.unheld.every((x) => x.claimedBy === null), j(held2 && held2.unheld));

    console.log('\n  ...a claim held by a DIFFERENT live agent is left alone');
    const foreign = await task(hold.id, 'somebody elses live work', 'OtherCoord');
    const stop3 = await call('POST', `/conversations/${hold.id}`, { stopRequested: true });
    const held3 = (stop3.body.stopRequestEffect && stop3.body.stopRequestEffect.heldTasks) || EMPTY;
    check('*** it is in neither list, so nobody is invited to take live work ***',
      !held3.byAgent.some((x) => x.id === foreign) && !held3.unheld.some((x) => x.id === foreign),
      j({ mine: held3.byAgent.map((x) => x.id), unheld: held3.unheld.map((x) => x.id) }));

    console.log('\n  ...and another tab\'s claims are never counted against this seat');
    const elsewhere = await make({ title: 'a different tab', agent: 'PowerSpec' });
    await task(elsewhere.id, 'held over there', 'PowerSpec');
    const again = await call('POST', `/conversations/${hold.id}`, { stopRequested: true });
    const heldAgain = (again.body.stopRequestEffect && again.body.stopRequestEffect.heldTasks) || EMPTY;
    check('*** the count is unchanged by a claim in another conversation ***',
      heldAgain.count === held3.count && held3.count > 0,
      j({ before: held3.count, after: heldAgain.count }));

    console.log('\ngap 2 - zero is an answer, said out loud');
    const clean = await make({ title: 'holding nothing', agent: 'TidyCoord' });
    const cleanStop = await call('POST', `/conversations/${clean.id}`, { stopRequested: true });
    const none = cleanStop.body.stopRequestEffect && cleanStop.body.stopRequestEffect.heldTasks;
    check('*** an empty result is still an object, not a missing field ***', !!none, j(none));
    check('*** count is zero ***', none && none.count === 0, j(none && none.count));
    check('*** and it SAYS nothing is stranded, rather than saying nothing ***',
      none && /strands no questions/i.test(none.summary || ''), j(none && none.summary));

    console.log('\ngap 2 - archiving a tab reports the same thing, because it strands the same claims');
    const arch = await call('POST', `/conversations/${hold.id}`, { archived: true });
    check('*** the ghost warning carries the held claims ***',
      !!(arch.body && arch.body.ghost && arch.body.ghost.heldTasks), j(arch.body && arch.body.ghost));
    const archHeld = (arch.body && arch.body.ghost && arch.body.ghost.heldTasks) || EMPTY;
    check('*** with the same count the stop request reported ***',
      archHeld.count === held3.count && held3.count > 0,
      j({ stop: held3.count, archive: archHeld.count }));

    console.log('\ngap 2 - the manage panel can read it without asking to stop anything first');
    const panel = await get(elsewhere.id);
    check('*** the single-conversation read carries heldTasks ***', !!(panel && panel.heldTasks), j(panel && panel.heldTasks));
    check('*** and it counts the one claim in that tab ***',
      !!(panel && panel.heldTasks && panel.heldTasks.count === 1),
      j(panel && panel.heldTasks));

    // ------------------------------------- gap 2: what must NOT change
    console.log('\nwhat must NOT change - NOTHING is released. Surfacing a claim is not cancelling it');

    const t1After = (await call('GET', `/tasks/${t1}`)).body;
    check('the claim is still claimed', t1After && t1After.status === 'claimed', j(t1After && t1After.status));
    check('...still held by the same agent', t1After && t1After.claimedBy === 'PowerSpec', j(t1After && t1After.claimedBy));
    check('...and still has no result, which is the signal, not the bug',
      t1After && (t1After.result === null || t1After.result === undefined), j(t1After && t1After.result));

    const orphanAfter = (await call('GET', `/tasks/${orphan}`)).body;
    check('an ownerless claim is not auto-adopted either',
      orphanAfter && orphanAfter.status === 'claimed' && orphanAfter.claimedBy === null,
      j({ status: orphanAfter && orphanAfter.status, by: orphanAfter && orphanAfter.claimedBy }));

    console.log('\nwhat must NOT change - the stop paragraph still refuses to claim a kill');
    const eff = cleanStop.body.stopRequestEffect;  // present on every build
    check('stopping is still reported as a request, not a stop', eff && eff.stopped === false, j(eff && eff.stopped));
    check('...and still names where the real kill switch is',
      eff && eff.forceKill && eff.forceKill.availableHere === false
      && /top-level Claude session/.test(eff.forceKill.how), j(eff && eff.forceKill));
  });

  // ------------------------------------------ the instruction the human reads
  console.log('\nthe generated instruction says both things, in the page itself');

  const ui = uiFragments();
  check('*** the page composes the spawn and held-claim lines ***', !!ui,
    'public/index.html defines neither spawnLine nor heldLines');

  const noRecord = ui ? ui.spawnLine({ agent: 'PowerSpec' }, 'PowerSpec') : '';
  check('*** with no record it says so, and does not go quiet ***',
    /NO record/i.test(noRecord) && /does not guess/i.test(noRecord), j(noRecord));

  const declaredLine = ui ? ui.spawnLine({ spawnedBy: 'RelayCoord', spawnedBySource: 'declared' }, 'PowerSpec') : '';
  check('*** a declared record says who reported it ***',
    /RelayCoord/.test(declaredLine) && /reported itself/i.test(declaredLine), j(declaredLine));

  const assertedLine = ui ? ui.spawnLine({ spawnedBy: 'RelayCoord', spawnedBySource: 'asserted' }, 'PowerSpec') : '';
  check('*** an asserted one is called a lead, not proof ***',
    /a lead, not proof/i.test(assertedLine), j(assertedLine));

  const lines = ui ? ui.heldLines({
    count: 2,
    summary: '2 tasks are claimed here with no result',
    detail: 'A claim with no result is invisible to every future poll',
    byAgent: [{ id: 'mtiaaaa-1', claimedBy: 'PowerSpec', heldForSec: 900, leaseExpired: false, leaseExpiresInSec: 60, text: 'first question' }],
    unheld: [{ id: 'mtiaaaa-2', claimedBy: null, heldForSec: 3600, leaseExpired: true, leaseExpiresInSec: 0, text: 'second question' }],
    truncated: false,
  }).join('\n') : '';
  check('*** the instruction leads with what would be stranded ***',
    /BEFORE YOU STOP IT/.test(lines), j(lines));
  check('*** and names every task, so none is left to be remembered ***',
    /mtiaaaa-1/.test(lines) && /mtiaaaa-2/.test(lines), j(lines));
  check('*** an ownerless claim is shown as held by nobody, not by the agent ***',
    /NOBODY/.test(lines) && !/by null/.test(lines), j(lines));
  check('*** and each says whether it can be taken over yet ***',
    /lease EXPIRED/.test(lines) && /min left/.test(lines), j(lines));
  check('*** nothing is added when nothing is held ***',
    !!ui && ui.heldLines({ count: 0 }).length === 0 && ui.heldLines(null).length === 0);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
