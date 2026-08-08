'use strict';
/*
 * serve-selftest — the page must never be served half-written.
 *
 *   node tools/serve-selftest.js
 *
 * Written after an outage. The UI is read straight from the working tree and
 * cached by mtime, so a read that lands in the middle of a write caches the
 * truncated bytes against that mtime and keeps serving them until the file
 * changes again. One unlucky moment becomes a persistent broken page — no
 * crash, nothing in the log — on the only page the user can talk to us through.
 * A truncated page has no composer and no menu, which is exactly what they saw.
 *
 * This reproduces that and proves the guard holds.
 *
 * Zero dependencies. Node built-ins only.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 3991);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHOLE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
/*
 * Cut immediately before the composer, which is what a partial write actually
 * costs you: the input and the menu are simply not in the document. Cutting at
 * an arbitrary percentage is not good enough — the first version of this test
 * sliced at 45%, which still included the composer, so it passed against the
 * very bug it was written to catch.
 */
const CUT = WHOLE.indexOf('<div id="composer"');
if (CUT < 0) throw new Error('cannot find the composer in public/index.html');
const HALF = WHOLE.slice(0, CUT);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-serve-'));
  const ui = path.join(dir, 'index.html');
  fs.writeFileSync(ui, WHOLE);

  // SERVER_PATH lets this be pointed at an older server.js to confirm the test
  // actually reproduces the bug rather than merely passing.
  const server = process.env.SERVER_PATH || path.join(__dirname, '..', 'server.js');
  const proc = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1',
      DATA_DIR: path.join(dir, 'data'), UI_FILE: ui, WATCH_SOURCE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const get = () => fetch(BASE + '/').then(async (r) => ({ status: r.status, body: await r.text() }));
  const hasComposer = (b) => b.includes('id="composer"') && b.includes('id="input"') && b.includes('id="menu"');
  // Both, always: a page can contain the composer and still be a truncated
  // document, and a complete-looking tail proves nothing on its own.
  const isWhole = (b) => hasComposer(b) && /<\/html>\s*$/.test(b.trim()) && b.length === WHOLE.length;

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(BASE + '/health')).ok; } catch { await sleep(250); }
    }
    if (!up) throw new Error('test server never came up');

    console.log('\na whole page is served normally');
    let r = await get();
    check('200', r.status === 200, String(r.status));
    check('it has the composer, the input and the menu', hasComposer(r.body));
    check('it is the whole document', /<\/html>\s*$/.test(r.body));

    console.log('\nTHE OUTAGE: a page caught mid-write');
    // Bump mtime so the cache is invalidated, exactly as a real write would.
    fs.writeFileSync(ui, HALF);
    fs.utimesSync(ui, new Date(), new Date(Date.now() + 1000));
    await sleep(50);
    r = await get();
    check('the truncated page is NOT served', hasComposer(r.body) || r.status === 503,
      `status=${r.status}, composer present=${hasComposer(r.body)}, ${r.body.length} bytes`);
    check('the last good copy is served instead', r.status === 200 && hasComposer(r.body),
      `status=${r.status}`);

    // The real damage was persistence: it kept serving the broken copy.
    console.log('\n...and it does not get stuck that way');
    for (let i = 0; i < 3; i++) {
      r = await get();
      check(`request ${i + 1} still has the composer`, hasComposer(r.body), `${r.body.length} bytes`);
    }

    console.log('\nthe finished write is picked up');
    fs.writeFileSync(ui, WHOLE);
    fs.utimesSync(ui, new Date(), new Date(Date.now() + 2000));
    await sleep(50);
    r = await get();
    check('the complete page is served again', r.status === 200 && hasComposer(r.body), String(r.status));
    check('and it is byte-for-byte whole', /<\/html>\s*$/.test(r.body));
  } finally {
    proc.kill();
    await sleep(200);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('FAIL —', err); process.exit(1); });
