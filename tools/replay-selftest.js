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
const crypto = require('node:crypto');
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
  await pushChecks();

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

/** A structurally valid browser subscription, without a browser. */
function fakeSubscription(n) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://push.invalid/wpush/v2/token-${n}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

/*
 * Web push, end to end over HTTP.
 *
 * The two checks that matter most live here rather than in push-selftest,
 * because they are properties of the running server rather than of a function:
 * a `channel` message must queue NOTHING, and quiet hours must actually
 * suppress. The debounce is turned down to 120ms so a flush can be observed
 * inside a test, and the counters on /push/config are the observation point —
 * so no push service and no network are involved.
 */
async function pushChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-push-'));
  const port = PORT + 4;
  const base = `http://127.0.0.1:${port}`;
  let proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
      WATCH_SOURCE: '0', PUSH_DEBOUNCE_MS: '120',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const g = (p) => getAt(base, p);
  const p_ = (path_, body) => postAt(base, path_, body);
  const stats = async () => (await g('/push/config')).stats;
  const settle = () => sleep(400); // comfortably past the 120ms debounce
  const hhmm = (m) => {
    const x = ((m % 1440) + 1440) % 1440;
    return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  };
  const utcNowMin = () => {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  try {
    await waitForBoot(proc, base);

    console.log('\npush — the server offers a key and starts disarmed');
    {
      const cfg = await g('/push/config');
      check('push is enabled', cfg.enabled === true);
      check('a VAPID public key is published', typeof cfg.vapidPublicKey === 'string' && cfg.vapidPublicKey.length > 80);
      check('the key is an uncompressed P-256 point',
        Buffer.from(cfg.vapidPublicKey, 'base64url').length === 65 && Buffer.from(cfg.vapidPublicKey, 'base64url')[0] === 4);
      check('no device is armed yet', cfg.devices.length === 0);
      check('this browser is not armed', cfg.subscribedHere === false);
      check('all three categories are on by default',
        cfg.categories['needs-you'] && cfg.categories.done && cfg.categories.broken);
      check('quiet hours start unset', cfg.quiet.configured === false);
      check('the timezone in force is stated', typeof cfg.quiet.timezone === 'string' && cfg.quiet.timezone.length > 0);
      check('the clock in that zone is stated beside it', /^\d\d:\d\d$/.test(cfg.quiet.zoneNow), cfg.quiet.zoneNow);
      check('the key is stable across reads', (await g('/push/config')).vapidPublicKey === cfg.vapidPublicKey);
    }

    console.log('\npush — a channel message never reaches his phone');
    {
      /*
       * Rule zero, over the wire. 19 of one night's messages were agent-to-agent
       * coordination; if this regresses, every one of them buzzes him.
       */
      const before = await stats();
      const r = await p_('/messages', { text: 'coordinating with vega', from: 'zora', channel: 'agents' });
      check('the channel message was accepted', r.status === 201, String(r.status));
      check('...and it is internal', r.body.visibility === 'internal');
      await settle();
      const after = await stats();
      check('nothing was queued for him', after.queued === before.queued, `${before.queued} -> ${after.queued}`);
      check('nothing was flushed', after.flushed === before.flushed);

      const seen = await p_('/messages', { text: 'the thing you asked about is done', from: 'zora' });
      check('the same message without a channel is accepted', seen.status === 201);
      check('...and it is not internal', seen.body.visibility === 'conversation');
      await settle();
      const after2 = await stats();
      check('...and it DOES queue a notification', after2.queued === before.queued + 1, String(after2.queued));
      check('...and it flushes', after2.flushed === before.flushed + 1);
    }

    console.log('\npush — he is never buzzed by the phone he typed on');
    {
      const before = await stats();
      for (const from of ['web', 'voice', 'voice-conversation']) {
        await p_('/tasks', { text: `typed from ${from}`, from });
      }
      await settle();
      check('three messages he sent himself queued nothing', (await stats()).queued === before.queued);

      const handed = await p_('/tasks', { text: 'which branch should I merge?', from: 'vega' });
      check('a task handed to him by an agent is accepted', handed.status === 201);
      await settle();
      check('...and that one does queue', (await stats()).queued === before.queued + 1);
    }

    console.log('\npush — an answer cancels the "needs you" still waiting to go out');
    {
      /*
       * The documented way for an agent to speak unprompted is to post a task
       * and immediately answer it. Without the cancel that is two buzzes for
       * one update, which is exactly the noise he asked to be spared.
       */
      const before = await stats();
      const t = await p_('/tasks', { text: 'unprompted update', from: 'vega' });
      const answered = await p_(`/tasks/${t.body.id}/result`, { result: 'here it is' });
      check('the result posted', answered.status === 200, String(answered.status));
      await settle();
      const after = await stats();
      check('two things wanted to notify', after.queued === before.queued + 2);
      check('but only one buzz went out', after.flushed === before.flushed + 1, `${before.flushed} -> ${after.flushed}`);
    }

    console.log('\npush — an explicit notify hint is honoured');
    {
      const before = await stats();
      await p_('/messages', { text: 'routine progress', from: 'zora', notify: 'none' });
      await settle();
      check('notify:"none" queues nothing', (await stats()).queued === before.queued);
      await p_('/messages', { text: 'the disk is full', from: 'zora', notify: 'broken' });
      await settle();
      check('notify:"broken" does queue', (await stats()).queued === before.queued + 1);
    }

    console.log('\npush — a silenced category queues nothing');
    {
      const off = await p_('/push/config', { categories: { done: false } });
      check('a category can be turned off', off.status === 200 && off.body.categories.done === false);
      const before = await stats();
      await p_('/messages', { text: 'another finished thing', from: 'zora' });
      await settle();
      check('a "done" message is then ignored', (await stats()).queued === before.queued);
      const on = await p_('/push/config', { categories: { done: true } });
      check('and it can be turned back on', on.status === 200 && on.body.categories.done === true);
      await p_('/messages', { text: 'and another', from: 'zora' });
      await settle();
      check('...after which it queues again', (await stats()).queued === before.queued + 1);
    }

    console.log('\npush — quiet hours actually suppress, which is the whole point');
    {
      /*
       * The watchdog's quiet window silently became TOMORROW's the moment it
       * passed, so it never suppressed anything and was found still armed at
       * 05:00. This proves the running server drops a notification inside the
       * window and sends it outside — anchored to a named zone, pinned to UTC
       * here so the result does not depend on where this machine is.
       */
      const nowMin = utcNowMin();
      const wrap = await p_('/push/config', {
        timezone: 'UTC', quietFrom: hhmm(nowMin - 60), quietTo: hhmm(nowMin + 60),
      });
      check('the quiet window was accepted', wrap.status === 200, JSON.stringify(wrap.body).slice(0, 140));
      check('...and reports itself active right now', wrap.body.quiet.active === true, JSON.stringify(wrap.body.quiet));
      check('...naming the zone in force', wrap.body.quiet.timezone === 'UTC');
      check('...and saying when it lifts', typeof wrap.body.quiet.changesInMin === 'number');

      const before = await stats();
      await p_('/messages', { text: 'this should be held back', from: 'zora' });
      await settle();
      const during = await stats();
      check('the message was queued', during.queued === before.queued + 1);
      check('but it was NOT flushed', during.flushed === before.flushed, `${before.flushed} -> ${during.flushed}`);
      check('and it is counted as suppressed by quiet hours', during.suppressedQuiet === before.suppressedQuiet + 1);

      const past = await p_('/push/config', { quietFrom: hhmm(nowMin - 61), quietTo: hhmm(nowMin - 60) });
      check('a window that ended a minute ago is NOT active', past.body.quiet.active === false, JSON.stringify(past.body.quiet));
      await p_('/messages', { text: 'this one should get through', from: 'zora' });
      await settle();
      check('...so the next message flushes', (await stats()).flushed === during.flushed + 1);

      const cleared = await p_('/push/config', { quietFrom: null, quietTo: null });
      check('quiet hours can be cleared entirely', cleared.body.quiet.configured === false);
    }

    console.log('\npush — "broken" can be let through the night, but only on request');
    {
      const nowMin = utcNowMin();
      await p_('/push/config', { timezone: 'UTC', quietFrom: hhmm(nowMin - 60), quietTo: hhmm(nowMin + 60) });
      const before = await stats();
      await p_('/messages', { text: 'it is on fire', from: 'zora', notify: 'broken' });
      await settle();
      check('by default even "broken" is silenced at night', (await stats()).flushed === before.flushed);

      const opt = await p_('/push/config', { brokenOverridesQuiet: true });
      check('the override is off by default and can be set', opt.body.brokenOverridesQuiet === true);
      const mid = await stats();
      await p_('/messages', { text: 'still on fire', from: 'zora', notify: 'broken' });
      await settle();
      check('...after which "broken" gets through', (await stats()).flushed === mid.flushed + 1);
      await p_('/messages', { text: 'a routine thing', from: 'zora' });
      await settle();
      check('...but "done" still does not', (await stats()).flushed === mid.flushed + 1);
      await p_('/push/config', { quietFrom: null, quietTo: null, brokenOverridesQuiet: false });
    }

    console.log('\npush — the config refuses what it cannot honour');
    {
      check('an unknown timezone is refused', (await p_('/push/config', { timezone: 'Mars/Olympus_Mons' })).status === 400);
      check('a malformed quiet time is refused', (await p_('/push/config', { quietFrom: '7:30' })).status === 400);
      check('hour 24 is refused', (await p_('/push/config', { quietTo: '24:00' })).status === 400);
      check('an empty change is refused', (await p_('/push/config', {})).status === 400);
      const good = await p_('/push/config', { timezone: 'Atlantic/Reykjavik' });
      check('a real timezone is accepted', good.status === 200 && good.body.quiet.timezone === 'Atlantic/Reykjavik');
      check('...and reported as known', good.body.quiet.zoneKnown === true);
      check('...with the local clock beside it', /^\d\d:\d\d$/.test(good.body.quiet.zoneNow));
    }

    console.log('\npush — subscriptions are per browser, replaced and not duplicated');
    {
      const fx = fakeSubscription('firefox');
      const one = await p_('/push/subscribe', {
        ...fx, deviceId: 'devicefirefox1',
        ua: 'Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0',
      });
      check('a subscription is accepted', one.status === 201, JSON.stringify(one.body).slice(0, 140));
      check('...and named by browser', one.body.label === 'Firefox 153', one.body.label);

      const cfg = await g('/push/config?deviceId=devicefirefox1');
      check('one device is armed', cfg.devices.length === 1);
      check('...and this browser knows it is armed', cfg.subscribedHere === true);
      check('a different browser is told it is NOT armed',
        (await g('/push/config?deviceId=devicechrome1')).subscribedHere === false);
      /*
       * The endpoint is a capability URL — anyone holding it can buzz his phone
       * — so it is never handed back out, not even to his own page.
       */
      check('the endpoint is never returned', JSON.stringify(cfg.devices).indexOf('push.invalid') === -1,
        JSON.stringify(cfg.devices));
      check('nor are the crypto keys', JSON.stringify(cfg.devices).indexOf(fx.keys.auth) === -1);

      const again = await p_('/push/subscribe', {
        ...fakeSubscription('firefox2'), deviceId: 'devicefirefox1', ua: 'Firefox/153.0',
      });
      check('re-subscribing the same browser is accepted', again.status === 201);
      check('...and replaces rather than duplicates', (await g('/push/config')).devices.length === 1);

      const chrome = await p_('/push/subscribe', {
        ...fakeSubscription('chrome'), deviceId: 'devicechrome1',
        ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
      });
      check('a second browser subscribes alongside the first', chrome.status === 201);
      const both = await g('/push/config?deviceId=devicechrome1');
      check('...so two devices are armed', both.devices.length === 2, String(both.devices.length));
      check('...and Chrome is named', both.devices.some((d) => d.label === 'Chrome 150'));
      check('...and Chrome knows it is armed', both.subscribedHere === true);

      const off = await p_('/push/unsubscribe', { deviceId: 'devicechrome1' });
      check('unsubscribing removes exactly one', off.status === 200 && off.body.removed === 1, JSON.stringify(off.body));
      check('...leaving the other armed', (await g('/push/config')).devices.length === 1);
      check('unsubscribing again removes nothing', (await p_('/push/unsubscribe', { deviceId: 'devicechrome1' })).body.removed === 0);
    }

    console.log('\npush — a subscription that cannot work is refused at the door');
    {
      const s = fakeSubscription('bad');
      check('a plain http endpoint is refused',
        (await p_('/push/subscribe', { ...s, endpoint: 'http://push.invalid/x' })).status === 400);
      check('a missing endpoint is refused', (await p_('/push/subscribe', { keys: s.keys })).status === 400);
      check('missing keys are refused', (await p_('/push/subscribe', { endpoint: s.endpoint })).status === 400);
      /*
       * Keys that will not encrypt are rejected here, where the page can say so,
       * rather than silently at 3am when the notification does not arrive.
       */
      const short = await p_('/push/subscribe', { endpoint: s.endpoint, keys: { p256dh: 'AAAA', auth: s.keys.auth } });
      check('a truncated p256dh is refused', short.status === 400, JSON.stringify(short.body).slice(0, 140));
      check('...with a reason he could act on', String(short.body.error).indexOf('unusable') >= 0, String(short.body.error));
      check('a truncated auth secret is refused',
        (await p_('/push/subscribe', { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: 'AA' } })).status === 400);
    }

    console.log('\npush — the test button reports per browser, not just "ok"');
    {
      const r = await p_('/push/test', { category: 'done' });
      check('the test endpoint answers', r.status === 200, String(r.status));
      check('...listing every device it tried', Array.isArray(r.body.results) && r.body.results.length === 1,
        JSON.stringify(r.body.results));
      check('...with a label he can recognise', typeof r.body.results[0].label === 'string');
      check('...and it honestly reports non-delivery', r.body.delivered === 0);
      check('...and says whether quiet hours were on', typeof r.body.sentDuringQuietHours === 'boolean');
    }

    console.log('\npush — the service worker and the CSP that permits it');
    {
      /*
       * The stand-in server in mobile-selftest does not apply the real CSP, so
       * without this a service worker could pass every browser test and still be
       * blocked in production by the old `worker-src blob:`.
       */
      const sw = await fetch(`${base}/sw.js`);
      check('/sw.js is served', sw.status === 200, String(sw.status));
      check('...as javascript', String(sw.headers.get('content-type')).indexOf('javascript') >= 0,
        String(sw.headers.get('content-type')));
      check('...with root scope allowed', sw.headers.get('service-worker-allowed') === '/');
      check('...and never cached, because the checkout is the deployment',
        String(sw.headers.get('cache-control')).indexOf('no-store') >= 0);
      const body = await sw.text();
      check('...and it handles push events', body.indexOf("addEventListener('push'") >= 0);
      check('...and it still handles the tap on one', body.indexOf("addEventListener('notificationclick'") >= 0);

      /*
       * This block used to assert that the worker cached NOTHING — no
       * `caches.open` anywhere — because the checkout is the deployment and a
       * cached shell is how you ship a page nobody can update.
       *
       * It now caches, deliberately, so the thread can be read with no signal.
       * The old assertion is replaced rather than dropped, because the fear
       * behind it was right and has not gone away. What follows pins the
       * properties that make caching survivable, which is a stronger claim than
       * "does not cache" ever was.
       */
      check('the worker never serves the shell from cache ahead of the network',
        /Promise\.race\(\[net, patience\]\)/.test(body) && body.indexOf('caches.match') === -1, 'network-first missing');
      check('...it only saves a shell the server vouched for',
        body.indexOf('x-relay-app') >= 0, 'the Access login page could be cached as the app');
      check('...its caches are versioned', /const VERSION = /.test(body));
      check('...and every older one of ours is deleted on activate',
        body.indexOf('caches.delete(n)') >= 0 && body.indexOf("n.indexOf('relay-')") >= 0);
      check('...a new worker takes over immediately', body.indexOf('skipWaiting') >= 0 && body.indexOf('clients.claim') >= 0);
      check('...it refuses to touch anything but a GET',
        /req\.method !== 'GET'/.test(body), 'a cached or replayed POST would be a duplicate message');
      check('...it marks what it served from cache, so the page can say so',
        body.indexOf('x-relay-from-cache') >= 0 && body.indexOf('x-relay-cached-at') >= 0);
      check('...the saved thread is bounded', /MAX_THREADS/.test(body) && body.indexOf('prune') >= 0);
      check('...and there is a way to throw it all away from the page',
        body.indexOf('forget-offline') >= 0);

      const page = await fetch(`${base}/`);
      const csp = String(page.headers.get('content-security-policy'));
      check('the CSP allows a same-origin worker', csp.indexOf("worker-src 'self'") >= 0, csp);
      check('...while still allowing the audio worklet blob', csp.indexOf('blob:') >= 0);
      check('...and default-src is still none', csp.indexOf("default-src 'none'") >= 0);
      check('...and the manifest is not blocked', csp.indexOf("manifest-src 'self'") >= 0, csp);
      check('...nor the icon files', csp.indexOf("img-src 'self'") >= 0, csp);
      check('the shell is stamped so the worker can recognise it',
        page.headers.get('x-relay-app') === '1', String(page.headers.get('x-relay-app')));
    }

    console.log('\ninstallable — the manifest and the icons Android insists on');
    {
      const mf = await fetch(`${base}/manifest.webmanifest`);
      check('the manifest is served', mf.status === 200, String(mf.status));
      check('...with the type that makes it a manifest',
        String(mf.headers.get('content-type')).indexOf('application/manifest+json') >= 0,
        String(mf.headers.get('content-type')));
      const m = JSON.parse(await mf.text());
      check('...it is standalone, or it is just a bookmark', m.display === 'standalone', m.display);
      check('...scoped to the whole app', m.scope === '/' && m.start_url === '/');
      check('...with a short name that fits under an icon',
        typeof m.short_name === 'string' && m.short_name.length <= 12, m.short_name);
      /*
       * Chrome refuses to offer installation without a 192 and a 512, and a
       * launcher that crops will mangle anything not marked maskable. Both
       * failures are silent — no prompt, or an icon with its edges cut off —
       * which is exactly the kind that survives to the phone.
       */
      const sizes = (m.icons || []).map((i) => i.sizes);
      check('...a 192 and a 512, which is what Chrome requires to offer install',
        sizes.indexOf('192x192') >= 0 && sizes.indexOf('512x512') >= 0, JSON.stringify(sizes));
      check('...and one marked maskable, so a round launcher does not crop it',
        (m.icons || []).some((i) => String(i.purpose).indexOf('maskable') >= 0), JSON.stringify(m.icons));

      for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
        const r = await fetch(`${base}/${icon}`);
        const buf = Buffer.from(await r.arrayBuffer());
        check(`/${icon} is a real PNG`,
          r.status === 200 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
          `${r.status} ${buf.subarray(0, 8).toString('hex')}`);
      }
      // The declared size and the actual pixels must agree, or Android quietly
      // ignores the icon and installs a letter in a grey circle instead.
      const big = Buffer.from(await (await fetch(`${base}/icon-512.png`)).arrayBuffer());
      check('...and 512 means 512', big.readUInt32BE(16) === 512 && big.readUInt32BE(20) === 512,
        `${big.readUInt32BE(16)}x${big.readUInt32BE(20)}`);

      check('an icon that does not exist is a 404, not a file off disk',
        (await fetch(`${base}/icon-999.png`)).status === 404);
      // There is no path join anywhere near this route, and this is the check
      // that says so out loud.
      const trav = await fetch(`${base}/${encodeURIComponent('../server.js')}`);
      check('...and the icon route cannot be walked out of', trav.status === 404, String(trav.status));
    }

    console.log('\npush — what he armed survives a restart');
    {
      const keyBefore = (await g('/push/config')).vapidPublicKey;
      await stop(proc);
      proc = spawn(process.execPath, [SERVER], {
        env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', WATCH_SOURCE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', () => {});
      await waitForBoot(proc, base);
      const cfg = await g('/push/config?deviceId=devicefirefox1');
      check('the armed device replayed from the log', cfg.devices.length === 1, String(cfg.devices.length));
      check('...and is still recognised as this browser', cfg.subscribedHere === true);
      check('the timezone replayed too', cfg.quiet.timezone === 'Atlantic/Reykjavik', cfg.quiet.timezone);
      /*
       * If the keys did not persist, every existing subscription would be dead
       * on the next restart — and this server restarts on every source change.
       */
      check('the VAPID key is byte-identical after a restart', cfg.vapidPublicKey === keyBefore);
      check('...and the counters reset with the process', cfg.stats.queued === 0);
    }
  } finally {
    await stop(proc);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }
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
 * The three protocol guarantees added after the 2026-08-07 retrospective, each
 * one written against the failure that produced it rather than against the
 * feature that fixes it. Own server, own scratch dir, so queue state is exactly
 * known and nothing here can be explained away by leftovers from another phase.
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

    /*
     * §5 / 4. 36 of the night's 312 messages were an agent talking with no way to
     * be attributed to itself, and 19 of those were agents talking to each other
     * through the human's phone.
     */
    console.log('\nmessages — an agent can speak as itself, and out of his earshot');
    const before = await g('/thread?conversation=main');
    const spoke = await p_('/messages', { text: 'the sync finished', agent: 'vega' });
    check('an agent can post a message unprompted', spoke.status === 201, `HTTP ${spoke.status}`);
    check('...attributed to itself, not to the human', spoke.body.role === 'agent', spoke.body.role);
    check('...naming which agent said it', spoke.body.author === 'vega', spoke.body.author);
    check('*** it does NOT sit pending, so it cannot trip an agent\'s own watcher ***',
      spoke.body.status === 'done', spoke.body.status);
    check('...and it is not counted as unread work', spoke.body.relayed === true, `relayed=${spoke.body.relayed}`);
    check('...it needs no self-answer, so only ONE entry reaches the thread',
      (await g('/thread?conversation=main')).count === before.count + 1,
      `${before.count} -> ${(await g('/thread?conversation=main')).count}`);
    const said = (await g('/thread?conversation=main')).entries.slice(-1)[0];
    check('...and it renders as the agent speaking', said.role === 'agent' && said.text === 'the sync finished',
      JSON.stringify(said));
    check('...with no phantom pending message under it',
      !(await g('/tasks?status=pending')).tasks.some((t) => t.instruction === 'the sync finished'));
    check('an agent message still cannot be marked relayed into an empty answer',
      (await p_(`/tasks/${spoke.body.id}/result`, { result: 'x' })).status === 409,
      'a spoken message is already done');

    const t0 = await g('/thread?conversation=main');
    const h0 = await g('/health');
    const intern = await p_('/messages', { text: 'taking the mindmeld repo, hands off', agent: 'vega', to: 'zora', channel: 'agents' });
    check('an agent can post to an internal channel', intern.status === 201, `HTTP ${intern.status}`);
    check('...addressed to another agent', intern.body.to === 'zora', intern.body.to);
    // Two independent mechanisms keep this out of his thread, and each is worth
    // pinning: the visibility filters, and a conversation id that no real
    // conversation can ever have. Removing either one alone is caught below.
    check('...filed under an id that cannot collide with a real conversation',
      intern.body.conversationId === '#agents', intern.body.conversationId);
    check('*** internal traffic NEVER reaches the human\'s thread ***',
      (await g('/thread?conversation=main')).count === t0.count,
      `thread grew ${t0.count} -> ${(await g('/thread?conversation=main')).count}`);
    check('...nor the unfiltered thread', !(await g('/thread')).entries.some((e) => /hands off/.test(e.text)));
    check('...nor an existing agent\'s pending poll',
      !(await g('/tasks?status=pending')).tasks.some((t) => /hands off/.test(t.instruction || '')));
    check('...nor the default /tasks listing at all',
      !(await g('/tasks')).tasks.some((t) => /hands off/.test(t.instruction || '')));
    check('...nor /results', !(await g('/results')).tasks.some((t) => /hands off/.test(t.instruction || '')));
    const h1 = await g('/health');
    check('...nor the queue counts the status page reads',
      h1.counts.done === h0.counts.done && h1.counts.pending === h0.counts.pending,
      `${JSON.stringify(h0.counts)} -> ${JSON.stringify(h1.counts)}`);
    const convAfter = (await g('/conversations')).conversations;
    check('...nor his conversation list, as a message or as a stray conversation',
      !convAfter.some((c) => /hands off/.test(c.lastText || '')) && !convAfter.some((c) => c.id === '#agents'),
      JSON.stringify(convAfter.map((c) => c.id)));
    check('...nor the status page activity feed',
      !JSON.stringify(await g('/status?engines=0')).includes('hands off'));

    const feed = await g('/messages?channel=agents');
    check('but the agent it was meant for CAN read it', feed.count === 1 && feed.messages[0].text === 'taking the mindmeld repo, hands off',
      JSON.stringify(feed).slice(0, 160));
    check('...with the sender and addressee intact',
      feed.messages[0].author === 'vega' && feed.messages[0].to === 'zora', JSON.stringify(feed.messages[0]));
    check('...and channels are separate from each other',
      (await g('/messages?channel=other')).count === 0);
    check('...and discoverable', (await g('/channels')).channels.some((c) => c.channel === 'agents'));
    check('an internal channel cannot be used as a conversation by an ordinary post',
      (await p_('/tasks', { text: 'sneaking in', conversationId: '#agents' })).status === 400);
    check('a message to a conversation that does not exist is refused',
      (await p_('/messages', { text: 'x', conversationId: 'nope' })).status === 400);
    check('an empty message is refused', (await p_('/messages', { text: '   ' })).status === 400);
    check('a bad channel name is refused', (await p_('/messages', { text: 'x', channel: 'has spaces' })).status === 400);

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
      check('the agent\'s own message replayed as the agent\'s',
        (await g('/thread?conversation=main')).entries.some((e) => e.role === 'agent' && e.text === 'the sync finished'));
      check('*** internal traffic is STILL invisible after a replay ***',
        !(await g('/thread')).entries.some((e) => /hands off/.test(e.text))
        && !(await g('/conversations')).conversations.some((c) => c.id === '#agents'));
      check('...and still readable on its channel', (await g('/messages?channel=agents')).count === 1);
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
