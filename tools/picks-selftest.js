'use strict';
/*
 * picks-selftest — prove that choosing a picture is real, readable and safe.
 *
 *   node tools/picks-selftest.js
 *
 * The request was "I can select an image and Claude can see it — like the
 * checkboxes in lists". Everything load-bearing in that sentence is a server
 * property, and each one has a way of quietly not being true:
 *
 *   1. IT SURVIVES. A choice is an event in the append-only log, so it comes
 *      back after a restart. A picker that forgets is worse than no picker,
 *      because he will decide once and then be asked again.
 *   2. AN AGENT LEARNS *WHICH*. The answer must name the picture by its LABEL.
 *      `selected: 2` is not an answer; `selected: ["p2-1005"]` is. This is the
 *      whole reason the feature exists — he is trying to stop typing seed ids.
 *   3. "HE HASN'T CHOSEN" IS NOT "HE CHOSE NOTHING". `source` and `decided`
 *      keep those apart. Confusing them means acting on a decision he never
 *      made, which is the single most expensive mistake available here.
 *   4. SINGLE-SELECT IS ENFORCED SERVER-SIDE, so his phone, his laptop and an
 *      agent cannot end up disagreeing about which one he picked.
 *
 * Nothing here touches the real data directory. Zero dependencies.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer } = require('./harness-lib');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${String(detail).slice(0, 300)}`);
}

// A minimal valid PNG, so the test depends on no fixture files.
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
const crc = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, r, g, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) { raw[p++] = r; raw[p++] = g; raw[p++] = b; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-picks-'));
  const srv = await startServer({ dir, env: { CHECK_SETTLE_MS: '400' } });
  const api = (p, opts) => fetch(srv.base + p, opts);
  const json = async (p, opts) => (await api(p, opts)).json();
  const post = (p, body) => json(p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    const conv = await post('/conversations', { title: 'Seeds', agent: 'propart' });

    // Three candidates, each uploaded WITH its label as the alt.
    const labels = ['p2-1001', 'p2-1002', 'p2-1005'];
    const blobs = [];
    for (let i = 0; i < labels.length; i++) {
      const r = await json(`/images?conversationId=${conv.id}&alt=${labels[i]}`, {
        method: 'POST', headers: { 'content-type': 'image/png' }, body: png(8, 8, 40 * i, 90, 200 - 40 * i),
      });
      blobs.push(r.image.blob);
    }

    console.log('\noffering a choice');
    const one = await post('/messages', {
      conversationId: conv.id, agent: 'propart', text: 'Pick a seed.', images: blobs, select: 'one',
    });
    let pl = await json(`/tasks/${one.id}/picks`);
    check('an agent can declare single-select', pl.mode === 'one', pl.mode);
    check('every picture carries its label, not just an index',
      JSON.stringify(pl.items.map((i) => i.label)) === JSON.stringify(labels),
      JSON.stringify(pl.items.map((i) => i.label)));
    check('nothing is chosen until he acts', pl.picked === 0 && pl.decided === false,
      JSON.stringify({ picked: pl.picked, decided: pl.decided }));
    check('...and every item reads as "declared", not "picked"',
      pl.items.every((i) => i.source === 'declared'), JSON.stringify(pl.items.map((i) => i.source)));

    console.log('\ndefaults, so a forgotten `select` still leaves him able to choose');
    const bare = await post('/messages', { conversationId: conv.id, agent: 'propart', text: 'two', images: blobs.slice(0, 2) });
    check('two or more pictures are selectable by default', (await json(`/tasks/${bare.id}/picks`)).mode === 'many');
    const lone = await post('/messages', { conversationId: conv.id, agent: 'propart', text: 'one', images: [blobs[0]] });
    const loneRes = await api(`/tasks/${lone.id}/picks`);
    check('...but a lone screenshot is not', loneRes.status === 404, String(loneRes.status));
    const off = await post('/messages', { conversationId: conv.id, agent: 'propart', text: 'off', images: blobs, select: 'none' });
    check('...and select:"none" opts out', (await api(`/tasks/${off.id}/picks`)).status === 404);

    console.log('\nhe chooses');
    const r1 = await post(`/tasks/${one.id}/picks`, { index: 2, on: true, by: 'phone' });
    check('the write is accepted', r1.changed === true, JSON.stringify(r1).slice(0, 120));
    pl = await json(`/tasks/${one.id}/picks`);
    check('the answer names it BY LABEL',
      pl.selected.length === 1 && pl.selected[0].label === 'p2-1005', JSON.stringify(pl.selected));
    check('...marked as HIS decision', pl.items[2].source === 'picked', pl.items[2].source);
    check('...and decided is now true', pl.decided === true);
    check('...recording who and when', pl.items[2].by === 'phone' && !!pl.items[2].at,
      JSON.stringify({ by: pl.items[2].by, at: pl.items[2].at }));

    console.log('\nsingle-select is exclusive, and the SERVER is what enforces it');
    await post(`/tasks/${one.id}/picks`, { index: 0, on: true, by: 'phone' });
    pl = await json(`/tasks/${one.id}/picks`);
    check('choosing another replaces the first', pl.picked === 1, JSON.stringify(pl.selected));
    check('...and it is the new one', pl.selected[0].label === 'p2-1001', JSON.stringify(pl.selected));

    console.log('\nmulti-select accumulates instead');
    await post(`/tasks/${bare.id}/picks`, { index: 0, on: true });
    await post(`/tasks/${bare.id}/picks`, { index: 1, on: true });
    const mp = await json(`/tasks/${bare.id}/picks`);
    check('both stay chosen', mp.picked === 2, JSON.stringify(mp.selected.map((s) => s.label)));

    console.log('\nrefusals that would otherwise corrupt a choice silently');
    check('an out-of-range index is refused',
      (await api(`/tasks/${one.id}/picks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 99, on: true }),
      })).status === 400);
    check('a missing `on` is refused',
      (await api(`/tasks/${one.id}/picks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }),
      })).status === 400);
    check('an unknown entry is a 404, not a silent no-op',
      (await api('/tasks/nope-nope/picks')).status === 404);
    check('an invalid select value is refused',
      (await api('/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conv.id, agent: 'x', text: 'y', images: blobs, select: 'sometimes' }),
      })).status === 400);
    const again = await post(`/tasks/${one.id}/picks`, { index: 0, on: true });
    check('re-sending the same choice is a no-op, not a toggle', again.changed === false,
      JSON.stringify(again).slice(0, 120));

    console.log('\nthe two halves that tell an agent');
    await new Promise((r) => setTimeout(r, 900)); // past CHECK_SETTLE_MS
    const pend = await json(`/tasks?status=pending&conversationId=${conv.id}`);
    const wake = pend.tasks.filter((t) => t.from === 'picks');
    check('a PENDING task appears in the conversation — the half that wakes a coordinator',
      wake.length >= 1, JSON.stringify(pend.tasks.map((t) => t.from)));
    check('...attributed to him, because he really did it', wake[0] && wake[0].role === 'user', wake[0] && wake[0].role);
    check('...naming the picture by label', wake[0] && /p2-1001/.test(wake[0].instruction), wake[0] && wake[0].instruction);
    const chan = await json('/messages?channel=picks');
    check('a picks channel message is written too', chan.count >= 1, String(chan.count));
    check('...and it stays OUT of his thread',
      !(await json(`/thread?conversation=${conv.id}`)).entries.some((e) => /Images .* chosen/.test(String(e.text))
        && e.role === 'agent'),
      'the channel copy must never appear in the human thread');

    console.log('\na burst settles into ONE message, never one per tap');
    const before = (await json('/messages?channel=picks')).count;
    for (let i = 0; i < 6; i++) await post(`/tasks/${bare.id}/picks`, { index: i % 2, on: i % 2 === 0 });
    await new Promise((r) => setTimeout(r, 900));
    const added = (await json('/messages?channel=picks')).count - before;
    check('six taps produced exactly one notification', added === 1, `added ${added}`);

    console.log('\nit survives a restart, which is the whole point of the event log');
    const chosen = (await json(`/tasks/${one.id}/picks`)).selected[0].label;
    await srv.restart();
    const afterBoot = await json(`/tasks/${one.id}/picks`);
    check('the choice is still there', afterBoot.selected.length === 1, JSON.stringify(afterBoot.selected));
    check('...and is still the same picture', afterBoot.selected[0].label === chosen,
      `${chosen} -> ${afterBoot.selected[0] && afterBoot.selected[0].label}`);
    check('...still attributed to him', afterBoot.items.some((i) => i.source === 'picked'));
    check('the server booted clean', /events replayed/.test(srv.out), srv.out.split('\n').find((l) => /replayed/.test(l)));
    check('...with nothing skipped', /0 skipped/.test(srv.out), srv.out.split('\n').find((l) => /replayed/.test(l)));

    console.log('\nasking across the whole queue');
    const all = await json(`/picks?conversation=${conv.id}`);
    check('/picks lists every selectable set', all.count >= 2, String(all.count));
    const undecided = await json('/picks?undecided=1');
    check('...and can filter to the ones still waiting on him',
      undecided.picks.every((p) => p.decided === false), JSON.stringify(undecided.picks.map((p) => p.decided)));
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
