'use strict';
/*
 * watch-selftest — prove the deadman fires, clears, and stays quiet.
 *
 *   node tools/watch-selftest.js
 *
 * Spawns throwaway servers on their own ports and data directories, with the
 * thresholds turned down to seconds, and drives them through the states that
 * matter. It never touches the real queue.
 *
 * The cases that earn their keep are the negative ones. A banner that also
 * lights up when the queue is merely idle — or every time the server restarts,
 * which it does on every source change — is worse than no banner at all: the
 * user learns to ignore it and the whole feature becomes decoration.
 *
 * Zero dependencies. Node built-ins only.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const SERVER = path.join(__dirname, '..', 'server.js');
let nextPort = Number(process.env.TEST_PORT || 3987);

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawns a server, waits for it, hands you a client, then always cleans up. */
async function withServer(env, fn) {
  const port = nextPort++;
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-watch-'));
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      WATCH_SOURCE: '0', // never self-restart mid-test
      WATCH_TICK_MS: '400', // the deadman's clock, sped up so a stall is observable
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const api = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  const pushed = [];
  let stream = null;
  /** Reads the SSE stream so we can prove the verdict is PUSHED, not just polled. */
  function listen() {
    const req = http.request(`${base}/events`, { headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const j = JSON.parse(line.slice(6));
            if (j && j.watch) pushed.push(j.watch);
          } catch { /* not a watch frame */ }
        }
      });
    });
    req.on('error', () => {});
    req.end();
    stream = req;
  }

  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(base + '/health')).ok; } catch { await sleep(250); }
    }
    if (!up) throw new Error('test server never came up');
    await fn({ api, watch: () => api('GET', '/watch'), listen, pushed });
  } finally {
    if (stream) stream.destroy();
    proc.kill();
    await sleep(200);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the log */ }
  }
}

async function main() {
  const GRACE = 1500;
  const ALARM = 3000;
  const fast = { WAITING_GRACE_MS: String(GRACE), WAITING_ALARM_MS: String(ALARM), STARTUP_GRACE_MS: '600' };

  // ---------------------------------------------------------------- idle
  await withServer(fast, async (s) => {
    console.log('\nan empty queue is idle, never broken');
    let w = await s.watch();
    check('empty queue is not bad', w.bad === false, JSON.stringify(w));
    check('empty queue reads as idle', w.level === 'idle', w.level);
    // The whole point: long past the alarm threshold with NOTHING pending must
    // still be quiet. Silence with no work is health, not failure.
    await sleep(ALARM + 700);
    w = await s.watch();
    check('still not bad long after the alarm threshold', w.bad === false, JSON.stringify(w));
    check('still idle, not warn/alarm', w.level === 'idle', w.level);

    s.listen();
    await sleep(300);
    check('a connecting page is told the current state at once', s.pushed.length >= 1,
      `${s.pushed.length} frames`);

    console.log('\nwork arrives and goes unanswered');
    const t = await s.api('POST', '/tasks', { text: 'selftest: is anyone there?', from: 'test' });
    check('task created', !!t.id, JSON.stringify(t));
    w = await s.watch();
    check('fresh work is not an alarm (inside the grace window)', w.bad === false, JSON.stringify(w));

    await sleep(GRACE + 600);
    w = await s.watch();
    check('stalled work becomes bad', w.bad === true, JSON.stringify(w));
    check('it names the waiting work', /waiting/.test(w.text), w.text);
    check('it says how long', /for \d/.test(w.text), w.text);

    await sleep(ALARM - GRACE + 700);
    w = await s.watch();
    check('it escalates to alarm', w.level === 'alarm', `${w.level} — ${w.text}`);
    // Nothing mutated during the stall, so only the timer could have sent these.
    check('the bad state was PUSHED with no mutation to trigger it',
      s.pushed.some((p) => p.bad === true), `${s.pushed.length} frames`);

    console.log('\na heartbeat alone must not clear it');
    await s.api('POST', '/heartbeat', { agent: 'liar', note: 'still here' });
    await sleep(250);
    w = await s.watch();
    check('heartbeat does not count as acting', w.bad === true, JSON.stringify(w));
    check('it calls the beating-but-idle agent stuck', /stuck|checking in/.test(w.text), w.text);

    console.log('\nan agent acts and it clears itself');
    const pending = await s.api('GET', '/tasks?status=pending&limit=1');
    const before = s.pushed.length;
    await s.api('POST', `/tasks/${pending.tasks[0].id}/result`, { result: 'selftest: yes, here.' });
    await sleep(400);
    w = await s.watch();
    check('acting clears the bad state', w.bad === false, JSON.stringify(w));
    check('recovery was pushed at once, not on the next tick',
      s.pushed.length > before && s.pushed[s.pushed.length - 1].bad === false,
      `before=${before} after=${s.pushed.length}`);

    await sleep(ALARM + 700);
    w = await s.watch();
    check('a drained queue stays quiet forever', w.bad === false, JSON.stringify(w));
  });

  // ---------------------------------------------------------------- fresh boot
  /*
   * Heartbeats are in-memory, so a restart wipes the roster — and this server
   * restarts itself whenever server.js changes. Without this suppression the
   * banner would fire every time the developer saved a file.
   */
  await withServer({ ...fast, STARTUP_GRACE_MS: '60000' }, async (s) => {
    console.log('\na fresh boot does not cry wolf');
    await s.api('POST', '/tasks', { text: 'selftest: stranded at boot', from: 'test' });
    await sleep(GRACE + 900);
    const w = await s.watch();
    check('the underlying verdict is still honest', w.level === 'warn' || w.level === 'alarm', w.level);
    check('but the banner is suppressed while starting up', w.bad === false, JSON.stringify(w));
    check('and it says why', w.starting === true, JSON.stringify(w.starting));
  });

  // ---------------------------------------------------------------- orphans
  await withServer({ ...fast, STUCK_CLAIM_MS: '1500', STUCK_ALARM_MS: '4000' }, async (s) => {
    console.log('\na claim nobody ever answered');
    const t = await s.api('POST', '/tasks', { text: 'selftest: claim and vanish', from: 'test' });
    await s.api('POST', `/tasks/${t.id}/claim`, { by: 'ghost' });

    let w = await s.watch();
    check('a fresh claim is not stuck', w.stuckCount === 0, JSON.stringify(w.stuck));

    await sleep(1900);
    w = await s.watch();
    check('an old claim is stuck', w.stuckCount === 1, JSON.stringify(w.stuck));
    check('the banner says it was claimed and never answered',
      /claimed but never answered/.test(w.text), w.text);
    check('it names who took it', /ghost/.test(w.text), w.text);
    check('it says nothing will retry it', /pick it up again/.test(w.text), w.text);
    check('it is bad', w.bad === true, JSON.stringify(w));

    /*
     * THE REGRESSION THAT MATTERS. Another agent working normally makes the
     * general staleness check look perfectly healthy. The orphan must still be
     * reported — being hidden behind someone else's activity is precisely how it
     * stayed invisible for three hours in production.
     */
    const t2 = await s.api('POST', '/tasks', { text: 'selftest: a busy agent elsewhere', from: 'test' });
    await s.api('POST', `/tasks/${t2.id}/result`, { result: 'selftest: answered instantly' });
    await sleep(300);
    w = await s.watch();
    check('recent activity elsewhere does NOT hide the orphan', w.bad === true, JSON.stringify(w));
    check('...and it is still the orphan being reported',
      /claimed but never answered/.test(w.text), w.text);

    await sleep(2400);
    w = await s.watch();
    check('a long-abandoned claim escalates to alarm', w.level === 'alarm', `${w.level} — ${w.text}`);

    await s.api('POST', `/tasks/${t.id}/result`, { result: 'selftest: finally answered' });
    await sleep(300);
    w = await s.watch();
    check('answering it clears the alarm', w.bad === false, JSON.stringify(w));
    check('and it is no longer listed as stuck', w.stuckCount === 0, JSON.stringify(w.stuck));
  });

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
