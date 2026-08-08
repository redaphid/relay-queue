'use strict';
/*
 * replay-selftest — boot a real server against a hand-written OLD event log and
 * prove nothing about it broke.
 *
 *   node tools/replay-selftest.js
 *
 * This is the highest-risk regression in the project. `data/events.jsonl` holds
 * the user's real message history, it is append-only, and it is replayed into
 * memory on every boot — so a change to the record shape that only works for
 * *new* records silently eats the past. Conversations added a field to every
 * task; this test writes a log containing records from before roles existed,
 * from before conversations existed, and a torn final line from a hard kill,
 * then starts the server on a scratch DATA_DIR and checks:
 *
 *   - every old record loads, into the default conversation;
 *   - a record that predates `role` still loads as the human's message;
 *   - a torn last line is skipped rather than fatal;
 *   - every pre-conversation curl call still works unchanged;
 *   - the existing log lines are NOT rewritten in place — durability here is
 *     append-only, and a migration that edits history is a migration that can
 *     lose it.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = Number(process.env.REPLAY_TEST_PORT || 3917);
const BASE = `http://127.0.0.1:${PORT}`;

// A log exactly as previous versions wrote it: no `role`, no `conversationId`.
const OLD_LOG = [
  // pre-1.1.0: no role at all
  { t: 'create', task: { id: 'old-1', instruction: 'the oldest message', from: 'communicator', ts: '2026-01-01T00:00:00.000Z', status: 'pending', claimedBy: null, claimedAt: null, result: null, resultTs: null, relayed: false, relayedAt: null } },
  // 1.1.0-1.2.0: role, still no conversationId
  { t: 'create', task: { id: 'old-2', role: 'user', instruction: 'a second message', from: 'web', ts: '2026-01-01T00:01:00.000Z', status: 'pending', claimedBy: null, claimedAt: null, result: null, resultTs: null, relayed: false, relayedAt: null } },
  { t: 'patch', id: 'old-2', patch: { status: 'claimed', claimedBy: 'coordinator', claimedAt: '2026-01-01T00:02:00.000Z' } },
  { t: 'patch', id: 'old-2', patch: { status: 'done', result: 'the answer to the second', resultTs: '2026-01-01T00:03:00.000Z' } },
  { t: 'create', task: { id: 'old-3', role: 'user', instruction: 'a third, never answered', from: 'voice', ts: '2026-01-01T00:04:00.000Z', status: 'pending', claimedBy: null, claimedAt: null, result: null, resultTs: null, relayed: false, relayedAt: null } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

const getAt = async (base, p) => (await fetch(base + p)).json();
async function postAt(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: res.status, body: await res.json() };
}
const get = (p) => getAt(BASE, p);
const post = (p, body) => postAt(BASE, p, body);

/*
 * Stop a child and wait for it to actually be gone. A process killed by a signal
 * reports exitCode === null (signalCode carries the signal), so a naive
 * `exitCode === null` guard re-kills an already-dead child and then awaits an
 * 'exit' event that fired long ago — which hangs silently and, once the event
 * loop drains, ends the run with no output and a success code.
 */
function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const gone = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  return gone;
}

async function waitForBoot(proc, base = BASE) {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start listening');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-replay-'));
  const logFile = path.join(dir, 'events.jsonl');
  // ...plus a torn final line, exactly as a hard kill mid-write leaves one.
  const original = OLD_LOG.map((e) => JSON.stringify(e)).join('\n') + '\n' + '{"t":"create","task":{"id":"tor';
  fs.writeFileSync(logFile, original);
  const beforeBytes = fs.readFileSync(logFile);

  console.log(`\nbooting server.js on a scratch DATA_DIR (${dir})`);
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });

  try {
    await waitForBoot(proc);

    console.log('\nan old log replays');
    const health = await get('/health');
    check('the server came up', health.status === 'ok');
    check('all 5 old events replayed', /5 events replayed/.test(out), out.split('\n').find((l) => /replayed/.test(l)));
    check('the torn final line was skipped, not fatal', /1 skipped/.test(out));
    check('all 3 old tasks are loaded', health.counts.pending + health.counts.claimed + health.counts.done === 3,
      JSON.stringify(health.counts));

    const tasks = await get('/tasks');
    const byId = Object.fromEntries(tasks.tasks.map((t) => [t.id, t]));
    check('a record written before `role` existed loads as the human\'s message',
      byId['old-1'] && byId['old-1'].role === 'user', JSON.stringify(byId['old-1'] && byId['old-1'].role));
    check('every old record landed in the default conversation',
      tasks.tasks.every((t) => t.conversationId === 'main'),
      JSON.stringify(tasks.tasks.map((t) => t.conversationId)));
    check('a patched old record kept its result', byId['old-2'] && byId['old-2'].result === 'the answer to the second');
    check('and its claim', byId['old-2'] && byId['old-2'].claimedBy === 'coordinator');

    const thread = await get('/thread');
    check('the thread still projects 4 entries from 3 tasks', thread.count === 4, `count=${thread.count}`);
    check('the derived reply is still there',
      thread.entries.some((e) => e.id === 'old-2:r' && e.role === 'agent' && e.replyTo === 'old-2'));
    check('thread entries now carry a conversation',
      thread.entries.every((e) => e.conversationId === 'main'));

    console.log('\nthe default conversation is implicit, not written');
    const convs = await get('/conversations');
    check('exactly one conversation exists', convs.count === 1, `count=${convs.count}`);
    check('it is the default', convs.conversations[0].id === 'main' && convs.defaultId === 'main');
    check('it counts the old messages', convs.conversations[0].messages === 3,
      `messages=${convs.conversations[0].messages}`);
    check('it shows the newest message as its hint',
      convs.conversations[0].lastText === 'a third, never answered', convs.conversations[0].lastText);
    check('*** the old log was NOT rewritten in place ***',
      Buffer.compare(beforeBytes, fs.readFileSync(logFile)) === 0,
      'server.js modified existing history');

    console.log('\nevery pre-conversation call still works unchanged');
    const made = await post('/tasks', { instruction: 'a brand new message', from: 'communicator' });
    check('POST /tasks with no conversationId is accepted', made.status === 201, `HTTP ${made.status}`);
    check('...and lands in the default conversation', made.body.conversationId === 'main', made.body.conversationId);
    check('`text` is still an alias for `instruction`',
      (await post('/tasks', { text: 'via the text alias' })).body.instruction === 'via the text alias');
    const claimed = await post(`/tasks/${made.body.id}/claim`, { by: 'coordinator' });
    check('claim still works', claimed.status === 200 && claimed.body.status === 'claimed');
    const resulted = await post(`/tasks/${made.body.id}/result`, { result: 'still fine' });
    check('result still works', resulted.status === 200 && resulted.body.status === 'done');
    check('/results still works', (await get('/results?unread=true')).count >= 1);
    // 4 from the old log (old-2 projects a reply too), + 2 for the new message
    // and its answer, + 1 for the alias message.
    check('unfiltered /thread still returns everything', (await get('/thread')).count === 7,
      `count=${(await get('/thread')).count}`);

    console.log('\nnew conversations, and scoping');
    const conv = await post('/conversations', { title: 'Second thread', agent: 'coordinator-2' });
    check('a conversation can be created', conv.status === 201, `HTTP ${conv.status}`);
    check('the agent field round-trips', conv.body.agent === 'coordinator-2');
    const scoped = await post('/tasks', { text: 'only in the second', conversationId: conv.body.id });
    check('a task can be filed under it', scoped.body.conversationId === conv.body.id);
    check('/thread scoped to it shows only its message',
      (await get(`/thread?conversation=${conv.body.id}`)).count === 1);
    check('/thread scoped to the default excludes it',
      !(await get('/thread?conversation=main')).entries.some((e) => e.text === 'only in the second'));
    check('/tasks can be filtered by conversation',
      (await get(`/tasks?conversation=${conv.body.id}`)).count === 1);
    check('filters still stack', (await get(`/tasks?conversation=${conv.body.id}&status=pending`)).count === 1);
    check('`assignee` works as an alias for `agent`',
      (await post(`/conversations/${conv.body.id}`, { assignee: 'coordinator-9' })).status === 200
      && (await get(`/conversations/${conv.body.id}`)).agent === 'coordinator-9');
    check('conversations with pending work can be listed',
      (await get('/conversations?pending=1')).conversations.some((c) => c.id === conv.body.id));
    check('an unknown conversation is refused rather than orphaning a message',
      (await post('/tasks', { text: 'x', conversationId: 'does-not-exist' })).status === 400);
    check('the default conversation cannot be archived',
      (await post('/conversations/main', { archived: true })).status === 400);
    check('archiving hides it from the default listing', (async () => true)()
      && (await post(`/conversations/${conv.body.id}`, { archived: true })).status === 200);
    check('...and it is gone from the list',
      !(await get('/conversations')).conversations.some((c) => c.id === conv.body.id));
    check('...but still reachable with archived=only',
      (await get('/conversations?archived=only')).conversations.some((c) => c.id === conv.body.id));

    console.log('\nit survives a restart with the new records in the log');
    await stop(proc);
    const proc2 = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out2 = '';
    proc2.stdout.on('data', (c) => { out2 += c; });
    try {
      await waitForBoot(proc2);
      const after = await get('/conversations?archived=1');
      check('the created conversation survived the restart',
        after.conversations.some((c) => c.id === conv.body.id && c.title === 'Second thread'));
      check('its agent survived', after.conversations.some((c) => c.agent === 'coordinator-9'));
      check('its archived flag survived', after.conversations.some((c) => c.id === conv.body.id && c.archived === true));
      check('the old messages are still there',
        (await get('/tasks')).tasks.some((t) => t.id === 'old-1'));
    } finally {
      await stop(proc2);
    }
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold it briefly */ }
  }

  await statusChecks();
  await protocolChecks();

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

/*
 * GET /status answers "is anything actually listening?", which is a question
 * about trust. The failure that matters is not a wrong number — it is a quiet,
 * healthy, caught-up queue rendering as an alarm, which teaches the user to
 * ignore the page. These run against a fresh empty server so the queue state is
 * exactly known.
 */
async function statusChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-status-'));
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('\nstatus — an empty queue is calm, not broken');
    let s = await getAt(base, '/status?engines=0');
    check('nothing waiting reads as idle', s.headline.level === 'idle',
      `${s.headline.level}: ${s.headline.text}`);
    check('*** a quiet queue is NEVER an alarm ***', s.headline.level !== 'alarm' && s.headline.level !== 'warn',
      s.headline.text);
    check('and it says so in plain words', /nothing is waiting/i.test(s.headline.text), s.headline.text);
    check('it admits nobody has checked in', s.watch.evidence === 'none', JSON.stringify(s.watch));
    check('there is nothing to measure yet', s.responsiveness.timeToAnswerSec === null);
    check('and nothing waiting', s.responsiveness.oldestWaiting === null);

    console.log('\nstatus — brand new work is normal latency, not a problem');
    await postAt(base, '/tasks', { text: 'is anyone there?' });
    s = await getAt(base, '/status?engines=0');
    check('a message that just arrived is not an alarm', s.headline.level === 'ok',
      `${s.headline.level}: ${s.headline.text}`);
    check('the oldest waiting message is reported', !!s.responsiveness.oldestWaiting
      && s.responsiveness.oldestWaiting.text === 'is anyone there?');
    check('with how long it has been waiting',
      typeof s.responsiveness.oldestWaiting.waitingSec === 'number');

    console.log('\nstatus — a heartbeat is WEAK evidence, and is not proof of health');
    const hb = await postAt(base, '/heartbeat', { agent: 'coordinator', note: 'polling' });
    check('a heartbeat is accepted', hb.status === 200 && hb.body.ok === true);
    s = await getAt(base, '/status?engines=0');
    check('the agent is named', s.watch.agents[0] && s.watch.agents[0].name === 'coordinator');
    check('with its note', s.watch.agents[0].note === 'polling');
    check('*** a heartbeat alone never counts as having acted ***',
      s.watch.evidence === 'heartbeat' && s.watch.lastActedAt === null, JSON.stringify(s.watch));
    check('last-seen and last-acted are reported separately',
      s.watch.lastSeenAgoSec !== null && s.watch.lastActedAgoSec === null, JSON.stringify(s.watch));

    console.log('\nstatus — acting is STRONG evidence and outranks a heartbeat');
    const acted = await postAt(base, '/tasks', { text: 'claim me' });
    await postAt(base, `/tasks/${acted.body.id}/claim`, { by: 'coordinator' });
    s = await getAt(base, '/status?engines=0');
    check('doing something outranks saying something', s.watch.evidence === 'acted', JSON.stringify(s.watch));
    check('and it is timed', typeof s.watch.lastActedAgoSec === 'number');

    console.log('\nstatus — the rest of the picture');
    const made = await postAt(base, '/tasks', { text: 'answer me' });
    await postAt(base, `/tasks/${made.body.id}/claim`, { by: 'coordinator' });
    await postAt(base, `/tasks/${made.body.id}/result`, { result: 'done' });
    s = await getAt(base, '/status?engines=0');
    check('timings appear once something is answered', !!s.responsiveness.timeToAnswerSec
      && s.responsiveness.timeToAnswerSec.samples === 1, JSON.stringify(s.responsiveness.timeToAnswerSec));
    check('recent activity lists what happened',
      s.recent.some((r) => r.kind === 'answered') && s.recent.some((r) => r.kind === 'claimed')
      && s.recent.some((r) => r.kind === 'message'), JSON.stringify(s.recent.map((r) => r.kind)));
    check('activity is newest first', msOrder(s.recent), JSON.stringify(s.recent.map((r) => r.at)));
    check('who did it is recorded', s.recent.some((r) => r.who === 'coordinator'));
    check('engines are probed when asked',
      !!(await getAt(base, '/status')).engines, 'no engines block');
    check('...and skipped when not', (await getAt(base, '/status?engines=0')).engines === undefined);

    console.log('\nstatus — heartbeats are liveness, not history');
    const before = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    await postAt(base, '/heartbeat', { agent: 'coordinator' });
    await postAt(base, '/heartbeat', { agent: 'coordinator' });
    await getAt(base, '/status?engines=0');
    check('*** heartbeats are never written to the durable log ***',
      fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') === before,
      'the event log grew — one line per poll would bury the real history');
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }

  await stuckChecks();
}

/*
 * The state that used to lie.
 *
 * A coordinator hung for eight minutes while /status showed it alive at "0s
 * ago" the whole time, because its heartbeat came from a background shell loop:
 * the beat proved the loop was ticking, not that the agent was awake. Liveness
 * read healthiest exactly when it was most stuck.
 *
 * Seeded with a back-dated unanswered message so the queue is genuinely stalled
 * while the heartbeat is perfectly fresh.
 */
async function stuckChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stuck-'));
  const port = PORT + 2;
  const base = `http://127.0.0.1:${port}`;
  const stale = new Date(Date.now() - 9 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
    t: 'create',
    task: {
      id: 'stuck-1', role: 'user', conversationId: 'main', instruction: 'answer me please',
      from: 'web', ts: stale, status: 'pending', claimedBy: null, claimedAt: null,
      result: null, resultTs: null, relayed: false, relayedAt: null,
    },
  }) + '\n');

  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    await postAt(base, '/conversations/main', { agent: 'coordinator' });
    await postAt(base, '/heartbeat', { agent: 'coordinator', note: 'still here!' });

    console.log('\nstatus — beating but not acting is the state that used to lie');
    const s = await getAt(base, '/status?engines=0');
    check('*** a fresh heartbeat does NOT make a stalled queue look healthy ***',
      s.headline.level !== 'ok' && s.headline.level !== 'idle',
      `${s.headline.level}: ${s.headline.text}`);
    check('it says the agent looks stuck', /looks stuck/i.test(s.headline.text), s.headline.text);
    check('...and names it', /coordinator/.test(s.headline.text), s.headline.text);
    check('...and never calls it fine', !/all caught up|is watching/i.test(s.headline.text), s.headline.text);
    check('the heartbeat is still reported, just not believed',
      s.watch.lastSeenAgoSec !== null && s.watch.lastSeenAgoSec < 60, JSON.stringify(s.watch.lastSeenAgoSec));
    check('and last-acted shows the truth', s.watch.lastActedAt === null, JSON.stringify(s.watch.lastActedAt));

    const cs = (await getAt(base, '/conversations')).conversations.find((x) => x.id === 'main');
    check('the conversation list agrees it is stuck',
      cs && cs.agentState && cs.agentState.state === 'stuck', JSON.stringify(cs && cs.agentState));
    check('...and carries both timings', cs.agentState.seenAgoSec !== null,
      JSON.stringify(cs.agentState));

    console.log('\nstatus — the same silence with NOTHING waiting is healthy');
    await postAt(base, `/tasks/stuck-1/result`, { result: 'answered at last' });
    const t = await getAt(base, '/status?engines=0');
    check('answering it clears the alarm', t.headline.level === 'ok',
      `${t.headline.level}: ${t.headline.text}`);
    const cs2 = (await getAt(base, '/conversations')).conversations.find((x) => x.id === 'main');
    check('*** an idle agent with an empty queue is not "stuck" ***',
      cs2.agentState.state !== 'stuck' && cs2.agentState.state !== 'silent',
      JSON.stringify(cs2.agentState));
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }
}

/*
 * The protocol guarantees added after the 2026-08-07 retrospective, each one
 * written against the failure that produced it rather than against the feature
 * that fixes it. Own server, own scratch dir, so queue state is exactly known
 * and nothing here can be explained away by leftovers from another phase.
 */
async function protocolChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-protocol-'));
  const port = PORT + 3;
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
      WATCH_SOURCE: '0', CLAIM_LEASE_MS: '1200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const g = (p) => getAt(base, p);
  const p_ = (path_, body) => postAt(base, path_, body);

  try {
    await waitForBoot(proc, base);

    /*
     * 4.4, verbatim. An agent chains result-then-relayed in one command; the
     * result POST fails on a malformed body; the relayed POST must not then
     * close the human's question with nothing in it.
     */
    console.log('\nrelayed — a question can never be closed with no answer in it');
    const q = await p_('/tasks', { text: 'what time is the flight?', from: 'voice' });
    check('the question is posted', q.status === 201, `HTTP ${q.status}`);
    const bad = await p_(`/tasks/${q.body.id}/result`, { notTheField: 'malformed body' });
    check('a malformed result is refused, as it was on the night', bad.status === 400, `HTTP ${bad.status}`);
    const premature = await p_(`/tasks/${q.body.id}/relayed`, {});
    check('*** relayed is REFUSED while result is null ***', premature.status === 409, `HTTP ${premature.status}`);
    check('...and the refusal names the actual problem, not a missing field',
      /no result/i.test(premature.body.error || ''), premature.body.error);
    const still = await g(`/tasks/${q.body.id}`);
    check('...so the question is still open, not silently closed',
      still.relayed === false && still.result === null,
      `relayed=${still.relayed} result=${JSON.stringify(still.result)}`);
    check('...and it is still visible to an unread poll',
      (await g('/tasks?unread=1')).tasks.some((t) => t.id === q.body.id));

    const good = await p_(`/tasks/${q.body.id}/result`, { result: 'boards at 07:40' });
    check('the real answer still lands', good.status === 200, `HTTP ${good.status}`);
    const ok = await p_(`/tasks/${q.body.id}/relayed`, {});
    check('...and NOW it can be marked relayed', ok.status === 200, `HTTP ${ok.status}`);
    const again = await p_(`/tasks/${q.body.id}/relayed`, {});
    check('re-flagging stays idempotent', again.status === 200 && again.body.relayed === true);
    check('...and keeps the original relayedAt',
      again.body.relayedAt === (await g(`/tasks/${q.body.id}`)).relayedAt);
    const empty = await p_('/tasks', { text: 'answerable with very little' });
    check('an empty-string answer still counts as an answer',
      (await p_(`/tasks/${empty.body.id}/result`, { result: '' })).status === 200
      && (await p_(`/tasks/${empty.body.id}/relayed`, {})).status === 200);
    const nulled = await p_('/tasks', { text: 'and this one gets a null' });
    check('...but a literal null result is refused at the point it is fixable',
      (await p_(`/tasks/${nulled.body.id}/result`, { result: null })).status === 400,
      'otherwise it lands `done` with nothing in it and can never be closed');
    check('...leaving that question open rather than done-and-empty',
      (await g(`/tasks/${nulled.body.id}`)).status === 'pending');

    /*
     * 4.1 / §5. A claim that outlives its claimer held one message for 3h14m and
     * another for 32m. The lease does not seize anything back — it only stops
     * the queue pretending the dead agent is still on it.
     */
    console.log('\nclaims — a lease, so a dead agent cannot hold a message forever');
    const held = await p_('/tasks', { text: 'the orphaned one', from: 'voice' });
    const c1 = await p_(`/tasks/${held.body.id}/claim`, { by: 'romeo' });
    check('a pending task can be claimed', c1.status === 200 && c1.body.claimedBy === 'romeo');
    const poach = await p_(`/tasks/${held.body.id}/claim`, { by: 'juno' });
    check('*** a FRESH claim is still protected from a second agent ***', poach.status === 409, `HTTP ${poach.status}`);
    check('...and the refusal says how long is left on the lease',
      typeof poach.body.leaseExpiresInSec === 'number' && poach.body.leaseExpiresInSec > 0,
      JSON.stringify(poach.body));
    check('...and names who holds it', poach.body.claimedBy === 'romeo', JSON.stringify(poach.body));

    const renew = await p_(`/tasks/${held.body.id}/claim`, { by: 'romeo' });
    check('the holder can renew its own lease from inside a turn', renew.status === 200, `HTTP ${renew.status}`);
    check('...and renewal is not a takeover', !renew.body.takenOverFrom, JSON.stringify(renew.body.takenOverFrom));
    const firstClaimAt = renew.body.claimedAt;

    await sleep(1400); // CLAIM_LEASE_MS is 1200 for this server
    const taken = await p_(`/tasks/${held.body.id}/claim`, { by: 'juno' });
    check('*** an EXPIRED claim may be taken over by another agent ***', taken.status === 200, `HTTP ${taken.status}`);
    check('...the new agent holds it', taken.body.claimedBy === 'juno', taken.body.claimedBy);
    check('...the takeover is recorded, not silent', taken.body.takenOverFrom === 'romeo', JSON.stringify(taken.body));
    check('...and the lease clock restarted', Date.parse(taken.body.claimedAt) > Date.parse(firstClaimAt));
    check('...but the task never went back to pending under other agents\' polls',
      taken.body.status === 'claimed'
      && !(await g('/tasks?status=pending')).tasks.some((t) => t.id === held.body.id),
      taken.body.status);
    const expired = await g('/tasks?status=claimed&expired=1');
    check('an expired claim is findable, which is how it gets rescued at all',
      Array.isArray(expired.tasks), JSON.stringify(expired).slice(0, 120));

    const ans = await p_(`/tasks/${held.body.id}/result`, { result: 'answered by the new holder' });
    check('the taken-over task can be answered', ans.status === 200, `HTTP ${ans.status}`);
    const dupe = await p_(`/tasks/${held.body.id}/result`, { result: 'the original agent woke up' });
    check('*** one result per task SURVIVES the lease: the loser is refused ***',
      dupe.status === 409, `HTTP ${dupe.status}`);
    check('...and the first answer is the one that stands',
      (await g(`/tasks/${held.body.id}`)).result === 'answered by the new holder');
    const done = await p_(`/tasks/${held.body.id}/claim`, { by: 'someone-else' });
    check('an ANSWERED task is never reclaimable, however old', done.status === 409, `HTTP ${done.status}`);

    console.log('\nit all survives a restart, because it is only ever the event log');
    await stop(proc);
    const proc2 = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc2.stdout.on('data', () => {});
    proc2.stderr.on('data', () => {});
    try {
      await waitForBoot(proc2, base);
      check('the takeover survived', (await g(`/tasks/${held.body.id}`)).takenOverFrom === 'romeo');
      check('the relayed guard still holds after a replay',
        (await p_(`/tasks/${(await p_('/tasks', { text: 'fresh' })).body.id}/relayed`, {})).status === 409);
    } finally {
      await stop(proc2);
    }
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }
}

function msOrder(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (Date.parse(rows[i - 1].at) < Date.parse(rows[i].at)) return false;
  }
  return true;
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
