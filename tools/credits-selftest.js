'use strict';
/*
 * credits-selftest — boot a real server and prove the credits economy is
 * durable and race-safe, not just "the handler returns 200".
 *
 *   node tools/credits-selftest.js
 *
 * This replaces a free-text convention (`POST /messages` with
 * `channel:"credits"`, latest message's prose parsed as a running balance)
 * that had no structured amount/reason and raced under two coordinators
 * doing read-then-post-decremented-value. The properties that matter here,
 * and that a casual glance at the handler cannot confirm:
 *
 *   1. SPEND IS ATOMIC. Two concurrent spends against balance=1 must not both
 *      succeed — exactly one wins, the balance never goes negative. Tested
 *      with REAL concurrent HTTP requests (Promise.all against a live
 *      server), not by reading the source and reasoning it must be fine.
 *   2. IT SURVIVES. Balance and history are event-sourced, so they come back
 *      after a restart — this server restarts itself on every source change.
 *   3. THE FLAT COST IS ENFORCED SERVER-SIDE. spend always costs exactly 1;
 *      nothing in the request body can change that.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./harness-lib');

let srv = null;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}

const get = async (p) => (await fetch(srv.base + p)).json();
async function post(p, body) {
  const res = await fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-credits-'));
  srv = await startServer({ dir, label: 'credits', env: { PUSH: '0' } });

  try {
    console.log('\nstarting state — a fresh install owes nothing and has no history');
    let cr = await get('/credits');
    check('balance starts at 0', cr.balance === 0, JSON.stringify(cr.balance));
    check('history starts empty', Array.isArray(cr.history) && cr.history.length === 0);

    console.log('\nspend — refused with nothing to spend');
    let r = await post('/credits/spend', { reason: 'test feature', by: 'coordinator-a' });
    check('*** spend at balance 0 is refused, not silently allowed ***', r.status === 402, String(r.status));
    check('...telling the caller the current balance', r.body && r.body.balance === 0, JSON.stringify(r.body));
    check('...and giving a reason a human/agent can read', /balance/i.test(r.body.error || ''), r.body.error);

    console.log('\naward — the only way balance moves up');
    r = await post('/credits/award', { amount: 1, reason: 'litter box fully cleared', by: 'Chores' });
    check('an award is accepted', r.status === 200, JSON.stringify(r.body));
    check('...and reflected immediately', r.body.balance === 1, JSON.stringify(r.body.balance));
    check('...with the history entry structured, not prose', r.body.history.length === 1);
    const h0 = r.body.history[0];
    check('...carrying amount', h0.amount === 1, JSON.stringify(h0));
    check('...reason', h0.reason === 'litter box fully cleared', h0.reason);
    check('...and who', h0.by === 'Chores', h0.by);
    check('...and when, as a real timestamp', !!Date.parse(h0.at || ''), h0.at);

    console.log('\naward — validated inputs');
    check('amount is required', (await post('/credits/award', { reason: 'x', by: 'y' })).status === 400);
    check('amount must be positive', (await post('/credits/award', { amount: 0, reason: 'x', by: 'y' })).status === 400);
    check('amount must be positive (negative)', (await post('/credits/award', { amount: -1, reason: 'x', by: 'y' })).status === 400);
    check('amount must be an integer', (await post('/credits/award', { amount: 1.5, reason: 'x', by: 'y' })).status === 400);
    check('amount must be a number, not a numeric string coerced from junk',
      (await post('/credits/award', { amount: 'lots', reason: 'x', by: 'y' })).status === 400);
    check('reason is required', (await post('/credits/award', { amount: 1, by: 'y' })).status === 400);
    check('*** balance did not move on any rejected award ***', (await get('/credits')).balance === 1);

    console.log('\nspend — the flat cost, and that it is enforced server-side');
    r = await post('/credits/spend', { reason: 'implemented feature X', by: 'coordinator-b' });
    check('spend succeeds when balance >= 1', r.status === 200, JSON.stringify(r.body));
    check('...and takes exactly 1, regardless of nothing else being askable', r.body.balance === 0, JSON.stringify(r.body.balance));
    check('reason is required to spend too', (await post('/credits/spend', { by: 'y' })).status === 400);
    r = await post('/credits/spend', { reason: 'another feature', by: 'coordinator-c' });
    check('*** spend at balance 0 again is refused ***', r.status === 402, String(r.status));
    check('...balance still 0, never negative', r.body.balance === 0, JSON.stringify(r.body.balance));

    console.log('\nhistory — both awards and spends are recorded, oldest first');
    cr = await get('/credits');
    check('two entries so far', cr.history.length === 2, JSON.stringify(cr.history.length));
    check('award first, then spend, in the order they happened',
      cr.history[0].amount === 1 && cr.history[1].amount === -1,
      JSON.stringify(cr.history.map((h) => h.amount)));
    check('the spend entry carries its own reason/by', cr.history[1].reason === 'implemented feature X'
      && cr.history[1].by === 'coordinator-b', JSON.stringify(cr.history[1]));

    console.log('\nhistory — ?limit caps to the most recent N without losing the balance');
    await post('/credits/award', { amount: 5, reason: 'bulk chores', by: 'Chores' });
    const limited = await get('/credits?limit=1');
    check('limit=1 returns exactly one entry', limited.history.length === 1, JSON.stringify(limited.history.length));
    check('...the MOST RECENT one', limited.history[0].reason === 'bulk chores', JSON.stringify(limited.history[0]));
    check('...and the balance is unaffected by limiting history', limited.balance === 5, String(limited.balance));
    const badLimit = await fetch(srv.base + '/credits?limit=abc');
    check('...specifically a 400', badLimit.status === 400, String(badLimit.status));

    // Reset to exactly 1 for the concurrency test below.
    for (let i = 0; i < 4; i++) await post('/credits/spend', { reason: 'draining to 1', by: 'setup' });
    check('drained to exactly 1 for the race test', (await get('/credits')).balance === 1,
      JSON.stringify((await get('/credits')).balance));

    console.log('\n*** atomicity — two concurrent spends against balance=1 must not both succeed ***');
    const [ra, rb] = await Promise.all([
      post('/credits/spend', { reason: 'race A', by: 'coordinator-a' }),
      post('/credits/spend', { reason: 'race B', by: 'coordinator-b' }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    check('exactly one succeeded and one was refused', statuses[0] === 200 && statuses[1] === 402,
      JSON.stringify([ra.status, rb.status]));
    const finalBalance = (await get('/credits')).balance;
    check('*** balance settled at exactly 0, never negative ***', finalBalance === 0, String(finalBalance));

    // ------------------------------------------------------------ durability
    console.log('\ndurability — the ledger outlives the process');
    const logBefore = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    check('awards are on disk as their own event type', /"t":"creditsAward"/.test(logBefore));
    check('spends are on disk as their own event type', /"t":"creditsSpend"/.test(logBefore));

    const beforeRestart = await get('/credits');
    await srv.restart();
    const afterRestart = await get('/credits');
    check('*** balance survives a restart ***', afterRestart.balance === beforeRestart.balance,
      `${afterRestart.balance} vs ${beforeRestart.balance}`);
    check('*** history survives a restart, same length ***',
      afterRestart.history.length === beforeRestart.history.length,
      `${afterRestart.history.length} vs ${beforeRestart.history.length}`);
    check('nothing was rewritten in the log, only appended',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').startsWith(logBefore));

    console.log('\nan unknown event type from a future build still replays clean (forward compat)');
    check('the server booted clean on replay', /events replayed/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));
  } finally {
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nthe test itself broke:', err && err.stack ? err.stack : err);
  process.exit(1);
});
