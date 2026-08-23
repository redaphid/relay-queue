'use strict';
/*
 * events-selftest — prove GET /events?conversation=<id> is a hard server-side
 * filter, not a client-side convention an agent has to remember to apply.
 *
 *   node tools/events-selftest.js
 *
 * The bug this guards against: a Monitor watching the unfiltered firehose
 * wakes on every event system-wide, at real cost (measured: ~100K tokens per
 * spurious wakeup) even though the client immediately discards anything not
 * its own. Filtering client-side after the frame already arrived is
 * discipline, not a guarantee. The only way to prove the guarantee holds is
 * to stand up two real conversations, post to both in the same window, and
 * show a stream scoped to one of them never even received the other's frame
 * — not "received it and dropped it", genuinely never sent.
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
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-events-'));
  const srv = await startServer({ dir, label: 'events' });
  const base = srv.base;
  const api = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  const inflight = [];
  /**
   * Opens GET /events (optionally with a query string like
   * "?conversation=<id>") and hands back a live array that every parsed
   * `data:` frame gets pushed onto, in order, for the life of the test.
   */
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

async function main() {
  await withServer(async (s) => {
    console.log('\ntwo real conversations, one scoped stream each, plus the firehose');
    const convA = await s.api('POST', '/conversations', { title: 'selftest conv A' });
    const convB = await s.api('POST', '/conversations', { title: 'selftest conv B' });
    check('conversation A created', !!convA.id, JSON.stringify(convA));
    check('conversation B created', !!convB.id, JSON.stringify(convB));

    // Connect all three before anything is posted, so nobody can win by timing.
    const firehose = s.listen('');
    const scopedA = s.listen(`?conversation=${convA.id}`);
    const scopedB = s.listen(`?conversation=${convB.id}`);
    await sleep(300); // let all three connections actually establish

    check('the firehose got its initial watch snapshot on connect',
      firehose.some((f) => f.watch), `${firehose.length} frame(s)`);
    check('a scoped stream does NOT get the initial watch snapshot (it belongs to no single conversation)',
      scopedA.every((f) => !f.watch), JSON.stringify(scopedA));

    console.log('\nposting a task to each conversation in the same window');
    const taskA = await s.api('POST', '/tasks', { conversationId: convA.id, text: 'hello A', from: 'test' });
    const taskB = await s.api('POST', '/tasks', { conversationId: convB.id, text: 'hello B', from: 'test' });
    check('task A created', !!taskA.id, JSON.stringify(taskA));
    check('task B created', !!taskB.id, JSON.stringify(taskB));
    await sleep(300);

    check("scoped-to-A stream received A's task",
      scopedA.some((f) => f.conversationId === convA.id), JSON.stringify(scopedA));
    check("scoped-to-A stream did NOT receive B's task — the actual regression test",
      scopedA.every((f) => f.conversationId !== convB.id), JSON.stringify(scopedA));
    check("scoped-to-B stream received B's task",
      scopedB.some((f) => f.conversationId === convB.id), JSON.stringify(scopedB));
    check("scoped-to-B stream did NOT receive A's task",
      scopedB.every((f) => f.conversationId !== convA.id), JSON.stringify(scopedB));
    check('the firehose received BOTH — unfiltered mode is unchanged',
      firehose.some((f) => f.conversationId === convA.id) && firehose.some((f) => f.conversationId === convB.id),
      JSON.stringify(firehose));

    console.log('\na conversation patch is scoped the same way as a task broadcast');
    await s.api('POST', `/conversations/${convA.id}`, { agent: 'someone' });
    await s.api('POST', `/conversations/${convB.id}`, { agent: 'someone-else' });
    await sleep(300);

    check('scoped-to-A stream saw its own conversation patch',
      scopedA.some((f) => f.conversation && f.conversation.id === convA.id), JSON.stringify(scopedA));
    check("scoped-to-A stream did NOT see B's conversation patch",
      scopedA.every((f) => !(f.conversation && f.conversation.id === convB.id)), JSON.stringify(scopedA));

    console.log('\nevery frame a scoped stream ever received belongs to it, start to finish');
    const belongsToA = (f) => f.conversationId === convA.id || (f.conversation && f.conversation.id === convA.id);
    check('scoped-to-A saw nothing that was not its own',
      scopedA.every(belongsToA), JSON.stringify(scopedA));
  });

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
