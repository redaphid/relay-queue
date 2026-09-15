'use strict';
/*
 * sse-pending-selftest - prove GET /events?pending=1 is a hard server-side
 * filter that suppresses frames for tasks which are no longer PENDING.
 *
 *   node tools/sse-pending-selftest.js
 *
 * WHY THIS EXISTS - the measurement, not a hunch.
 *
 * A scoped subscriber currently receives every mutation of every task in its
 * tab. Measured over the durable record (data/events.jsonl, 10,841 events,
 * 2,125 tasks): 5,703 task-patch broadcasts, i.e. 2.68 frames per task -
 * claim, then result, then relayed. A coordinator watching its own tab
 * therefore WAKES ON ITS OWN WRITES: it claims a task and the claim comes
 * straight back at it as a frame, then its own result does, then its own
 * relayed does.
 *
 * A wakeup is not cheap. It costs the woken agent a full re-read of its
 * entire context. Measured across today's 8 subagent transcripts (960 turns,
 * 88.4M context tokens): median 84,009 tokens per turn, p75 129,595, p90
 * 202,458. tools/events-selftest.js independently records ~100K per spurious
 * wakeup. So 1.68 avoidable frames per task, at ~84K tokens each, is the
 * single largest controllable waste in the watch path.
 *
 * `?pending=1` is opt-in and additive. Default behaviour is unchanged: a
 * stream that does not ask for it still gets every frame, so no existing
 * client or page changes. The filter is evaluated server-side at push time,
 * before the frame is written to the socket - so, exactly as with
 * ?conversation=, the subscriber structurally CANNOT receive the frame,
 * rather than receiving it and being trusted to drop it.
 *
 * Zero dependencies. Node built-ins only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startServer } = require('./harness-lib');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ssepending-'));
  const srv = await startServer({ dir, label: 'sse-pending' });
  const base = srv.base;
  const api = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  const inflight = [];
  function listen(query) {
    const frames = [];
    const req = http.request(`${base}/events${query || ''}`, { headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue; // ": connected", "retry:", ": ping" are protocol, not events
          try { frames.push(JSON.parse(line.slice(6))); } catch { /* not JSON, ignore */ }
        }
      });
    });
    req.on('error', () => {});
    req.end();
    inflight.push(req);
    return frames;
  }

  try {
    await fn({ api, listen });
  } catch (err) {
    process.stderr.write(`\n[server output]\n${srv.out}\n`);
    throw err;
  } finally {
    for (const req of inflight) req.destroy();
    await srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the log */ }
  }
}

// A task frame carries `entries`; pick out the status the frame reports.
const taskFrames = (frames, taskId) => frames.filter(
  (f) => Array.isArray(f.entries) && f.entries.some((e) => e && e.id === taskId),
);
const statusOf = (frame, taskId) => {
  const e = frame.entries.find((x) => x && x.id === taskId);
  return e ? e.status : null;
};

async function main() {
  await withServer(async (s) => {
    console.log('\none conversation, two scoped streams: plain, and ?pending=1');
    const conv = await s.api('POST', '/conversations', { title: 'sse pending selftest' });
    check('conversation created', !!conv.id, JSON.stringify(conv));

    // Both connect BEFORE anything is posted, so neither can win on timing.
    const plain = s.listen(`?conversation=${conv.id}`);
    const pendingOnly = s.listen(`?conversation=${conv.id}&pending=1`);
    await sleep(300);

    console.log('\nfull task lifecycle: create -> claim -> result -> relayed');
    const task = await s.api('POST', '/tasks', { conversationId: conv.id, text: 'do a thing', from: 'test' });
    check('task created', !!task.id, JSON.stringify(task));
    await sleep(200);
    await s.api('POST', `/tasks/${task.id}/claim`, { by: 'Watcher' });
    await sleep(200);
    await s.api('POST', `/tasks/${task.id}/result`, { result: 'done the thing', by: 'Watcher' });
    await sleep(200);
    await s.api('POST', `/tasks/${task.id}/relayed`, { by: 'Watcher' });
    await sleep(400);

    const plainT = taskFrames(plain, task.id);
    const pendT = taskFrames(pendingOnly, task.id);

    console.log(`\n  [measured] plain stream frames for this one task: ${plainT.length} (${plainT.map((f) => statusOf(f, task.id)).join(', ')})`);
    console.log(`  [measured] ?pending=1 stream frames for the same task: ${pendT.length} (${pendT.map((f) => statusOf(f, task.id)).join(', ')})`);

    // ---- the unchanged default -------------------------------------------
    check('DEFAULT UNCHANGED: a plain scoped stream still gets the whole lifecycle (>=3 frames)',
      plainT.length >= 3, `${plainT.length} frame(s): ${JSON.stringify(plainT.map((f) => statusOf(f, task.id)))}`);
    check('DEFAULT UNCHANGED: the plain stream saw a non-pending frame (claim/result/relayed echo)',
      plainT.some((f) => statusOf(f, task.id) !== 'pending'),
      JSON.stringify(plainT.map((f) => statusOf(f, task.id))));

    // ---- the actual regression test ---------------------------------------
    check('?pending=1 received the task while it was PENDING (real work is never hidden)',
      pendT.some((f) => statusOf(f, task.id) === 'pending'),
      JSON.stringify(pendT.map((f) => statusOf(f, task.id))));
    check('?pending=1 received NO claim/result/relayed echo - the whole point',
      pendT.every((f) => statusOf(f, task.id) === 'pending'),
      `leaked: ${JSON.stringify(pendT.map((f) => statusOf(f, task.id)))}`);
    check('?pending=1 is strictly quieter than the plain stream on the same events',
      pendT.length < plainT.length, `pending=${pendT.length} plain=${plainT.length}`);

    // ---- a second task proves it is not a one-off -------------------------
    console.log('\na second task, answered by a DIFFERENT agent (the stale-frame case)');
    const t2 = await s.api('POST', '/tasks', { conversationId: conv.id, text: 'second thing', from: 'test' });
    await sleep(200);
    await s.api('POST', `/tasks/${t2.id}/claim`, { by: 'SomeoneElse' });
    await s.api('POST', `/tasks/${t2.id}/result`, { result: 'answered by another agent', by: 'SomeoneElse' });
    await sleep(400);
    const p2 = taskFrames(pendingOnly, t2.id);
    const pl2 = taskFrames(plain, t2.id);
    console.log(`  [measured] second task - plain: ${pl2.length}, ?pending=1: ${p2.length}`);
    check('?pending=1 suppressed the other agent\'s claim+result on the second task too',
      p2.every((f) => statusOf(f, t2.id) === 'pending'),
      `leaked: ${JSON.stringify(p2.map((f) => statusOf(f, t2.id)))}`);

    // ---- conversation patches must still arrive ---------------------------
    console.log('\nconversation patches are NOT task frames and must still arrive');
    await s.api('POST', `/conversations/${conv.id}`, { agent: 'Watcher' });
    await sleep(300);
    check('?pending=1 still receives conversation patches (seat changes stay visible)',
      pendingOnly.some((f) => f.conversation && f.conversation.id === conv.id),
      JSON.stringify(pendingOnly.filter((f) => f.conversation)));

    // ---- the saving, stated in the test output ----------------------------
    const totalPlain = plainT.length + pl2.length;
    const totalPend = pendT.length + p2.length;
    const saved = totalPlain - totalPend;
    console.log(`\n  [saving] ${totalPlain} wakeups -> ${totalPend} across 2 tasks: ${saved} avoided (${Math.round(100 * saved / totalPlain)}%)`);
    console.log(`  [saving] at the measured median 84,009 tok/turn that is ~${(saved * 84009).toLocaleString()} tokens for these 2 tasks alone`);
    check('at least half the wakeups were avoided', saved >= totalPlain / 2, `${saved}/${totalPlain}`);
  });

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL -', err); process.exit(1); });
