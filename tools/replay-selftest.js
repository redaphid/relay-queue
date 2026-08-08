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

async function waitForBoot(proc) {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(`${BASE}/health`);
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
    check('it admits nobody has checked in', s.watch.source === 'none', JSON.stringify(s.watch));
    check('there is nothing to measure yet', s.responsiveness.timeToAnswerSec === null);
    check('and nothing waiting', s.responsiveness.oldestWaiting === null);

    console.log('\nstatus — waiting work with nobody listening is an alarm');
    await postAt(base, '/tasks', { text: 'is anyone there?' });
    s = await getAt(base, '/status?engines=0');
    check('a waiting message with no agent is raised', s.headline.level === 'warn' || s.headline.level === 'alarm',
      `${s.headline.level}: ${s.headline.text}`);
    check('it names the problem', /no agent has ever checked in/i.test(s.headline.text), s.headline.text);
    check('the oldest waiting message is reported', !!s.responsiveness.oldestWaiting
      && s.responsiveness.oldestWaiting.text === 'is anyone there?');
    check('with how long it has been waiting',
      typeof s.responsiveness.oldestWaiting.waitingSec === 'number');

    console.log('\nstatus — a heartbeat changes the answer');
    const hb = await postAt(base, '/heartbeat', { agent: 'coordinator', note: 'polling' });
    check('a heartbeat is accepted', hb.status === 200 && hb.body.ok === true);
    s = await getAt(base, '/status?engines=0');
    check('the same queue now reads as fine', s.headline.level === 'ok',
      `${s.headline.level}: ${s.headline.text}`);
    check('it says an agent is watching', /an agent is watching/i.test(s.headline.text), s.headline.text);
    check('the agent is named', s.watch.agents[0] && s.watch.agents[0].name === 'coordinator');
    check('with its note', s.watch.agents[0].note === 'polling');
    check('and the source is the heartbeat, not a guess', s.watch.source === 'heartbeat');

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
}

function msOrder(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (Date.parse(rows[i - 1].at) < Date.parse(rows[i].at)) return false;
  }
  return true;
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
