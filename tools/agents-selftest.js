'use strict';
/*
 * agents-selftest — prove an agent can be named, addressed, WOKEN, and buried.
 *
 *   node tools/agents-selftest.js
 *
 * The failures this is built against are all real and all his:
 *
 *   "Are we using a literal queue for these messages. I've seen 2 agents work
 *    on the same message, and some messages never picked up"
 *   "I always want to communicate directly with the subagents if possible"
 *   "They need to pick their own names. And I want to be able to see the
 *    subagent trees"
 *
 * The load-bearing test is THE WAKE. Everything else here is bookkeeping that
 * could be checked by reading the code; whether an idle agent is actually
 * roused is a property of the world, so it is tested against the world — a real
 * child process that blocks on the inbox and must EXIT when a message lands.
 * A delivery mechanism that does not wake anything is a database, and a
 * database is what was already failing.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./harness-lib');

const PORT = Number(process.env.AGENTS_TEST_PORT || 0);
// Short enough to test the inference, long enough that nothing races into it.
const PRESUMED_DEAD_MS = 1500;

let srv = null;
let failures = 0;

function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(srv.base + p)).json();
async function post(p, body) {
  const res = await fetch(srv.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json() };
}

/*
 * A stand-in for an idle agent: a real, separate process that blocks on the
 * inbox and exits on the first line. This is the shape the harness turns into
 * a wake — a background command that ENDS is an event; one that runs forever
 * is not.
 */
const WAITER = `
const fs = require('node:fs');
// Passed in the environment rather than as an argument: with \`node -e\`, extra
// argv lands at [1], not [2], and reading the wrong slot makes the waiter crash
// instantly — which is indistinguishable from "the inbox woke it".
const file = process.env.WAIT_FILE;
let at = fs.statSync(file).size;
function look() {
  const size = fs.statSync(file).size;
  if (size <= at) return false;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - at);
  fs.readSync(fd, buf, 0, buf.length, at);
  fs.closeSync(fd);
  at = size;
  const line = buf.toString('utf8').split('\\n').filter(Boolean)[0];
  if (!line) return false;
  process.stdout.write(line);
  process.exit(0);
}
fs.watchFile(file, { interval: 50 }, look);
setTimeout(() => { process.stderr.write('never woken'); process.exit(3); }, 15000);
`;

function startWaiter(file) {
  const proc = spawn(process.execPath, ['-e', WAITER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WAIT_FILE: file },
  });
  const state = { out: '', err: '', code: null, exited: false };
  proc.stdout.on('data', (d) => { state.out += d; });
  proc.stderr.on('data', (d) => { state.err += d; });
  proc.on('exit', (code) => { state.code = code; state.exited = true; });
  state.proc = proc;
  return state;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agents-'));
  srv = await startServer({ dir, port: PORT, env: { PRESUMED_DEAD_MS: String(PRESUMED_DEAD_MS) } });
  console.log(`agents-selftest — server on ${srv.base}, data in ${dir}\n`);

  try {
    console.log('an agent picks its own name');
    const zora = await post('/agents', { name: 'Zora', task: 'coordinating the sweep' });
    check('registering succeeds', zora.status === 201, `HTTP ${zora.status}`);
    check('...and it is handed a key', typeof zora.body.key === 'string' && zora.body.key.length >= 16);
    check('...and told where its inbox is', typeof zora.body.inboxFile === 'string');
    check('...and how to be woken by it', /tail/.test((zora.body.wake || {}).command || ''),
      JSON.stringify(zora.body.wake));
    check('*** the inbox file exists BEFORE anything is sent ***',
      fs.existsSync(zora.body.inboxFile),
      'tail -f on a missing file exits at once, which reads as a phantom message');
    check('registering counts as an act, because it happens inside a turn',
      zora.body.agent.lastActedAt && zora.body.agent.acts === 1);

    console.log('\nthe collision that actually happened');
    const sf1 = await post('/agents', { name: 'Sporefall 2', task: 'sprites' });
    check('the first spelling is accepted', sf1.status === 201, `HTTP ${sf1.status}`);
    const sf2 = await post('/agents', { name: 'Sporefall2', task: 'also sprites' });
    check('*** a name that cannot be told apart from a taken one is REFUSED ***',
      sf2.status === 409, `HTTP ${sf2.status}`);
    check('...and says why, in those words',
      /cannot be told apart/.test(JSON.stringify(sf2.body)), JSON.stringify(sf2.body).slice(0, 200));
    check('...and offers a free name, so the refusal is actionable',
      typeof sf2.body.suggestion === 'string' && sf2.body.suggestion.length > 0, sf2.body.suggestion);
    const taken = await post('/agents', { name: sf2.body.suggestion });
    check('...and the suggested name is genuinely free', taken.status === 201, `HTTP ${taken.status}`);

    console.log('\na name has to survive the agent being resumed');
    const impostor = await post('/agents', { name: 'Zora', task: 'something else entirely' });
    check('*** re-registering a held name without the key is refused ***',
      impostor.status === 409, `HTTP ${impostor.status}`);
    const resumed = await post('/agents', { name: 'zora', key: zora.body.key, task: 'still coordinating' });
    check('...but with the key it is the same agent, resumed', resumed.status === 200 && resumed.body.resumed === true,
      `HTTP ${resumed.status}`);
    check('...keeping its identity', resumed.body.agent.id === zora.body.agent.id);
    check('...and counting the resume', resumed.body.agent.resumes === 1);
    check('...and its new job is on the record', resumed.body.agent.task === 'still coordinating');

    console.log('\n*** THE WAKE — the part that cannot be checked by reading code ***');
    const waiter = startWaiter(zora.body.inboxFile);
    await sleep(400);
    check('an agent waiting on a quiet inbox stays blocked', waiter.exited === false,
      `exited early with ${waiter.code}: ${waiter.out}${waiter.err}`);

    const sent = await post('/agents/Zora/messages', { text: 'stop rebasing that branch', from: 'human' });
    check('a message addressed to it is accepted', sent.status === 201, `HTTP ${sent.status}`);
    check('...and the server does NOT claim it was delivered to anyone',
      sent.body.acknowledged === false && /counts as picked up only when/.test(sent.body.note || ''));

    for (let i = 0; i < 60 && !waiter.exited; i++) await sleep(100);
    check('*** the blocked agent WOKE when the message landed ***', waiter.exited === true,
      `still blocked after 6s; stderr=${waiter.err}`);
    check('...cleanly, rather than by dying', waiter.code === 0, `exit ${waiter.code}`);
    check('*** ...and it woke holding the actual message ***',
      /stop rebasing that branch/.test(waiter.out), waiter.out.slice(0, 200));
    try { waiter.proc.kill(); } catch (e) { /* already gone */ }

    console.log('\naddressing is forgiving, because he does it by voice');
    for (const spelling of ['zora', 'ZORA', 'Zora']) {
      const r = await post(`/agents/${encodeURIComponent(spelling)}/messages`, { text: 'ping ' + spelling });
      if (r.status !== 201) check(`"${spelling}" reaches the same agent`, false, `HTTP ${r.status}`);
    }
    const box = await get('/agents/Zora/messages');
    check('every spelling reached one inbox', box.count === 4, `${box.count} messages`);

    console.log('\n"never picked up" becomes something he can SEE');
    check('four delivered, none acknowledged', box.waiting === 4, `${box.waiting} waiting`);
    const first = box.messages[0];
    const ack = await post(`/agents/Zora/messages/${first.id}/ack`, { note: 'on it' });
    check('an agent can acknowledge one', ack.status === 200, `HTTP ${ack.status}`);
    check('...and the waiting count drops', (await get('/agents/Zora/messages')).waiting === 3);
    check('...acking is an act, so it is also proof of life',
      (await get('/agents/Zora')).lastActNote === 'on it');
    const unread = await get('/agents/Zora/messages?unread=1');
    check('...and the unread ones can be asked for on their own', unread.count === 3, String(unread.count));

    console.log('\nthe tree — workers spawn workers, so depth is arbitrary');
    const key = {};
    for (const [name, parent] of [['Rune', 'Zora'], ['Mote', 'Rune'], ['Ember', 'Mote'], ['Fen', 'Zora']]) {
      const r = await post('/agents', { name, parent, task: 'working on ' + name.toLowerCase() });
      key[name] = r.body.key;
    }
    const roster = await get('/agents');
    const find = (t, n) => {
      for (const node of t) {
        if (node.name === n) return node;
        const hit = find(node.children || [], n);
        if (hit) return hit;
      }
      return null;
    };
    check('the tree has a root', !!find(roster.tree, 'Zora'));
    check('...a child', (find(roster.tree, 'Rune') || {}).depth === 1);
    check('...a grandchild', (find(roster.tree, 'Mote') || {}).depth === 2);
    check('*** ...and a great-grandchild, so depth really is arbitrary ***',
      (find(roster.tree, 'Ember') || {}).depth === 3, JSON.stringify((find(roster.tree, 'Ember') || {}).depth));
    check('siblings sit together', (find(roster.tree, 'Zora') || { children: [] }).children.length === 2);
    check('*** every node says what that agent is working on ***',
      (find(roster.tree, 'Ember') || {}).task === 'working on ember',
      JSON.stringify((find(roster.tree, 'Ember') || {}).task));
    check('nobody is missing from the tree',
      [...'Zora Rune Mote Ember Fen'.split(' ')].every((n) => !!find(roster.tree, n)));

    /*
     * A cycle is reachable in practice: a resumed agent naming a descendant as
     * its parent. A recursive walk without a guard hangs the process, and this
     * server is his only line to every agent.
     */
    await post('/agents', { name: 'Zora', key: zora.body.key, parent: 'Ember' });
    const cyc = await Promise.race([
      get('/agents'),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    check('*** a parent cycle does not hang the roster ***', cyc !== null, 'timed out');
    check('...and nobody disappears because of it',
      cyc && 'Zora Rune Mote Ember Fen'.split(' ').every((n) => cyc.agents.some((a) => a.name === n)));

    console.log('\nthe key is a secret, and a roster is a public thing');
    const dump = JSON.stringify(await get('/agents'));
    check('*** no key appears anywhere in the roster ***',
      dump.indexOf(zora.body.key) < 0 && !/"key"/.test(dump));
    const wrong = await post('/agents/Rune', { key: 'nope', task: 'hijacked' });
    check('...and nobody else can rewrite what an agent is working on', wrong.status === 403,
      `HTTP ${wrong.status}`);
    const own = await post('/agents/Rune', { key: key.Rune, task: 'rebasing the branch' });
    check('...while the agent itself can', own.status === 200 && own.body.agent.task === 'rebasing the branch');

    console.log('\nthe graveyard — and the difference between knowing and guessing');
    const thirdParty = await post('/agents/Fen/finished', { key: key.Rune, lastWords: 'not my call' });
    check('a third party cannot bury an agent', thirdParty.status === 403, `HTTP ${thirdParty.status}`);
    const buried = await post('/agents/Mote/finished', {
      key: key.Rune, ok: true, lastWords: 'left the branch rebased and pushed',
    });
    check('its parent can', buried.status === 200, `HTTP ${buried.status}`);
    check('*** a reported death is CONFIRMED ***', buried.body.agent.death.state === 'confirmed');
    check('...and certain, said in the payload so no UI has to infer it',
      buried.body.agent.death.certain === true);
    check('...crediting whoever reported it', buried.body.agent.death.by === 'Rune');
    check('*** ...and keeping its last words, usually the most useful sentence it produced ***',
      buried.body.agent.death.lastWords === 'left the branch rebased and pushed');

    const selfBuried = await post('/agents/Fen/finished', { key: key.Fen, ok: true, lastWords: 'done, nothing held' });
    check('an agent can bury itself', selfBuried.status === 200 && selfBuried.body.agent.death.self === true);

    // Ember has not acted since it registered; wait for the inference to trip.
    await sleep(PRESUMED_DEAD_MS + 600);
    const quiet = await get('/agents/Ember');
    check('*** silence produces a PRESUMED death, not a confirmed one ***',
      quiet.death.state === 'presumed', JSON.stringify(quiet.death));
    check('*** ...and it is explicitly NOT certain ***', quiet.death.certain === false);
    check('...it says what it is inferring from', /nothing reported for/.test(quiet.death.because || ''),
      quiet.death.because);
    check('*** ...and admits it only means "not working right now" ***',
      /not necessarily gone/.test(quiet.death.meaning || ''), quiet.death.meaning);

    console.log('\nthe dead come back, because they have');
    const risen = await post('/agents/Ember', { key: key.Ember, note: 'was thinking, not dead' });
    check('*** an agent that acts is alive again with nothing to undo ***',
      risen.status === 200 && risen.body.agent.death.state === null, JSON.stringify(risen.body.agent.death));
    const exhumed = await post('/agents/Mote/exhume', { note: 'it committed an hour later' });
    check('*** a CONFIRMED death can be reversed too ***',
      exhumed.status === 200 && exhumed.body.agent.death.state === null);
    check('...and the fact that it happened is kept', !!(exhumed.body.agent.exhumed || {}).at);
    const noop = await post('/agents/Ember/exhume', {});
    check('exhuming a living agent is a no-op that explains itself',
      noop.status === 200 && noop.body.already === true && /needs no exhuming/.test(noop.body.note || ''));

    const g = await get('/agents');
    check('the graveyard is its own list', Array.isArray(g.graveyard));
    check('*** confirmed and presumed are counted separately, never summed ***',
      typeof g.confirmedDead === 'number' && typeof g.presumedDead === 'number',
      `${g.confirmedDead} / ${g.presumedDead}`);
    check('...and it says how long silence takes to become a guess',
      g.presumedAfterMin >= 0, String(g.presumedAfterMin));

    console.log('\nit survives the restart this server gives itself constantly');
    const logBefore = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const inbox = path.join(dir, 'inbox', 'zora.jsonl');
    fs.unlinkSync(inbox); // a DATA_DIR that lost its inbox directory
    await srv.restart({ PRESUMED_DEAD_MS: String(PRESUMED_DEAD_MS) });
    check('*** a missing inbox file is recreated at boot ***', fs.existsSync(inbox),
      'otherwise every agent tails a missing file and wakes in a tight loop forever');
    const back = await get('/agents/Zora');
    check('the agent is still there', back.name === 'Zora');
    check('...still holding its name against an impostor',
      (await post('/agents', { name: 'Zora' })).status === 409);
    check('...and still answering to its key',
      (await post('/agents', { name: 'Zora', key: zora.body.key })).status === 200);
    check('the messages it never read are still waiting',
      (await get('/agents/Zora/messages')).waiting === 3);
    check('nothing was rewritten in the log, only appended',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').startsWith(logBefore));
    check('the server booted clean', /events replayed/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));
    check('...with nothing skipped', /0 skipped/.test(srv.out),
      srv.out.split('\n').find((l) => /replayed/.test(l)));

    console.log('\nnothing that already worked was touched');
    const t = await post('/tasks', { text: 'an ordinary message' });
    check('POST /tasks still works', t.status === 201, `HTTP ${t.status}`);
    const thread = await get('/thread');
    check('the thread still projects it', thread.entries.some((e) => e.id === t.body.id));
    check('...and carries no agent bookkeeping into it',
      !/"key"|"fold"/.test(JSON.stringify(thread)));
    check('an unknown agent route 404s with the known ones listed',
      /known/.test(JSON.stringify(await get('/agents/Zora/nonsense'))));

    /*
     * The lock that existed and enforced nothing. Four tasks in the live log
     * are `done` with `claimedBy: null`. Tightening it is only safe if it stays
     * narrow, so the cases that must KEEP working are asserted first and there
     * are more of them than the case being closed.
     */
    console.log('\ntwo agents on one job — the claim finally means something');
    const t1 = await post('/tasks', { text: 'unclaimed, answered directly' });
    check('a result on an UNCLAIMED task is still accepted, exactly as before',
      (await post(`/tasks/${t1.body.id}/result`, { result: 'done' })).status === 200);

    const t2 = await post('/tasks', { text: 'claimed, answered with no name given' });
    await post(`/tasks/${t2.body.id}/claim`, { by: 'Rune' });
    check('*** a result with no `by` is still accepted, so nothing that worked breaks ***',
      (await post(`/tasks/${t2.body.id}/result`, { result: 'done' })).status === 200);

    const t3 = await post('/tasks', { text: 'claimed by one, answered by another' });
    await post(`/tasks/${t3.body.id}/claim`, { by: 'Rune' });
    const stolen = await post(`/tasks/${t3.body.id}/result`, { result: 'I did it', by: 'Fen' });
    check('*** answering a task another agent holds is REFUSED ***', stolen.status === 409,
      `HTTP ${stolen.status}`);
    check('...naming who actually holds it', stolen.body.claimedBy === 'Rune', stolen.body.claimedBy);
    check('...and saying what to do about it', /one of you should stop|take it over/.test(stolen.body.hint || ''),
      stolen.body.hint);
    check('...and nothing was written', (await get(`/tasks/${t3.body.id}`)).status === 'claimed');
    check('the holder can still answer its own',
      (await post(`/tasks/${t3.body.id}/result`, { result: 'mine', by: 'Rune' })).status === 200);
    check('...and the ownership is visible in the thread, not only in the queue',
      (await get('/thread')).entries.some((e) => e.claimedBy === 'Rune'));
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
