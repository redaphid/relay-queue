'use strict';
/*
 * progress-selftest — prove an agent can say "still working" without spending
 * the one answer it has.
 *
 *   node tools/progress-selftest.js
 *
 * THE BUG THIS SUITE EXISTS FOR. A task accepts exactly one result and posting
 * it closes the task, so an agent in the long middle of a job could either stay
 * silent or end the job early. All of them stayed silent, and every liveness
 * check in the system reads silence as death: in one night the watchdog called
 * three healthy agents dead, a coordinator believed it and started a
 * replacement, and two agents collided in one repo.
 *
 * So the checks that earn their keep are the negative ones, and they are the
 * ones written first here:
 *
 *   - progress must NOT close the task or consume the result slot, however many
 *     times it is posted. If it did, it would be a worse `result`.
 *   - a note must NOT let one agent refresh another agent's lease, or this
 *     endpoint causes the exact collision it was built to prevent.
 *   - a note must STOP vouching once it goes stale, or "working" becomes the
 *     new lie and we have moved the bug rather than fixed it.
 *   - and an unknown event type must replay with NOTHING skipped, because that
 *     is the only thing making a rollback survivable.
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
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawns a server on its own scratch dir and port, then always cleans up. */
async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-progress-'));
  const srv = await startServer({ dir, label: 'progress', env });

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
  const api = async (method, p, body) => (await call(method, p, body)).body;

  try {
    await fn({ srv, dir, api, call, base: () => srv.base });
  } finally {
    await srv.stop();
  }
}

async function main() {
  // ---------------------------------------------------------------- the core
  console.log('\nprogress does not consume the result slot');
  await withServer({}, async (s) => {
    const t = await s.api('POST', '/tasks', { text: 'selftest: a long job', from: 'test' });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'worker' });

    const p1 = await s.call('POST', `/tasks/${t.id}/progress`, { note: 'running the suites', by: 'worker' });
    check('a progress note is accepted', p1.status === 200, JSON.stringify(p1));
    check('...and says the result is still open', p1.body && p1.body.resultStillOpen === true,
      JSON.stringify(p1.body));

    let after = await s.api('GET', `/tasks/${t.id}`);
    check('the task is still claimed, not done', after.status === 'claimed', after.status);
    check('the task still has no result',
      after.result === null || after.result === undefined, JSON.stringify(after.result));

    // The whole point: repeatable. One answer, many notes.
    for (let i = 0; i < 5; i++) {
      const r = await s.call('POST', `/tasks/${t.id}/progress`, { note: `step ${i}`, by: 'worker' });
      if (r.status !== 200) { check(`repeat note ${i} accepted`, false, JSON.stringify(r)); break; }
    }
    after = await s.api('GET', `/tasks/${t.id}`);
    check('six notes later it is STILL claimed', after.status === 'claimed', after.status);
    check('six notes later it STILL has no result',
      after.result === null || after.result === undefined, JSON.stringify(after.result));
    check('the notes are on the record', Array.isArray(after.progress) && after.progress.length === 6,
      JSON.stringify(after.progress && after.progress.length));
    check('the newest note is the last one posted',
      after.progress[after.progress.length - 1].note === 'step 4',
      JSON.stringify(after.progress[after.progress.length - 1]));

    // And the answer still lands normally afterwards.
    const done = await s.call('POST', `/tasks/${t.id}/result`, { result: 'selftest: finished', by: 'worker' });
    check('the result still lands after all those notes', done.status === 200, JSON.stringify(done));
    after = await s.api('GET', `/tasks/${t.id}`);
    check('...and the task is done exactly once', after.status === 'done', after.status);

    const late = await s.call('POST', `/tasks/${t.id}/progress`, { note: 'too late', by: 'worker' });
    check('progress on an answered task is refused', late.status === 409, JSON.stringify(late));

    // A bare ping with no body at all: the degenerate "still here" case.
    const t2 = await s.api('POST', '/tasks', { text: 'selftest: bare ping', from: 'test' });
    await s.api('POST', `/tasks/${t2.id}/claim`, { by: 'worker' });
    const bare = await s.call('POST', `/tasks/${t2.id}/progress`);
    check('a note-less ping is allowed', bare.status === 200, JSON.stringify(bare));
    check('...and stores a null note', bare.body.note === null, JSON.stringify(bare.body));
  });

  // ------------------------------------------------------------- ownership
  console.log('\nprogress cannot be forged by the other agent');
  await withServer({}, async (s) => {
    const t = await s.api('POST', '/tasks', { text: 'selftest: contested', from: 'test' });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'agent-a' });

    const bad = await s.call('POST', `/tasks/${t.id}/progress`, { note: 'me too', by: 'agent-b' });
    check('a note from a non-holder is refused', bad.status === 409, JSON.stringify(bad));
    const after = await s.api('GET', `/tasks/${t.id}`);
    check('...and nothing was written', !after.progress || after.progress.length === 0,
      JSON.stringify(after.progress));

    const ok = await s.call('POST', `/tasks/${t.id}/progress`, { note: 'mine', by: 'agent-a' });
    check('the holder can still post', ok.status === 200, JSON.stringify(ok));
    const anon = await s.call('POST', `/tasks/${t.id}/progress`, { note: 'no name given' });
    check('a note with no `by` is allowed, as on /result', anon.status === 200, JSON.stringify(anon));

    const gone = await s.call('POST', '/tasks/nope-not-a-task/progress', { note: 'x' });
    check('an unknown task is a 404', gone.status === 404, JSON.stringify(gone));
  });

  // ----------------------------------------------------------------- lease
  console.log('\nprogress renews the claim lease');
  await withServer({ CLAIM_LEASE_MS: '2000', STUCK_CLAIM_MS: '2000' }, async (s) => {
    const t = await s.api('POST', '/tasks', { text: 'selftest: leased', from: 'test' });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'holder' });

    await sleep(1400);
    await s.api('POST', `/tasks/${t.id}/progress`, { note: 'still on it', by: 'holder' });
    await sleep(1400); // now past the original lease, but not past the renewed one

    const expired = await s.api('GET', '/tasks?expired=1');
    check('a progressing claim has NOT expired', expired.count === 0, JSON.stringify(expired.tasks));

    const steal = await s.call('POST', `/tasks/${t.id}/claim`, { by: 'thief' });
    check('...so another agent cannot take it over', steal.status === 409, JSON.stringify(steal));
    check('...and is told how long is left',
      steal.body && steal.body.leaseExpiresInSec > 0, JSON.stringify(steal.body));

    // ...but the lease still expires when the notes stop. A renewal that never
    // lapses is just the old forever-claim with extra steps.
    await sleep(2400);
    const expired2 = await s.api('GET', '/tasks?expired=1');
    check('once the notes stop, the lease DOES expire', expired2.count === 1, JSON.stringify(expired2));
  });

  // ---------------------------------------------------------------- /status
  console.log('\n/status tells "working" apart from "silent"');
  await withServer({ STUCK_CLAIM_MS: '1500', CLAIM_LEASE_MS: '1500' }, async (s) => {
    const quiet = await s.api('POST', '/tasks', { text: 'selftest: silent worker', from: 'test' });
    const busy = await s.api('POST', '/tasks', { text: 'selftest: busy worker', from: 'test' });
    await s.api('POST', `/tasks/${quiet.id}/claim`, { by: 'quiet-agent' });
    await s.api('POST', `/tasks/${busy.id}/claim`, { by: 'busy-agent' });

    await sleep(1000);
    await s.api('POST', `/tasks/${busy.id}/progress`, { note: 'regenerating art', by: 'busy-agent' });
    await sleep(1000); // both are now past STUCK_CLAIM_MS since their claim

    const st = await s.api('GET', '/status');
    const ids = (st.stuck || []).map((x) => x.id);
    check('the silent claim is reported stuck', ids.indexOf(quiet.id) >= 0, JSON.stringify(ids));
    check('the PROGRESSING claim is NOT reported stuck', ids.indexOf(busy.id) < 0, JSON.stringify(st.stuck));
    check('exactly one claim is listed as stuck', st.stuck.length === 1, JSON.stringify(st.stuck));
    const w = await s.api('GET', '/watch');
    check('the deadman counts only the silent one', w.stuckCount === 1, String(w.stuckCount));

    // The long-job fact is still legible, rather than being papered over.
    await s.api('POST', `/tasks/${busy.id}/progress`, { note: 'still going', by: 'busy-agent' });
    const claimed = await s.api('GET', '/tasks?status=claimed');
    const row = claimed.tasks.find((x) => x.id === busy.id);
    check('the record carries lastProgressAt for the watchdog to read',
      typeof row.lastProgressAt === 'string', JSON.stringify(row.lastProgressAt));
    check('...and counts every note ever posted', row.progressCount === 2, String(row.progressCount));
  });

  // ------------------------------------------------------------- agentState
  console.log('\nthe conversation reads "working", with the note');
  await withServer({ WAITING_GRACE_MS: '300', PROGRESS_FRESH_MS: '2000' }, async (s) => {
    // The id is the server's to choose, so it is read back rather than assumed.
    const conv = await s.api('POST', '/conversations', { title: 'Progress', agent: 'busy-agent' });
    const t = await s.api('POST', '/tasks', { text: 'selftest: long job', from: 'test', conversationId: conv.id });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'busy-agent' });

    await sleep(900); // past WAITING_GRACE_MS: without a note this would be stalling
    let convs = await s.api('GET', '/conversations');
    let c = convs.conversations.find((x) => x.id === conv.id);
    const silentState = c.agentState.state;
    check('a silent claim past the grace window does NOT read as working',
      silentState !== 'working', silentState);

    await s.api('POST', `/tasks/${t.id}/progress`, { note: 'opening the PR', by: 'busy-agent' });
    convs = await s.api('GET', '/conversations');
    c = convs.conversations.find((x) => x.id === conv.id);
    check('a note makes the conversation read "working"', c.agentState.state === 'working',
      JSON.stringify(c.agentState.state));
    check('...and carries WHAT it is doing', c.agentState.progressNote === 'opening the PR',
      JSON.stringify(c.agentState.progressNote));
    check('...and says so explicitly', c.agentState.progressing === true,
      JSON.stringify(c.agentState.progressing));
    check('...and the lifecycle agrees', c.agentState.lifecycle === 'working',
      JSON.stringify(c.agentState.lifecycle));

    /*
     * THE ONE THAT STOPS THIS BECOMING THE NEXT LIE. A note that vouches
     * forever is a heartbeat wearing a better hat. Once it goes stale the old
     * verdicts must come back exactly as they were.
     */
    // Comfortably past PROGRESS_FRESH_MS. `secSince` rounds to whole seconds, so
    // a margin under half a second is a coin flip rather than a test.
    await sleep(3600);
    convs = await s.api('GET', '/conversations');
    c = convs.conversations.find((x) => x.id === conv.id);
    check('a STALE note stops vouching for the agent', c.agentState.state !== 'working',
      JSON.stringify(c.agentState.state));
    check('...and it reads as trouble again',
      ['stale', 'silent', 'stuck'].indexOf(c.agentState.state) >= 0, c.agentState.state);
  });

  // ------------------------------------------------------- the event log
  console.log('\nthe event log survives everything');
  await withServer({}, async (s) => {
    const t = await s.api('POST', '/tasks', { text: 'selftest: durable', from: 'test' });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'worker' });
    for (let i = 0; i < 25; i++) {
      await s.api('POST', `/tasks/${t.id}/progress`, { note: `note ${i}`, by: 'worker' });
    }
    let after = await s.api('GET', `/tasks/${t.id}`);
    check('the kept notes are capped', after.progress.length === 20, String(after.progress.length));
    check('...at the NEWEST ones', after.progress[after.progress.length - 1].note === 'note 24',
      JSON.stringify(after.progress[after.progress.length - 1]));
    check('...while the count remembers them all', after.progressCount === 25, String(after.progressCount));

    /*
     * ROLLBACK SAFETY, TESTED RATHER THAN ASSERTED. A build that predates the
     * `progress` event must ignore it and replay everything else — that is the
     * whole basis on which deploying this is reversible. An unknown `t` stands
     * in for exactly that case.
     */
    fs.appendFileSync(path.join(s.dir, 'events.jsonl'),
      JSON.stringify({ t: 'an-event-from-the-future', id: t.id, whatever: true }) + '\n');

    await s.srv.restart();
    check('an UNKNOWN event type replays with nothing skipped',
      /events replayed, 0 skipped/.test(s.srv.out), /\(.*skipped\)/.exec(s.srv.out));

    const base = s.srv.base; // the port moves on restart
    after = await (await fetch(`${base}/tasks/${t.id}`)).json();
    check('progress survives a restart', Array.isArray(after.progress) && after.progress.length === 20,
      JSON.stringify(after.progress && after.progress.length));
    check('...with the count intact', after.progressCount === 25, String(after.progressCount));
    check('...and the task is still claimed, still unanswered',
      after.status === 'claimed' && (after.result === null || after.result === undefined),
      `${after.status} / ${JSON.stringify(after.result)}`);
  });

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
